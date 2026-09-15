import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserTestDefinitionSchema,
  loadBrowserTest,
  runBrowserTest,
  saveBrowserTest,
  verifyBrowserTestReport,
} from "../src/index.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "firedrill-browser-test-"));
  roots.push(path);
  return path;
}
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw Error("Server did not bind");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const instance of servers.splice(0)) {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("browser test source", () => {
  it("accepts small reusable JSON and does not overwrite source", () => {
    const directory = root();
    const definition = { schemaVersion: 1 as const, id: "appointment", startUrl: "http://localhost:3000" };
    const path = saveBrowserTest({ root: directory, definition });
    expect(loadBrowserTest({ root: directory, path }).id).toBe("appointment");
    expect(() => saveBrowserTest({ root: directory, definition })).toThrow();
    expect(() => saveBrowserTest({ root: directory, path: "../escape.json", definition })).toThrow();
    expect(() => saveBrowserTest({ root: directory, path: ".env.json", definition })).toThrow();
  });
  it("rejects ambiguous fill and duplicate assertions", () => {
    expect(() =>
      BrowserTestDefinitionSchema.parse({
        schemaVersion: 1,
        id: "check",
        startUrl: "http://localhost",
        steps: [{ action: "fill", selector: { by: "label", value: "Name" }, parameter: "name", value: "x" }],
      }),
    ).toThrow();
    expect(() =>
      BrowserTestDefinitionSchema.parse({
        schemaVersion: 1,
        id: "check",
        startUrl: "http://localhost",
        assertions: [
          { id: "same", kind: "url", expected: "/" },
          { id: "same", kind: "url", expected: "/" },
        ],
      }),
    ).toThrow();
  });
  it("rejects remote or secret-bearing URLs before launching", async () => {
    await expect(
      runBrowserTest({
        root: root(),
        definition: { schemaVersion: 1, id: "remote", startUrl: "https://example.com" },
      }),
    ).rejects.toMatchObject({ code: "browser.REMOTE_ORIGIN_REQUIRES_OPT_IN" });
    await expect(
      runBrowserTest({
        root: root(),
        definition: { schemaVersion: 1, id: "secret", startUrl: "http://person:secret@localhost" },
      }),
    ).rejects.toMatchObject({ code: "browser.INVALID_URL" });
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))("real Chromium browser execution", () => {
  it("uses the actual application, checks consequences, records redacted reusable steps and verifies portable reports", async () => {
    let mutations = 0;
    const url = await server((request, response) => {
      if (request.url === "/save") {
        mutations++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ saved: true }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        "<label>Name<input id=\"name\"></label><button onclick=\"fetch('/save',{method:'POST'}).then(()=>document.querySelector('output').textContent='Saved')\">Save</button><output role=\"status\">Pending</output>",
      );
    });
    const directory = root();
    const result = await runBrowserTest({
      root: directory,
      definition: {
        schemaVersion: 1,
        id: "record",
        startUrl: url,
        steps: [
          { action: "fill", selector: { by: "label", value: "Name" }, parameter: "testName" },
          { action: "click", selector: { by: "role", role: "button", name: "Save" } },
        ],
        assertions: [
          { id: "saved", kind: "text", selector: { by: "css", value: "output" }, expected: "Saved" },
        ],
      },
      parameters: { testName: "private-test-name" },
      capture: { screenshot: "always", trace: "always", video: "always" },
    });
    expect(result.status).toBe("passed");
    expect(result.worldVerified).toBe(false);
    expect(mutations).toBe(1);
    expect(result.artifacts.map((item) => item.path).sort()).toEqual([
      "screenshot.png",
      "trace.zip",
      "video.webm",
    ]);
    expect(readFileSync(join(result.reportDirectory, "report.json"), "utf8")).not.toContain(
      "private-test-name",
    );
    expect(verifyBrowserTestReport(result.reportDirectory).runId).toBe(result.runId);
    writeFileSync(join(result.reportDirectory, "index.html"), "tampered");
    expect(() => verifyBrowserTestReport(result.reportDirectory)).toThrow("manifest");
  }, 20000);
  it("distinguishes completed without checks from a failed independent check", async () => {
    const url = await server((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<h1>Seven</h1>");
    });
    const complete = await runBrowserTest({
      root: root(),
      definition: { schemaVersion: 1, id: "observe", startUrl: url },
      capture: { screenshot: "off" },
    });
    expect(complete.status).toBe("completed");
    const failed = await runBrowserTest({
      root: root(),
      definition: {
        schemaVersion: 1,
        id: "expect-eight",
        startUrl: url,
        assertions: [{ id: "number", kind: "text", selector: { by: "css", value: "h1" }, expected: "Eight" }],
      },
      stepTimeoutMs: 100,
      capture: { screenshot: "retain-on-failure" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.assertions[0]).toMatchObject({ expected: "Eight", actual: "Seven", passed: false });
    expect(failed.artifacts).toHaveLength(1);
  }, 20000);
  it("does not follow redirects or leak subrequests to an unapproved origin", async () => {
    let unapproved = 0;
    const destination = await server((_request, response) => {
      unapproved++;
      response.end("blocked");
    });
    const origin = await server((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: destination });
        response.end();
      } else {
        response.setHeader("content-type", "text/html");
        response.end(`<h1>Safe</h1><script>fetch('${destination}'); window.open('${destination}');</script>`);
      }
    });
    const redirected = await runBrowserTest({
      root: root(),
      definition: { schemaVersion: 1, id: "redirect", startUrl: `${origin}/redirect` },
      capture: { screenshot: "off" },
    });
    expect(redirected.status).toBe("failed");
    expect(redirected.errors.map((item) => item.code)).toContain("browser.ORIGIN_BLOCKED");
    const cross = await runBrowserTest({
      root: root(),
      definition: {
        schemaVersion: 1,
        id: "cross",
        startUrl: origin,
        steps: [{ action: "wait", milliseconds: 100 }],
      },
      capture: { screenshot: "off" },
    });
    expect(cross.status).toBe("failed");
    expect(unapproved).toBe(0);
  }, 20000);
  it("cancels a live browser and enforces action limits", async () => {
    const url = await server((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<button>Okay</button>");
    });
    const controller = new AbortController();
    const cancelled = await runBrowserTest({
      root: root(),
      signal: controller.signal,
      definition: { schemaVersion: 1, id: "cancel", startUrl: url },
      driver: async (context) => {
        setTimeout(() => controller.abort(), 50);
        await context.step({ action: "wait", milliseconds: 5000 });
      },
      capture: { screenshot: "off" },
    });
    expect(cancelled.status).toBe("cancelled");
    const limited = await runBrowserTest({
      root: root(),
      maxActions: 1,
      definition: {
        schemaVersion: 1,
        id: "limited",
        startUrl: url,
        steps: [
          { action: "wait", milliseconds: 1 },
          { action: "wait", milliseconds: 1 },
        ],
      },
      capture: { screenshot: "off" },
    });
    expect(limited.status).toBe("failed");
    expect(limited.errors.map((item) => item.code)).toContain("browser.ACTION_LIMIT");
  }, 20000);
  it("records driver actions and supports replay without the driver", async () => {
    const url = await server((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<button onclick=\"this.textContent='Finished'\">Start</button>");
    });
    const directory = root();
    const first = await runBrowserTest({
      root: directory,
      definition: {
        schemaVersion: 1,
        id: "driven",
        startUrl: url,
        task: "Finish the action",
        assertions: [{ id: "done", kind: "visible", selector: { by: "text", value: "Finished" } }],
      },
      driver: async (context) => {
        expect((await context.observe()).snapshot).toContain("Start");
        await context.step({ action: "click", selector: { by: "role", role: "button", name: "Start" } });
      },
    });
    expect(first.status).toBe("passed");
    const saved = loadBrowserTest({
      root: directory,
      path: join(first.reportDirectory, "test.browser.json"),
    });
    const rerun = await runBrowserTest({ root: directory, definition: saved });
    expect(rerun.status).toBe("passed");
  }, 20000);
});
