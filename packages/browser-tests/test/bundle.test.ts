import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { expect, it } from "vitest";
import { bundleBrowserTestReport, runBrowserTest, verifyBrowserTestReport } from "../src/index.js";

it("exports a complete, bounded portable report and refuses a tampered file", async () => {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-portable-"));
  const unpacked = mkdtempSync(join(tmpdir(), "firedrill-browser-unpacked-"));
  const server = createServer((_request, response) => response.end("<h1>Portable report</h1>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  try {
    const result = await runBrowserTest({
      root,
      definition: {
        schemaVersion: 1,
        id: "portable",
        startUrl: `http://127.0.0.1:${address.port}`,
        assertions: [
          { id: "title", kind: "text", selector: { by: "css", value: "h1" }, expected: "Portable report" },
        ],
      },
      capture: { screenshot: "always", trace: "always", video: "always" },
    });
    expect(result.status).toBe("passed");
    const bundle = await bundleBrowserTestReport(result.reportDirectory);
    expect(bundle.filename).toBe(`${result.runId}.tar.gz`);
    expect(bundle.mediaType).toBe("application/gzip");
    extract({ cwd: unpacked, sync: true, strict: true }).end(bundle.bytes);
    const copied = verifyBrowserTestReport(join(unpacked, result.runId));
    expect(copied.runId).toBe(result.runId);
    expect(copied.artifacts.map((item) => item.path).sort()).toEqual([
      "screenshot.png",
      "trace.zip",
      "video.webm",
    ]);
    writeFileSync(join(result.reportDirectory, "index.html"), "tampered");
    await expect(bundleBrowserTestReport(result.reportDirectory)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
  }
});
