import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { expect, it } from "vitest";
import {
  bundleBrowserTestReport,
  listBrowserTestReports,
  runBrowserTest,
  verifyBrowserTestReport,
} from "../src/index.js";

it("compares full large DOM values and retains verifiable bounded pass and fail diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-large-page-"));
  const unpacked = mkdtempSync(join(tmpdir(), "firedrill-browser-large-unpacked-"));
  const body = `${"long application content ".repeat(2000)}FINAL_CONFIRMATION`;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<body>${body}</body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  try {
    for (const [id, expected, status] of [
      ["large-pass", "FINAL_CONFIRMATION", "passed"],
      ["large-fail", "MISSING_CONFIRMATION", "failed"],
      ["large-expectation", body.slice(-10000), "passed"],
    ] as const) {
      const result = await runBrowserTest({
        root,
        definition: {
          schemaVersion: 1,
          id,
          startUrl: `http://127.0.0.1:${address.port}`,
          assertions: [
            { id: "body", kind: "text", selector: { by: "css", value: "body" }, expected, contains: true },
          ],
        },
        // This covers result truncation, not navigation latency. Keep enough
        // headroom for the package suite to run concurrently on shared CI.
        stepTimeoutMs: 1_000,
        capture: { screenshot: "off" },
      });
      expect(body.length).toBeGreaterThan(30000);
      expect(result.status).toBe(status);
      expect(result.assertions[0]?.actual).toHaveLength(8000);
      expect(result.assertions[0]?.actual).not.toContain("FINAL_CONFIRMATION");
      expect(result.assertions[0]?.actualTruncation).toEqual({ fullLength: body.length });
      if (expected.length > 8000) {
        expect(result.assertions[0]?.expected).toHaveLength(8000);
        expect(result.assertions[0]?.expectedTruncation).toEqual({ fullLength: expected.length });
      }
      expect(verifyBrowserTestReport(result.reportDirectory).status).toBe(status);
      const html = readFileSync(result.reportPath, "utf8");
      expect(html).toContain("Showing the first 8,000");
      expect(html).toContain("The complete value was compared before truncation.");
      const bundle = await bundleBrowserTestReport(result.reportDirectory);
      extract({ cwd: unpacked, sync: true, strict: true }).end(bundle.bytes);
      expect(verifyBrowserTestReport(join(unpacked, result.runId)).status).toBe(status);
    }
    const reports = listBrowserTestReports({ root });
    expect(reports.items).toHaveLength(3);
    expect(reports.diagnostics).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
  }
}, 30000);

it("reports configured assertions as not evaluated when a browser action fails or is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-unchecked-"));
  const server = createServer((_request, response) => response.end("<h1>Ready</h1>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  try {
    for (const kind of ["failed", "cancelled"] as const) {
      const controller = new AbortController();
      const result = await runBrowserTest({
        root,
        definition: {
          schemaVersion: 1,
          id: `unchecked-${kind}`,
          startUrl: `http://127.0.0.1:${address.port}`,
          ...(kind === "failed"
            ? { steps: [{ action: "click" as const, selector: { by: "css" as const, value: "#missing" } }] }
            : {}),
          assertions: [
            { id: "heading", kind: "text", selector: { by: "css", value: "h1" }, expected: "Ready" },
          ],
        },
        ...(kind === "cancelled"
          ? {
              driver: async () => {
                controller.abort();
              },
            }
          : {}),
        signal: controller.signal,
        stepTimeoutMs: 100,
        capture: { screenshot: "off" },
      });
      expect(result.status).toBe(kind);
      expect(result.assertions).toHaveLength(0);
      expect(verifyBrowserTestReport(result.reportDirectory).status).toBe(kind);
      const html = readFileSync(result.reportPath, "utf8");
      expect(html).toContain(
        "1 independent assertion was configured, but it was not evaluated because execution stopped.",
      );
      expect(html).toContain("Not evaluated");
      expect(html).toContain("heading");
      expect(html).not.toContain("No assertions were configured.");
      expect(html).not.toContain("No independent assertions were configured.");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it("verifies and exports a multi-assertion Unicode report larger than two MiB", async () => {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-large-suite-"));
  const unpacked = mkdtempSync(join(tmpdir(), "firedrill-browser-suite-unpacked-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<body>${"界".repeat(40000)}READY</body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  try {
    const result = await runBrowserTest({
      root,
      definition: {
        schemaVersion: 1,
        id: "large-suite",
        startUrl: `http://127.0.0.1:${address.port}`,
        assertions: Array.from({ length: 100 }, (_, index) => ({
          id: `check-${index}`,
          kind: "text" as const,
          selector: { by: "css" as const, value: "body" },
          expected: "READY",
          contains: true,
        })),
      },
      capture: { screenshot: "off" },
    });
    expect(result.status).toBe("passed");
    expect(readFileSync(join(result.reportDirectory, "report.json")).length).toBeGreaterThan(2 * 1024 * 1024);
    expect(verifyBrowserTestReport(result.reportDirectory).assertions).toHaveLength(100);
    expect(listBrowserTestReports({ root }).diagnostics).toEqual([]);
    const bundle = await bundleBrowserTestReport(result.reportDirectory);
    extract({ cwd: unpacked, sync: true, strict: true }).end(bundle.bytes);
    expect(verifyBrowserTestReport(join(unpacked, result.runId)).assertions).toHaveLength(100);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
  }
}, 30000);
