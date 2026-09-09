import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ASSERTION_DIAGNOSTIC_LIMIT,
  BrowserStepSchema,
  BrowserTestDefinitionSchema,
  BrowserTestError,
  type BrowserTestResult,
} from "./contracts.js";
import { digest, writeNew } from "./files.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function diagnosticHtml(value: unknown, truncation?: { readonly fullLength: number }): string {
  return `<pre>${escapeHtml(value ?? "Unavailable")}</pre>${truncation ? `<p>Showing the first ${ASSERTION_DIAGNOSTIC_LIMIT.toLocaleString("en-US")} of ${truncation.fullLength.toLocaleString("en-US")} characters after redaction. The complete value was compared before truncation.</p>` : ""}`;
}
export function writeBrowserReport(result: BrowserTestResult): void {
  const title = result.definition.title ?? result.definition.id;
  const assertions = result.assertions
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.id)}</td><td>${item.passed ? "Passed" : "Failed"}</td><td>${diagnosticHtml(item.expected, item.expectedTruncation)}</td><td>${diagnosticHtml(item.actual, item.actualTruncation)}</td></tr>`,
    )
    .join("");
  const evaluatedIds = new Set(result.assertions.map((assertion) => assertion.id));
  const unevaluated = result.definition.assertions.filter((assertion) => !evaluatedIds.has(assertion.id));
  const checkRows =
    assertions +
    unevaluated
      .map(
        (assertion) =>
          `<tr><td>${escapeHtml(assertion.id)}</td><td>Not evaluated</td><td colspan="2">Execution stopped before this assertion was evaluated.</td></tr>`,
      )
      .join("");
  const assertionSummary =
    result.definition.assertions.length === 0
      ? "No independent assertions were configured. This is not a passing test."
      : unevaluated.length === result.definition.assertions.length
        ? `${unevaluated.length} independent assertion${unevaluated.length === 1 ? " was" : "s were"} configured, but ${unevaluated.length === 1 ? "it was not" : "none were"} evaluated because execution stopped.`
        : unevaluated.length > 0
          ? `${result.assertions.length} of ${result.definition.assertions.length} independent assertions were evaluated before execution stopped.`
          : "The result comes from the explicit browser assertions below.";
  const events = result.events
    .map(
      (event) => `<li><span>${(event.elapsedMs / 1000).toFixed(1)}s</span> ${escapeHtml(event.message)}</li>`,
    )
    .join("");
  const artifacts = result.artifacts
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.path)}">${escapeHtml(item.path)}</a> · ${escapeHtml(item.mediaType)}${item.mediaType === "image/png" ? `<img alt="Final browser screenshot" src="${escapeHtml(item.path)}">` : ""}</li>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · Firedrill</title><style>body{margin:0;background:#fafafa;color:#17181a;font:15px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:28px;line-height:1.25}h2{font-size:19px;margin-top:36px}a{color:#3155b7;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible{outline:2px solid #3155b7;outline-offset:3px}::selection{background:#dce5ff}p{max-width:75ch}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace}table{width:100%;border-collapse:collapse;background:white;table-layout:fixed}th,td{text-align:left;padding:12px;border-bottom:1px solid #dedfe2;vertical-align:top;overflow-wrap:anywhere}th{font-weight:600}li{margin:12px 0}li span{color:#616772;display:inline-block;width:65px;font-variant-numeric:tabular-nums}img{display:block;max-width:100%;margin-top:12px;border:1px solid #ddd;border-radius:6px}.summary{padding:16px 20px;background:white;border:1px solid #dedfe2;border-radius:8px}@media(max-width:600px){main{padding:0 16px;margin:24px auto}th,td{padding:8px;font-size:13px}}</style></head><body><main><h1>${escapeHtml(title)}</h1><div class="summary"><strong>${escapeHtml(result.status.toUpperCase())}</strong> · ${(result.durationMs / 1000).toFixed(1)}s<p>${assertionSummary} Browser checks do not verify synthetic world state. A drill's separate world assertions provide that evidence.</p></div>${result.errors.length ? `<h2>Problems</h2><ul>${result.errors.map((error) => `<li>${escapeHtml(error.code)}: ${escapeHtml(error.message)}</li>`).join("")}</ul>` : ""}<h2>Checks</h2>${checkRows ? `<table><thead><tr><th>Assertion</th><th>Result</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${checkRows}</tbody></table>` : "<p>No assertions were configured.</p>"}<h2>Browser activity</h2><ol>${events}</ol><h2>Files</h2><p>Keep this folder together when sharing. Screenshots, video and traces can contain sensitive application data.</p><ul>${artifacts}<li><a href="report.json">Machine-readable result</a></li><li><a href="test.browser.json">Reusable test definition</a></li></ul></main></body></html>`;
  writeNew(join(result.reportDirectory, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeNew(
    join(result.reportDirectory, "test.browser.json"),
    `${JSON.stringify({ ...result.definition, steps: result.steps }, null, 2)}\n`,
  );
  const reportHtml = result.replayable
    ? html
    : html
        .replace(
          "<h2>Files</h2>",
          `<h2>Recorded source needs review</h2><p>Privacy redaction changed execution fields, or execution stopped before a complete flow was recorded. The observation above is still evidence of this run; its redacted source must be reviewed before reuse.</p><ul>${result.replayIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul><h2>Files</h2>`,
        )
        .replace(">Reusable test definition</a>", ">Redacted test definition (review before reuse)</a>");
  writeNew(join(result.reportDirectory, "index.html"), reportHtml);
  const paths = [
    "report.json",
    "test.browser.json",
    "index.html",
    ...result.artifacts.map((item) => item.path),
  ];
  writeNew(
    join(result.reportDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "browser-test",
        runId: result.runId,
        files: paths.map((path) => {
          const body = readFileSync(join(result.reportDirectory, path));
          return { path, bytes: body.byteLength, sha256: digest(body) };
        }),
      },
      null,
      2,
    )}\n`,
  );
}
export function verifyBrowserTestReport(directory: string): BrowserTestResult {
  const root = realpathSync(directory);
  const read = (path: string, maximum: number) => {
    if (typeof path !== "string" || !/^[A-Za-z0-9._-]+$/.test(path) || path === "." || path === "..")
      throw new BrowserTestError("browser.REPORT_INVALID", "Browser report file path is invalid.");
    const full = join(root, path);
    const metadata = lstatSync(full);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximum)
      throw new BrowserTestError("browser.REPORT_INVALID", "Browser report file is invalid or too large.");
    return readFileSync(full);
  };
  const manifest = z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("browser-test"),
      runId: z.string().regex(/^browser_[a-f0-9]{32}$/),
      files: z
        .array(
          z
            .object({
              path: z.string(),
              bytes: z.number().int().nonnegative(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .max(40),
    })
    .strict()
    .parse(JSON.parse(read("manifest.json", 64000).toString("utf8")));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "browser-test" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 40
  )
    throw new BrowserTestError("browser.REPORT_INVALID", "Browser report manifest is invalid.");
  const paths = new Set<string>();
  let total = 0;
  for (const item of manifest.files) {
    if (paths.has(item.path))
      throw new BrowserTestError("browser.REPORT_INVALID", "Duplicate browser report file.");
    paths.add(item.path);
    const body = read(item.path, 64 * 1024 * 1024);
    total += body.byteLength;
    if (total > 128 * 1024 * 1024 || body.byteLength !== item.bytes || digest(body) !== item.sha256)
      throw new BrowserTestError(
        "browser.REPORT_INVALID",
        "Browser report bytes do not match their manifest.",
      );
  }
  if (!["report.json", "test.browser.json", "index.html"].every((path) => paths.has(path)))
    throw new BrowserTestError("browser.REPORT_INVALID", "Browser report is incomplete.");
  const boundedText = z.string().max(30000);
  const result = z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("browser-test"),
      runId: z.string().regex(/^browser_[a-f0-9]{32}$/),
      definition: BrowserTestDefinitionSchema,
      status: z.enum(["passed", "failed", "completed", "cancelled"]),
      worldVerified: z.literal(false),
      replayable: z.boolean(),
      replayIssues: z.array(z.string().min(1).max(4000)).max(100),
      durationMs: z.number().finite().nonnegative(),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime(),
      steps: z.array(BrowserStepSchema).max(500),
      assertions: z
        .array(
          z
            .object({
              id: boundedText,
              kind: z.enum(["visible", "text", "value", "url"]),
              passed: z.boolean(),
              expected: z.union([boundedText, z.boolean()]),
              actual: z.union([boundedText, z.boolean(), z.null()]),
              expectedTruncation: z
                .object({ fullLength: z.number().int().safe().positive() })
                .strict()
                .optional(),
              actualTruncation: z
                .object({ fullLength: z.number().int().safe().positive() })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(100),
      events: z
        .array(
          z
            .object({
              sequence: z.number().int().positive(),
              type: z.enum(["started", "step", "assertion", "log", "blocked-request", "finished"]),
              message: boundedText,
              elapsedMs: z.number().nonnegative(),
            })
            .strict(),
        )
        .max(2000),
      errors: z.array(z.object({ code: boundedText, message: boundedText }).strict()).max(100),
      artifacts: z
        .array(
          z
            .object({
              path: boundedText,
              mediaType: boundedText,
              bytes: z.number().int().nonnegative(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .max(37),
      reportDirectory: boundedText,
      reportPath: boundedText,
    })
    .strict()
    .parse(JSON.parse(read("report.json", 64 * 1024 * 1024).toString("utf8")));
  if (
    result.schemaVersion !== 1 ||
    result.kind !== "browser-test" ||
    result.runId !== manifest.runId ||
    result.worldVerified !== false
  )
    throw new BrowserTestError("browser.REPORT_INVALID", "Browser report identity is invalid.");
  if (result.replayable !== (result.replayIssues.length === 0))
    throw new BrowserTestError("browser.REPORT_INVALID", "Browser replayability metadata is inconsistent.");
  const definedAssertions = new Map(result.definition.assertions.map((item) => [item.id, item]));
  const actualIds = new Set<string>();
  for (const assertion of result.assertions) {
    if (actualIds.has(assertion.id) || definedAssertions.get(assertion.id)?.kind !== assertion.kind)
      throw new BrowserTestError(
        "browser.REPORT_INVALID",
        "Browser assertion results do not match the test definition.",
      );
    actualIds.add(assertion.id);
    for (const [value, truncation] of [
      [assertion.expected, assertion.expectedTruncation],
      [assertion.actual, assertion.actualTruncation],
    ] as const) {
      if (
        truncation &&
        (typeof value !== "string" ||
          value.length !== ASSERTION_DIAGNOSTIC_LIMIT ||
          truncation.fullLength <= value.length)
      )
        throw new BrowserTestError(
          "browser.REPORT_INVALID",
          "Browser assertion truncation metadata is inconsistent.",
        );
    }
  }
  const fatalErrors = result.errors.filter(
    (error) => !["browser.CAPTURE_UNAVAILABLE", "browser.CAPTURE_LIMIT"].includes(error.code),
  );
  if (
    (result.status === "passed" &&
      (fatalErrors.length > 0 ||
        !result.assertions.length ||
        result.assertions.length !== definedAssertions.size ||
        result.assertions.some((item) => !item.passed))) ||
    (result.status === "completed" &&
      (fatalErrors.length > 0 || definedAssertions.size > 0 || result.assertions.length > 0))
  )
    throw new BrowserTestError(
      "browser.REPORT_INVALID",
      "Browser report verdict is inconsistent with its assertions.",
    );
  if (
    JSON.stringify(result.definition.steps) !== JSON.stringify(result.steps) ||
    JSON.stringify(
      BrowserTestDefinitionSchema.parse(JSON.parse(read("test.browser.json", 256 * 1024).toString("utf8"))),
    ) !== JSON.stringify(result.definition)
  )
    throw new BrowserTestError("browser.REPORT_INVALID", "Saved browser steps do not match the result.");
  const artifactPaths = new Set<string>();
  for (const artifact of result.artifacts) {
    const entry = manifest.files.find((file) => file.path === artifact.path);
    if (
      artifactPaths.has(artifact.path) ||
      ["report.json", "test.browser.json", "index.html", "manifest.json"].includes(artifact.path) ||
      !entry ||
      entry.sha256 !== artifact.sha256 ||
      entry.bytes !== artifact.bytes
    )
      throw new BrowserTestError("browser.REPORT_INVALID", "Browser artifact metadata is inconsistent.");
    artifactPaths.add(artifact.path);
  }
  return result;
}
