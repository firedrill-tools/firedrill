import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { BrowserTestError } from "./contracts.js";
import { writeNew } from "./files.js";
import { verifyBrowserTestReport } from "./report.js";

/** Returns a complete portable archive, copied then verified before packing to avoid reading live caller files twice. */
export async function bundleBrowserTestReport(
  directory: string,
): Promise<{ readonly filename: string; readonly mediaType: "application/gzip"; readonly bytes: Buffer }> {
  const result = verifyBrowserTestReport(directory);
  const paths = [
    "manifest.json",
    "report.json",
    "test.browser.json",
    "index.html",
    ...result.artifacts.map((artifact) => artifact.path),
  ];
  const temporary = mkdtempSync(join(tmpdir(), "firedrill-browser-bundle-"));
  try {
    for (const path of paths) {
      if (!/^[A-Za-z0-9._-]+$/.test(path) || path === "." || path === "..")
        throw new BrowserTestError(
          "browser.REPORT_INVALID",
          "Browser report contains an invalid bundle path.",
        );
      writeNew(join(temporary, path), readFileSync(join(directory, path)));
    }
    verifyBrowserTestReport(temporary);
    const archive = create(
      { cwd: temporary, gzip: true, portable: true, noMtime: true, prefix: result.runId, follow: false },
      paths,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of archive) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 130 * 1024 * 1024) {
        archive.destroy();
        throw new BrowserTestError("browser.REPORT_TOO_LARGE", "Browser report archive exceeds 130 MiB.");
      }
      chunks.push(bytes);
    }
    return {
      filename: `${result.runId}.tar.gz`,
      mediaType: "application/gzip",
      bytes: Buffer.concat(chunks, size),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
