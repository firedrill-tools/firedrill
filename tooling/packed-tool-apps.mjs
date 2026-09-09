import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalWorld, runDrills, verifyReport } from "@firedrill/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Copied into the archive-only consumer. The world resolves Tool declarations,
// behavior, UI bytes and starters from the separate minimal installed project.
const consumer = resolve(process.cwd());
const installedProject = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass the separate installed Tool-pack consumer");
assert.ok(
  fileURLToPath(import.meta.resolve("@firedrill/sdk")).startsWith(`${consumer}${sep}node_modules${sep}`),
);
const browserRequire = createRequire(import.meta.resolve("@firedrill/browser-tests"));
const { chromium } = browserRequire("playwright");
const evidenceDirectory = resolve(process.argv[3] ?? join(consumer, "tool-app-browser-evidence"));
mkdirSync(evidenceDirectory, { recursive: true });
const root = mkdtempSync(join(installedProject, "tool-apps-environment-"));
const initialized = spawnSync(
  join(installedProject, "node_modules", ".bin", "firedrill"),
  ["init", "--tool", "@firedrill/tool-mailbox", "--tool", "@firedrill/tool-object-storage", "--json"],
  { cwd: root, encoding: "utf8", timeout: 30_000 },
);
assert.equal(initialized.status, 0, initialized.stderr);
assert.equal(JSON.parse(initialized.stdout).sourceValidated, true);
assert.equal(JSON.parse(initialized.stdout).testsExecuted, false);
async function start() {
  const world = await createLocalWorld({ root });
  let binding;
  let browser;
  let context;
  try {
    binding = await world.listen({ protocols: ["http", "mcp"] });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    return { world, binding, browser, context };
  } catch (error) {
    await context?.close();
    await browser?.close();
    await binding?.close();
    world.close();
    throw error;
  }
}
const { world, binding, browser, context } = await start();
const app = (packageId) => {
  const selected = binding.apps.find((candidate) => candidate.packageId === packageId);
  assert.ok(selected, `Missing app for ${packageId}`);
  return selected;
};
const mcpClient = new Client({ name: "packed-tool-app-browser", version: "1.0.0" });
context.setDefaultTimeout(8000);
const errors = [];
const network = [];
const pages = [];
let sequence = 0;
async function http(path, method = "GET", body, expected = 200) {
  const response = await fetch(binding.http.url + path, {
    method,
    headers: {
      authorization: `Bearer ${binding.http.token}`,
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "idempotency-key": `browser-agent-${++sequence}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function mcp(name, arguments_) {
  const value = await mcpClient.callTool({ name, arguments: arguments_ });
  assert.ok(!value.isError, JSON.stringify(value));
  return value.structuredContent;
}
async function visible(page, selector) {
  await page.locator(selector).waitFor({ state: "visible" });
}
async function text(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected),
    { selector, expected },
  );
}
function observe(page, packageId, origin) {
  page.on("pageerror", (error) => errors.push({ packageId, error: error.message }));
  page.on("request", (request) => {
    const url = new URL(request.url());
    network.push({ packageId, origin: url.origin, path: url.pathname, method: request.method() });
    if (url.origin !== origin || url.hash !== "")
      errors.push({
        packageId,
        error: "Tool app attempted an external, cross-app or fragment-bearing request",
      });
  });
}
async function openApp(packageId) {
  const page = await context.newPage();
  pages.push(page);
  observe(page, packageId, new URL(app(packageId).url).origin);
  const response = await page.goto(app(packageId).url);
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-security-policy"], /default-src 'none'/);
  await text(page, "#identity", "local-dev");
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(
    await page.evaluate(() =>
      /^[A-Za-z0-9_-]{43}$/.test(sessionStorage.getItem("firedrill.tool-ui.token.v1") ?? ""),
    ),
    true,
  );
  await page.reload();
  await text(page, "#identity", "local-dev");
  assert.equal(new URL(page.url()).hash, "");
  return page;
}
async function confirm(page, label) {
  await visible(page, "#confirmation[open]");
  await page.locator("#confirmation").getByRole("button", { name: label, exact: true }).click();
  await page.locator("#confirmation").waitFor({ state: "hidden" });
}
async function screenshot(page, name) {
  await page.waitForFunction(() => !document.body.hasAttribute("aria-busy"));
  const headerLayout = await page.evaluate(() => {
    const header = document.querySelector(".topbar")?.getBoundingClientRect();
    const identity = document.querySelector("#identity")?.getBoundingClientRect();
    const toolbar = [...document.querySelectorAll(".toolbar")]
      .find((element) => element.getClientRects().length > 0)
      ?.getBoundingClientRect();
    return header && identity && toolbar
      ? identity.bottom <= header.bottom && toolbar.top >= header.bottom
      : false;
  });
  assert.equal(headerLayout, true, `${name}: header identity overlaps the workspace`);
  await page.screenshot({ path: join(evidenceDirectory, name), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `${name}: horizontal overflow`);
}

try {
  assert.equal(binding.apps.length, 2);
  assert.notEqual(new URL(app("mailbox").url).origin, new URL(app("object-storage").url).origin);
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(binding.mcp.url), {
      authProvider: { token: async () => binding.mcp.token },
    }),
  );
  const mail = await openApp("mailbox");
  await text(mail, "#messages", "Synthetic welcome");
  await screenshot(mail, "mailbox-desktop.png");
  await mail.getByRole("button", { name: /Synthetic welcome/ }).click();
  await text(mail, "#message-body", "isolated world");
  await mail.getByRole("button", { name: "Back to messages", exact: true }).click();
  await mail.getByRole("button", { name: "Compose", exact: true }).click();
  await mail.getByLabel("From", { exact: true }).fill("writer@example.test");
  await mail.getByLabel("To", { exact: true }).fill("reader@example.test");
  await mail.getByLabel("Subject", { exact: true }).fill("Browser-authored draft");
  await mail.getByLabel("Message", { exact: true }).fill("Created through the installed Tool app.");
  await screenshot(mail, "mailbox-compose-desktop.png");
  await mail.getByRole("button", { name: "Save draft", exact: true }).click();
  await text(mail, "#feedback", "Draft saved");
  const draft = (await http("/mailbox/messages?folder=draft")).items.find(
    (item) => item.subject === "Browser-authored draft",
  );
  assert.ok(draft);
  assert.equal(
    (await mcp("mailbox.messages.get", { id: draft.id })).message.body,
    "Created through the installed Tool app.",
  );
  await mail.getByRole("button", { name: "Close", exact: true }).click();
  await mail.getByRole("button", { name: "Drafts", exact: true }).click();
  await mail.getByRole("button", { name: /Browser-authored draft/ }).click();
  await mail.getByRole("button", { name: "Edit draft", exact: true }).click();
  await mail.getByLabel("Message", { exact: true }).fill("Edited and sent through the browser.");
  await mail.getByRole("button", { name: "Send message", exact: true }).click();
  await text(mail, "#folder-title", "Sent");
  const sent = (await mcp("mailbox.messages.get", { id: draft.id })).message;
  assert.equal(sent.folder, "sent");
  assert.equal(sent.body, "Edited and sent through the browser.");
  await mail.getByRole("button", { name: /Browser-authored draft/ }).click();
  await mail.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm(mail, "Cancel");
  assert.equal((await http(`/mailbox/messages/${draft.id}`)).message.id, draft.id);
  await mail.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm(mail, "Delete");
  await text(mail, "#feedback", "Message deleted");
  await http(`/mailbox/messages/${draft.id}`, "GET", undefined, 404);
  await mail.getByRole("button", { name: "Compose", exact: true }).click();
  await mail.getByLabel("Subject", { exact: true }).fill("Unsaved local form");
  await mail.getByRole("button", { name: "Close", exact: true }).click();
  await confirm(mail, "Cancel");
  assert.equal(await mail.getByLabel("Subject", { exact: true }).inputValue(), "Unsaved local form");
  await mail.getByRole("button", { name: "Close", exact: true }).click();
  await confirm(mail, "Discard changes");
  assert.equal((await http("/mailbox/messages?folder=draft")).items.length, 0);
  await mail.getByRole("button", { name: "Drafts", exact: true }).click();
  await mcp("mailbox.messages.write", {
    id: "agent-draft",
    from: "agent@example.test",
    to: ["operator@example.test"],
    subject: "Created by agent API",
    body: "External actor-scoped mutation",
    ifVersion: 0,
  });
  await text(mail, "#messages", "Created by agent API");

  const storage = await openApp("object-storage");
  await text(storage, "#objects", "welcome.txt");
  await screenshot(storage, "object-storage-desktop.png");
  await storage.getByRole("button", { name: "New object", exact: true }).click();
  await storage.getByLabel("Key", { exact: true }).fill("notes/browser.txt");
  await storage.getByLabel("Text content", { exact: true }).fill("Browser-created 🌍");
  await storage.getByRole("button", { name: "Save object", exact: true }).click();
  await text(storage, "#version", "Version 1");
  assert.equal(
    (await http("/storage/object?bucket=documents&key=notes%2Fbrowser.txt")).object.content,
    "Browser-created 🌍",
  );
  await storage.getByLabel("Text content", { exact: true }).fill("Browser-edited text");
  await storage.getByRole("button", { name: "Save object", exact: true }).click();
  await text(storage, "#version", "Version 2");
  assert.equal(
    (await mcp("object-storage.objects.get", { bucket: "documents", key: "notes/browser.txt" })).object
      .content,
    "Browser-edited text",
  );
  await screenshot(storage, "object-editor-desktop.png");
  await mcp("object-storage.objects.put", {
    bucket: "documents",
    key: "notes/browser.txt",
    content: "Concurrent agent update",
    ifVersion: 2,
  });
  await storage.getByLabel("Text content", { exact: true }).fill("Unsaved edit");
  const failedSave = storage.waitForResponse(
    (response) =>
      response.url().endsWith("/_firedrill/invoke") &&
      response.request().method() === "POST" &&
      response.status() === 422,
  );
  await storage.getByRole("button", { name: "Save object", exact: true }).click();
  const rejected = await (await failedSave).json();
  assert.equal(rejected.outcome.status, "tool_error");
  assert.equal(rejected.outcome.error.code, "tool.CONFLICT");
  await visible(storage, '#feedback[data-error="true"]');
  assert.equal(await storage.getByLabel("Text content", { exact: true }).inputValue(), "Unsaved edit");
  assert.match(await storage.locator("#version").textContent(), /Version 2/);
  assert.equal(
    (await http("/storage/object?bucket=documents&key=notes%2Fbrowser.txt")).object.content,
    "Concurrent agent update",
  );
  await storage.getByRole("button", { name: "Back to objects", exact: true }).click();
  await confirm(storage, "Discard changes");
  assert.equal(
    (await mcp("object-storage.objects.get", { bucket: "documents", key: "notes/browser.txt" })).object
      .content,
    "Concurrent agent update",
  );
  await mcp("object-storage.objects.put", {
    bucket: "documents",
    key: "from-agent.txt",
    content: "Agent-created text",
    ifVersion: 0,
  });
  await text(storage, "#objects", "from-agent.txt");
  await storage.getByRole("button", { name: /notes\/browser.txt/ }).click();
  await storage.getByRole("button", { name: "Delete object", exact: true }).click();
  await confirm(storage, "Cancel");
  await storage.getByRole("button", { name: "Delete object", exact: true }).click();
  await confirm(storage, "Delete");
  await text(storage, "#feedback", "Object deleted");
  await http("/storage/object?bucket=documents&key=notes%2Fbrowser.txt", "GET", undefined, 404);

  world.reset();
  await storage.getByRole("button", { name: "Refresh", exact: true }).click();
  await storage.waitForFunction(() => !document.body.hasAttribute("aria-busy"));
  await storage.getByRole("button", { name: /from-agent.txt/ }).waitFor({ state: "hidden" });
  await text(storage, "#objects", "welcome.txt");
  assert.equal(await storage.getByRole("button", { name: /from-agent.txt/ }).count(), 0);
  assert.equal((await http("/storage/objects?bucket=documents")).items.length, 1);
  await storage.setViewportSize({ width: 390, height: 844 });
  await screenshot(storage, "object-storage-mobile.png");
  await storage.getByRole("button", { name: /welcome.txt/ }).click();
  await visible(storage, "#editor");
  await storage.waitForFunction(() => document.querySelector("#content")?.value.includes("isolated world"));
  await screenshot(storage, "object-editor-mobile.png");
  const mobileSave = storage.getByRole("button", { name: "Save object", exact: true });
  await mobileSave.scrollIntoViewIfNeeded();
  const saveReachable = await mobileSave.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return bounds.top >= 0 && bounds.bottom <= innerHeight && target !== null && button.contains(target);
  });
  assert.equal(saveReachable, true, "Mobile Save object must remain reachable after scrolling");
  assert.equal(await mobileSave.isEnabled(), true);
  await mail.bringToFront();
  await mail.setViewportSize({ width: 390, height: 844 });
  await mail.getByRole("button", { name: "Inbox", exact: true }).click();
  await text(mail, "#messages", "Synthetic welcome");
  await screenshot(mail, "mailbox-mobile.png");
  await mail.getByRole("button", { name: "Compose", exact: true }).click();
  await visible(mail, "#composing");
  await screenshot(mail, "mailbox-compose-mobile.png");
  await mail.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal((await http("/mailbox/messages")).items.length, 1);
  await mail.setViewportSize({ width: 1440, height: 1000 });
  await mail.emulateMedia({ colorScheme: "dark" });
  await screenshot(mail, "mailbox-dark.png");
  await storage.setViewportSize({ width: 1440, height: 1000 });
  await storage.emulateMedia({ colorScheme: "dark" });
  await screenshot(storage, "object-editor-dark.png");

  // An actual drill must expose the same apps to its target and evaluate the
  // browser's committed consequence through canonical state assertions/reporting.
  writeFileSync(
    join(root, "firedrill/browser.target.json"),
    JSON.stringify({
      schemaVersion: 1,
      target: { id: "browser-agent", kind: "external", bindings: ["mcp"], timeoutMs: 30_000 },
    }),
  );
  writeFileSync(
    join(root, "firedrill/browser.drill.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "browser-tool-app",
      targetId: "browser-agent",
      actorId: "local-dev",
      inlineScenario: {
        virtualTimeUs: 0,
        actors: JSON.parse(readFileSync(join(root, "firedrill/world.json"), "utf8")).actors,
      },
      task: { instruction: "Create documents/browser-drill.txt through the object-storage app." },
      assertions: [
        {
          id: "browser-object-written",
          kind: "state.value",
          packageId: "object-storage",
          namespace: "objects",
          rowId: "local-dev:documents:browser-drill.txt",
          path: ["content"],
          comparison: { operator: "equals", value: "Written by a browser during the drill." },
        },
      ],
    }),
  );
  let attemptApp;
  const drill = await runDrills({
    root,
    drill: "browser-tool-app",
    agent: async ({ binding: attempt, attach }) => {
      assert.equal(attempt.apps.length, 2);
      assert.deepEqual(JSON.parse(attempt.environment.FIREDRILL_TOOL_APPS), attempt.apps);
      attemptApp = attempt.apps.find((candidate) => candidate.packageId === "object-storage");
      assert.ok(attemptApp);
      assert.notEqual(attemptApp.url, app("object-storage").url);
      const page = await context.newPage();
      pages.push(page);
      observe(page, "drill-object-storage", new URL(attemptApp.url).origin);
      try {
        await page.goto(attemptApp.url);
        await text(page, "#identity", "local-dev");
        assert.equal(new URL(page.url()).hash, "");
        await page.getByRole("button", { name: "New object", exact: true }).click();
        await page.getByLabel("Key", { exact: true }).fill("browser-drill.txt");
        await page.getByLabel("Text content", { exact: true }).fill("Written by a browser during the drill.");
        await page.getByRole("button", { name: "Save object", exact: true }).click();
        await text(page, "#version", "Version 1");
        await page.screenshot({ path: join(root, "browser-drill.png"), fullPage: true });
        attach({ path: "browser-drill.png", name: "browser-drill.png", mediaType: "image/png" });
        return { completed: true, appUrl: attemptApp.url }; // The real report must redact echoed runtime credentials.
      } finally {
        await page.close();
      }
    },
  });
  assert.equal(drill.verdict, "passed", JSON.stringify(drill));
  const trial = drill.drills[0]?.trials[0];
  assert.ok(trial);
  assert.equal(trial.result.assertionResults[0]?.status, "passed");
  assert.equal(trial.result.assertionResults[0]?.actual, "Written by a browser during the drill.");
  const verified = verifyReport({ report: trial.report.directory });
  assert.equal(verified.result.verdict, "passed");
  assert.equal(verified.attachments.length, 1);
  const report = readFileSync(trial.report.files.json, "utf8");
  const attemptToken = new URLSearchParams(new URL(attemptApp.url).hash.slice(1)).get("token");
  assert.ok(attemptToken);
  assert.ok(!report.includes(attemptToken), "Report retained an echoed Tool app credential");
  await assert.rejects(fetch(attemptApp.url));
  writeFileSync(join(evidenceDirectory, "browser-drill.png"), readFileSync(join(root, "browser-drill.png")));
  assert.deepEqual(errors, []);
  const screenshots = [
    "mailbox-desktop.png",
    "mailbox-compose-desktop.png",
    "object-storage-desktop.png",
    "object-editor-desktop.png",
    "object-storage-mobile.png",
    "object-editor-mobile.png",
    "mailbox-mobile.png",
    "mailbox-compose-mobile.png",
    "mailbox-dark.png",
    "object-editor-dark.png",
    "browser-drill.png",
  ];
  writeFileSync(
    join(evidenceDirectory, "verification.json"),
    `${JSON.stringify({ schemaVersion: 1, status: "passed", mode: "installed-archive-browser", browser: await browser.version(), screenshots, requests: network.length, requestOrigins: [...new Set(network.map((item) => item.packageId))], observedExternalRequests: 0, drillReport: trial.report.directory, checks: ["fragment-cleared", "session-storage-reload", "mail-read-draft-edit-send-delete-discard", "object-create-edit-delete-discard", "canonical-tool-error-preserves-unsaved-input", "agent-api-visible-in-ui", "same-sqlite-http-mcp", "reset", "desktop-mobile-no-overflow", "actual-browser-drill-state-assertion", "verified-report-screenshot", "echoed-app-credential-redacted", "attempt-listener-closed"] }, null, 2)}\n`,
  );
  process.stdout.write(
    `Packed Tool apps: browser/HTTP/MCP shared state, mutations, reset and desktop/mobile proof passed (${evidenceDirectory})\n`,
  );
} catch (error) {
  for (const [index, page] of pages.entries())
    await page
      .screenshot({ path: join(evidenceDirectory, `failure-${index}.png`), fullPage: true })
      .catch(() => undefined);
  throw error;
} finally {
  await context.close();
  await browser.close();
  await mcpClient.close();
  await binding.close();
  world.close();
}
