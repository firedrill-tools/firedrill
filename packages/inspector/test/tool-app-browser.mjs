// Run after building the inspector: node packages/inspector/test/tool-app-browser.mjs
// Uses the optional browser-tests package's installed Chromium; no remote service or production data.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "@firedrill/sdk";
import { startLocalInspector } from "../dist/index.js";

const browserRequire = createRequire(import.meta.resolve("@firedrill/browser-tests"));
const { chromium } = browserRequire("playwright");
const root = mkdtempSync(join(tmpdir(), "firedrill-inspector-app-browser-"));
const captures = mkdtempSync(join(tmpdir(), "firedrill-inspector-app-captures-"));
const json = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
mkdirSync(join(root, "world", "ui"), { recursive: true });
json("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
json("world/world.json", {
  schemaVersion: 1,
  id: "counter-workspace",
  seed: "1",
  actors: [{ id: "operator", grants: [{ packageId: "counter", operationId: "set" }] }],
});
for (const id of ["counter", "backend-only"]) {
  json(`world/${id}.tool.json`, {
    schemaVersion: 1,
    module: `./${id}.js`,
    ...(id === "counter" ? { ui: { root: "ui" } } : {}),
    manifest: {
      schemaVersion: 1,
      id,
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "records", schema: { type: "object" } }],
      operations: [
        {
          id: "set",
          description: "Record a count in this local world.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
    },
  });
  writeFileSync(
    join(root, `world/${id}.js`),
    'export default {operations:{set(input,context){context.state.put("records","current",input);return input;}}};',
  );
}
writeFileSync(
  join(root, "world/ui/index.html"),
  '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Counter app</title><h1>Counter app</h1><button>Record count</button><output>Ready</output><script type="module" src="./app.js"></script></html>',
);
writeFileSync(
  join(root, "world/ui/app.js"),
  'import {invoke} from "/_firedrill/client.js"; document.querySelector("button").onclick=async()=>{const result=await invoke("set",{count:8});document.querySelector("output").textContent=result.outcome.status;};',
);

let world;
let binding;
let server;
let browser;
try {
  world = await createLocalWorld({ root });
  binding = await world.listen({ protocols: ["http"] });
  server = await startLocalInspector({ root, environment: { world, binding } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${server.url}/tools`);
  const appButton = () => page.getByRole("button", { name: "Open app for counter", exact: true });
  await appButton().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator("button button").count(), 0);
  assert.equal(await page.getByRole("button", { name: /Open app for/ }).count(), 1);
  const inspectorToken = await page.locator('meta[name="firedrill-token"]').getAttribute("content");
  assert.ok(inspectorToken);
  const status = await (
    await page.request.get(`${server.url}/api/environment`, {
      headers: { authorization: `Bearer ${inspectorToken}` },
    })
  ).json();
  assert.equal(status.apps.length, 1);
  assert.equal(new URL(status.apps[0].url).hash, "");
  const scopedToken = new URLSearchParams(new URL(binding.apps[0].url).hash.slice(1)).get("token");
  assert.ok(scopedToken);
  assert.ok(!JSON.stringify(status).includes(scopedToken));
  await page.screenshot({
    path: join(captures, "desktop-directory.png"),
    fullPage: true,
    animations: "disabled",
  });
  const popupPromise = page.waitForEvent("popup");
  await appButton().click();
  const popup = await popupPromise;
  await popup.getByRole("heading", { name: "Counter app" }).waitFor();
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(new URL(popup.url()).hash, "");
  assert.notEqual(new URL(popup.url()).origin, new URL(page.url()).origin);
  await popup.getByRole("button", { name: "Record count" }).click();
  await popup.getByText("ok", { exact: true }).waitFor();
  assert.equal(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count, 8);
  await popup.close();
  await page.getByRole("button", { name: /^Counter counter/ }).click();
  await appButton().waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tool"), "counter");
  await page.screenshot({
    path: join(captures, "desktop-detail.png"),
    fullPage: true,
    animations: "disabled",
  });
  // A stale or malformed reveal may never navigate a credential-bearing link.
  for (const failure of ["transport", "world", "location"]) {
    await page.route("**/api/environment/apps/counter", async (route) => {
      if (failure === "transport")
        return route.fulfill({ status: 503, json: { error: { message: "Fixture unavailable" } } });
      const response = await route.fetch();
      const body = await response.json();
      if (failure === "world") body.worldInstanceId = "different-world";
      else body.app.url = "http://127.0.0.1:1/index.html#token=wrong-location";
      await route.fulfill({ response, json: body });
    });
    const failedPopupPromise = page.waitForEvent("popup");
    await appButton().click();
    const failedPopup = await failedPopupPromise;
    await page.getByRole("alert").filter({ hasText: "The app could not be opened" }).waitFor();
    assert.ok(failedPopup.isClosed());
    assert.ok(
      !(await page
        .locator("body")
        .innerText()
        .then((text) => text.includes(scopedToken))),
    );
    await page.unroute("**/api/environment/apps/counter");
  }
  // Popup blocking is explicit, visible, and never triggers a credential reveal.
  await page.evaluate(() => {
    window.open = () => null;
  });
  let blockedRequests = 0;
  await page.route("**/api/environment/apps/counter", (route) => {
    blockedRequests++;
    return route.abort();
  });
  await appButton().click();
  await page.getByRole("alert").filter({ hasText: "Allow pop-ups" }).waitFor();
  assert.equal(blockedRequests, 0);
  await page.unroute("**/api/environment/apps/counter");
  await page.reload();
  await appButton().waitFor();
  const retryPromise = page.waitForEvent("popup");
  await appButton().click();
  const retried = await retryPromise;
  await retried.getByRole("heading", { name: "Counter app" }).waitFor();
  await retried.close();
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("button", { name: /^Backend only backend-only/ }).click();
  assert.equal(await page.getByRole("button", { name: /Open app for/ }).count(), 0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Use light theme" }).click();
  const noOverflow = async () => {
    assert.deepEqual(
      await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        nested: document.querySelectorAll("button button").length,
      })),
      { width: 390, scroll: 390, nested: 0 },
    );
  };
  await appButton().scrollIntoViewIfNeeded();
  await noOverflow();
  await page.screenshot({
    path: join(captures, "mobile-directory.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.ok(
    await page.locator(".fd-sidebar").evaluate((element) => element.getBoundingClientRect().right <= 0),
  );
  await page.getByRole("button", { name: /^Counter counter/ }).click();
  await appButton().waitFor();
  await noOverflow();
  await page.screenshot({
    path: join(captures, "mobile-detail.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.ok(
    await page.locator(".fd-sidebar").evaluate((element) => element.getBoundingClientRect().right <= 0),
  );
  await context.close();
  console.log(
    JSON.stringify({
      status: "passed",
      captures,
      assertions: [
        "guarded credential reveal",
        "real popup and canonical world mutation",
        "fragment removed and opener detached",
        "transport/stale world/wrong location refused",
        "popup blocking visible without fetch",
        "retry opens app",
        "backend-only control absent",
        "desktop/mobile separate controls without overflow",
      ],
    }),
  );
} finally {
  await browser?.close();
  await server?.close();
  await binding?.close();
  world?.close();
  rmSync(root, { recursive: true, force: true });
}
