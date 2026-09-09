import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type BrowserTestDefinition, BrowserTestError, type BrowserTestResult } from "./contracts.js";
import { inside, loadBrowserTest } from "./files.js";
import { verifyBrowserTestReport } from "./report.js";

export interface BrowserListOptions {
  readonly root?: string;
  readonly directory?: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface BrowserListPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly diagnostics: readonly { readonly path: string; readonly message: string }[];
}
export interface SavedBrowserTest {
  readonly path: string;
  readonly definition: BrowserTestDefinition;
}
export interface BrowserTestReportSummary {
  readonly runId: string;
  readonly testId: string;
  readonly title: string;
  readonly status: BrowserTestResult["status"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly assertions: number;
  readonly passedAssertions: number;
  readonly reportDirectory: string;
  readonly reportPath: string;
}
function selection(options: BrowserListOptions, fallback: string) {
  const root = realpathSync(options.root ?? process.cwd());
  const directory = inside(root, options.directory ?? fallback);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new BrowserTestError(
      "browser.INVALID_OPTIONS",
      "Use a non-negative offset and a page limit from 1 through 100.",
    );
  if (existsSync(directory) && !lstatSync(directory).isDirectory())
    throw new BrowserTestError(
      "browser.INVALID_DEFINITION_PATH",
      "The browser collection must be a directory.",
    );
  return { root, directory, offset, limit };
}
function page<T>(
  items: T[],
  total: number,
  offset: number,
  limit: number,
  diagnostics: BrowserListPage<T>["diagnostics"],
): BrowserListPage<T> {
  return { items, total, offset, limit, hasMore: offset + limit < total, diagnostics };
}
/** Lists the explicitly chosen source directory, without traversing arbitrary repository files. */
export function listBrowserTests(options: BrowserListOptions = {}): BrowserListPage<SavedBrowserTest> {
  const { root, directory, offset, limit } = selection(options, "firedrill/browser-tests");
  if (!existsSync(directory)) return page([], 0, offset, limit, []);
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(".browser.json"))
    .sort();
  const diagnostics: { path: string; message: string }[] = [];
  const items: SavedBrowserTest[] = [];
  for (const name of candidates.slice(offset, offset + limit)) {
    const path = relative(root, join(directory, name)).split(sep).join("/");
    try {
      items.push({ path, definition: loadBrowserTest({ root, path }) });
    } catch {
      diagnostics.push({
        path,
        message: "This browser test is invalid or unreadable. Open its source to correct it.",
      });
    }
  }
  return page(items, candidates.length, offset, limit, diagnostics);
}
/** Only complete, integrity-verified reports appear as results. Partial directories are diagnosed. */
export function listBrowserTestReports(
  options: BrowserListOptions = {},
): BrowserListPage<BrowserTestReportSummary> {
  const { root, directory, offset, limit } = selection(options, ".firedrill/browser");
  if (!existsSync(directory)) return page([], 0, offset, limit, []);
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^browser_[a-f0-9]{32}$/.test(entry.name))
    .map((entry) => ({ name: entry.name, time: lstatSync(join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const diagnostics: { path: string; message: string }[] = [];
  const items: BrowserTestReportSummary[] = [];
  for (const candidate of candidates.slice(offset, offset + limit)) {
    const reportDirectory = inside(root, join(directory, candidate.name));
    const path = relative(root, reportDirectory).split(sep).join("/");
    try {
      const result = verifyBrowserTestReport(reportDirectory);
      if (result.runId !== candidate.name) throw new Error("Unexpected report identity");
      items.push({
        runId: result.runId,
        testId: result.definition.id,
        title: result.definition.title ?? result.definition.id,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        assertions: result.assertions.length,
        passedAssertions: result.assertions.filter((item) => item.passed).length,
        reportDirectory: path,
        reportPath: `${path}/index.html`,
      });
    } catch {
      diagnostics.push({
        path,
        message: "This browser report is incomplete, changed, or unreadable. It is not a verified result.",
      });
    }
  }
  return page(items, candidates.length, offset, limit, diagnostics);
}
