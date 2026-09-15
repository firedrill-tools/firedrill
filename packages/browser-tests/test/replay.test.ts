import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserTestDefinitionSchema,
  browserTestDefinitionFromResult,
  runBrowserTest,
  verifyBrowserTestReport,
} from "../src/index.js";
import { recordedReplayIssues } from "../src/replay.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recorded browser source semantics", () => {
  it("detects changed URLs, selectors and expectations, but ignores display title redaction", () => {
    const definition = BrowserTestDefinitionSchema.parse({
      schemaVersion: 1,
      id: "recorded",
      title: "Private display name",
      startUrl: "http://localhost:3000/item/private",
      steps: [{ action: "click", selector: { by: "text", value: "Private" } }],
      assertions: [
        { id: "name", kind: "text", selector: { by: "css", value: "output" }, expected: "Private" },
      ],
    });
    expect(recordedReplayIssues(definition, { ...definition, title: "[redacted]" })).toEqual([]);
    const redacted = BrowserTestDefinitionSchema.parse({
      ...definition,
      startUrl: "http://localhost:3000/item/redacted",
      steps: [{ action: "click", selector: { by: "text", value: "[redacted]" } }],
      assertions: [{ ...definition.assertions[0], expected: "[redacted]" }],
    });
    expect(recordedReplayIssues(definition, redacted)).toEqual([
      "startUrl: privacy redaction changed a value needed to repeat this flow.",
      "steps[0]: privacy redaction changed a value needed to repeat this flow.",
      "assertions[0]: privacy redaction changed a value needed to repeat this flow.",
    ]);
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))("real browser replay integrity", () => {
  it("preserves a passing observation but refuses falsely reusable redacted assertions", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-browser-replay-"));
    roots.push(root);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<label>Name<input id="name"></label><output>Ready</output>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    const privateValue = "Taylor-private-8824";
    const result = await runBrowserTest({
      root,
      definition: {
        schemaVersion: 1,
        id: "redacted-assertion",
        startUrl: `http://127.0.0.1:${address.port}`,
        steps: [{ action: "fill", selector: { by: "label", value: "Name" }, parameter: "name" }],
        assertions: [
          { id: "name", kind: "value", selector: { by: "css", value: "#name" }, expected: privateValue },
        ],
      },
      parameters: { name: privateValue },
      capture: { screenshot: "off" },
    });
    expect(result.status).toBe("passed");
    expect(result.replayable).toBe(false);
    expect(result.replayIssues).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(readFileSync(join(result.reportDirectory, "test.browser.json"), "utf8")).not.toContain(
      privateValue,
    );
    expect(verifyBrowserTestReport(result.reportDirectory).replayable).toBe(false);
    expect(() => browserTestDefinitionFromResult({ result, id: "reuse" })).toThrowError(
      expect.objectContaining({ code: "browser.REPLAY_REVIEW_REQUIRED" }),
    );

    const safe = await runBrowserTest({
      root,
      definition: {
        ...result.definition,
        id: "safe-input",
        assertions: [
          { id: "ready", kind: "text", selector: { by: "css", value: "output" }, expected: "Ready" },
        ],
      },
      parameters: { name: privateValue },
      capture: { screenshot: "off" },
    });
    expect(safe.replayable).toBe(true);
    const definition = browserTestDefinitionFromResult({ result: safe, id: "repeat-safe-input" });
    const rerun = await runBrowserTest({
      root,
      definition,
      parameters: { name: privateValue },
      capture: { screenshot: "off" },
    });
    expect(rerun.status).toBe("passed");
    expect(rerun.replayable).toBe(true);
    const interrupted = await runBrowserTest({
      root,
      definition: {
        schemaVersion: 1,
        id: "incomplete-action",
        startUrl: `http://127.0.0.1:${address.port}`,
        steps: [{ action: "click", selector: { by: "text", value: "Missing button" } }],
      },
      stepTimeoutMs: 50,
      capture: { screenshot: "off" },
    });
    expect(interrupted.status).toBe("failed");
    expect(interrupted.replayable).toBe(false);
    expect(interrupted.replayIssues).toEqual([
      "steps: execution stopped before a complete flow was recorded; review the observed actions before reuse.",
    ]);
    expect(verifyBrowserTestReport(interrupted.reportDirectory).replayable).toBe(false);
    expect(() => browserTestDefinitionFromResult({ result: interrupted })).toThrowError(
      expect.objectContaining({ code: "browser.REPLAY_REVIEW_REQUIRED" }),
    );
  }, 30000);
});
