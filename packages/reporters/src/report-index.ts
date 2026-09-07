import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { escapeHtml, reportDocument } from "./report-html.js";
import { LocalReportVerificationError, type VerifiedLocalReport, verifyLocalReport } from "./reporters.js";

const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_REPORTS = 500;
const MAX_VERIFICATION_BYTES = 256 * 1024 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_FILE = ".report-index.lock";

export class ReportIndexError extends Error {
  readonly code: "reporter.INDEX_UNSAFE_PATH" | "reporter.INDEX_LOCK_TIMEOUT" | "reporter.INDEX_LOCK_STALE";

  constructor(code: ReportIndexError["code"], message: string) {
    super(message);
    this.name = "ReportIndexError";
    this.code = code;
  }
}

export interface WrittenReportIndex {
  readonly path: string;
  readonly included: number;
  readonly excluded: number;
  readonly limited: boolean;
}

interface IndexEntry {
  readonly directory: string;
  readonly savedAt: number;
  readonly identity: VerifiedLocalReport["result"]["identity"];
  readonly outcome: string;
}

interface ExcludedReport {
  readonly directory: string;
  readonly reason: string;
}

function requireRegularFile(path: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata !== undefined && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new ReportIndexError(
      "reporter.INDEX_UNSAFE_PATH",
      `Report index path must be a regular file: ${path}`,
    );
  }
}

function readOwner(path: string): { readonly pid: number; readonly host: string } | undefined {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024) {
    throw new ReportIndexError(
      "reporter.INDEX_UNSAFE_PATH",
      "The report-index lock is not a bounded regular file.",
    );
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = JSON.parse(readFileSync(descriptor, "utf8")) as { pid?: unknown; host?: unknown };
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.host !== "string"
    ) {
      throw new Error("invalid owner");
    }
    return { pid: value.pid, host: value.host };
  } catch {
    throw new ReportIndexError(
      "reporter.INDEX_LOCK_STALE",
      "The report-index lock is unreadable. Confirm no index writer is running before removing .report-index.lock from the report folder.",
    );
  } finally {
    closeSync(descriptor);
  }
}

async function acquireLock(directory: string): Promise<() => void> {
  const lock = join(directory, LOCK_FILE);
  const owner = join(directory, `.report-index-owner-${randomUUID()}`);
  writeFileSync(owner, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 });
  const identity = lstatSync(owner);
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    while (true) {
      try {
        // A fully written owner record becomes the lock atomically. An empty lock
        // can never be mistaken for an abandoned writer during acquisition.
        linkSync(owner, lock);
        return () => {
          const current = lstatSync(lock, { throwIfNoEntry: false });
          if (current?.dev === identity.dev && current.ino === identity.ino) unlinkSync(lock);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let heldBy: ReturnType<typeof readOwner>;
      try {
        heldBy = readOwner(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (heldBy === undefined) continue;
      if (heldBy.host === hostname()) {
        try {
          process.kill(heldBy.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            // Never steal a lock by age: a slow live writer must retain ownership.
            // Manual recovery avoids cross-process stale-reaper deletion races.
            throw new ReportIndexError(
              "reporter.INDEX_LOCK_STALE",
              "A previous report-index writer stopped. Confirm no index writer is running, remove .report-index.lock from the report folder, then run a drill again. Saved reports are unchanged.",
            );
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new ReportIndexError(
          "reporter.INDEX_LOCK_TIMEOUT",
          "Another process is updating the report index. Saved reports are unchanged; retry after that process finishes.",
        );
      }
      await delay(40);
    }
  } finally {
    unlinkSync(owner);
  }
}

function bundleBytes(directory: string): number {
  let entries = 0;
  let bytes = 0;
  const visit = (path: string, depth: number): void => {
    if (depth > 32) throw new Error("Report exceeds discovery limits");
    const iterator = opendirSync(path);
    try {
      for (let entry = iterator.readSync(); entry !== null; entry = iterator.readSync()) {
        if (++entries > 1024) throw new Error("Report exceeds discovery limits");
        const child = join(path, entry.name);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) throw new Error("Report contains a symbolic link");
        if (stat.isDirectory()) visit(child, depth + 1);
        else if (stat.isFile()) bytes += stat.size;
        else throw new Error("Report contains a non-file entry");
        if (bytes > MAX_VERIFICATION_BYTES) throw new Error("Report exceeds verification byte limit");
      }
    } finally {
      iterator.closeSync();
    }
  };
  visit(directory, 0);
  return bytes;
}

function renderIndex(
  entries: readonly IndexEntry[],
  excluded: readonly ExcludedReport[],
  limited: boolean,
): string {
  const outcomeLabels: Record<string, string> = {
    passed: "passed",
    failed: "failed",
    inconclusive: "inconclusive",
    cancelled: "cancelled",
    runner_failed: "could not finish",
  };
  const totals = Object.entries(outcomeLabels)
    .map(([outcome, label]) => ({
      label,
      count: entries.filter((entry) => entry.outcome === outcome).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ label, count }) => `<span><strong>${count}</strong> ${label}</span>`)
    .join("");
  const rows = entries
    .map(({ directory, savedAt, identity, outcome }) => {
      const outcomeLabel = outcomeLabels[outcome] ?? outcome.replaceAll("_", " ");
      const search =
        `${identity.drillId} ${identity.targetId} ${identity.scenarioId ?? "world baseline"} ${identity.runId}`.toLowerCase();
      const href = `${encodeURIComponent(directory)}/index.html`;
      const repeated = [
        ...(identity.trialCount > 1 ? [`Repeat ${identity.trial} of ${identity.trialCount}`] : []),
        ...(identity.attemptLimit > 1 ? [`attempt ${identity.attempt} of ${identity.attemptLimit}`] : []),
      ].join(" · ");
      return `<tr data-report data-search="${escapeHtml(search)}" data-status="${escapeHtml(outcome)}"><td><a href="${escapeHtml(href)}" title="Run ${escapeHtml(identity.runId)}">${escapeHtml(identity.drillId)}</a>${repeated === "" ? "" : `<p class="muted">${repeated}</p>`}</td><td><span class="outcome ${escapeHtml(outcome)}">${escapeHtml(outcomeLabel)}</span></td><td>${escapeHtml(identity.targetId)}<p class="muted">${escapeHtml(identity.scenarioId ?? "World baseline")}</p></td><td><time datetime="${new Date(savedAt).toISOString()}">${escapeHtml(
        new Date(savedAt)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, " UTC"),
      )}</time></td></tr>`;
    })
    .join("");
  const script = `const rows=Array.from(document.querySelectorAll('[data-report]'));const search=document.getElementById('report-search');const status=document.getElementById('report-status');const previous=document.getElementById('previous');const next=document.getElementById('next');const count=document.getElementById('page-count');let page=0;const size=20;function render(){const query=search.value.trim().toLowerCase();const matches=rows.filter(row=>row.dataset.search.includes(query)&&(status.value==='all'||row.dataset.status===status.value));page=Math.min(page,Math.max(0,Math.ceil(matches.length/size)-1));const shown=new Set(matches.slice(page*size,(page+1)*size));rows.forEach(row=>{row.hidden=!shown.has(row)});previous.disabled=page===0;next.disabled=(page+1)*size>=matches.length;count.textContent=matches.length===0?'No matching reports':(page*size+1)+'–'+Math.min((page+1)*size,matches.length)+' of '+matches.length+' reports';document.getElementById('no-matches').hidden=matches.length!==0;}search.addEventListener('input',()=>{page=0;render()});status.addEventListener('change',()=>{page=0;render()});previous.addEventListener('click',()=>{page--;render()});next.addEventListener('click',()=>{page++;render()});document.getElementById('report-filters').hidden=false;document.getElementById('pagination').hidden=false;render();`;
  return reportDocument(
    "Drill reports",
    `<header><h1>Drill reports</h1><p class="hint">Saved results for this project. Open a drill to see the task, checks, tool calls and data changes from that execution.</p><div class="facts" aria-label="All reports included in this index"><span><strong>${entries.length}</strong> ${limited ? "listed" : "saved"} execution${entries.length === 1 ? "" : "s"}</span>${totals}</div></header>
${limited ? '<p class="hint">This index reached its discovery or verification limit. Some older reports are not listed; their saved folders are unchanged.</p>' : ""}
${entries.length === 0 ? '<section class="empty">No verified reports to show. Run a drill in this project to create a report.</section>' : `<div id="report-filters" class="filters" hidden><label for="report-search">Search<input id="report-search" type="search" placeholder="Drill, agent, scenario or run"></label><label for="report-status">Result<select id="report-status"><option value="all">All results</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="inconclusive">Inconclusive</option><option value="cancelled">Cancelled</option><option value="runner_failed">Could not finish</option></select></label></div><section class="list table-scroll"><table><caption class="sr-only">Saved drill reports, newest saved first</caption><thead><tr><th scope="col">Drill / execution</th><th scope="col">Result</th><th scope="col">Agent / scenario</th><th scope="col">Report saved</th></tr></thead><tbody>${rows}</tbody></table><p id="no-matches" class="empty" hidden>No reports match these filters.</p></section><div id="pagination" class="toolbar" hidden><p id="page-count" role="status" aria-live="polite"></p><div><button id="previous" type="button">Previous</button> <button id="next" type="button">Next</button></div></div>`}
${excluded.length === 0 ? "" : `<section><details><summary>${excluded.length} unavailable report${excluded.length === 1 ? "" : "s"}</summary><p class="hint">These folders were not linked because their reports could not be verified. Nothing was deleted or repaired. Use <code>firedrill report verify &lt;report-folder&gt;</code> for details.</p><div class="list">${excluded.map(({ directory, reason }) => `<div class="item"><code>${escapeHtml(directory)}</code><p class="muted">${escapeHtml(reason)}</p></div>`).join("")}</div></details></section>`}
<footer>Firedrill · Times describe when report folders were saved, not agent execution duration. This index is a local navigation aid, not a sealed evidence bundle. Review reports before sharing.</footer>`,
    entries.length === 0 ? "" : script,
  );
}

/** Refresh a navigable HTML index beside (never inside) immutable report bundles. */
export async function writeReportIndex(reportDirectory: string): Promise<WrittenReportIndex> {
  const directory = resolve(reportDirectory);
  mkdirSync(directory, { recursive: true });
  const rootMetadata = lstatSync(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new ReportIndexError(
      "reporter.INDEX_UNSAFE_PATH",
      "The report folder must be a real directory, not a symbolic link.",
    );
  }
  const release = await acquireLock(directory);
  const temporary = join(directory, `.report-index-${randomUUID()}.tmp`);
  try {
    const candidates: Array<{ name: string; savedAt: number }> = [];
    const excluded: ExcludedReport[] = [];
    let limited = false;
    let discovered = 0;
    const iterator = opendirSync(directory);
    try {
      for (let entry = iterator.readSync(); entry !== null; entry = iterator.readSync()) {
        if (++discovered > MAX_DIRECTORY_ENTRIES) {
          limited = true;
          break;
        }
        if (entry.name.startsWith(".")) continue;
        const metadata = lstatSync(join(directory, entry.name), { throwIfNoEntry: false });
        if (metadata?.isSymbolicLink()) {
          excluded.push({ directory: entry.name, reason: "Symbolic links are not followed." });
        } else if (metadata?.isDirectory()) candidates.push({ name: entry.name, savedAt: metadata.mtimeMs });
      }
    } finally {
      iterator.closeSync();
    }
    candidates.sort((a, b) => b.savedAt - a.savedAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (candidates.length > MAX_REPORTS) limited = true;
    const entries: IndexEntry[] = [];
    let verifiedBytes = 0;
    for (const candidate of candidates.slice(0, MAX_REPORTS)) {
      const path = join(directory, candidate.name);
      try {
        const bytes = bundleBytes(path);
        if (verifiedBytes + bytes > MAX_VERIFICATION_BYTES) {
          limited = true;
          continue;
        }
        verifiedBytes += bytes;
        const report = verifyLocalReport(path);
        entries.push({
          directory: candidate.name,
          savedAt: candidate.savedAt,
          identity: report.result.identity,
          outcome: report.result.status === "sealed" ? report.result.verdict : report.result.status,
        });
      } catch (error) {
        excluded.push({
          directory: candidate.name,
          reason:
            error instanceof LocalReportVerificationError
              ? error.code
              : "Could not read a safe, complete report bundle.",
        });
      }
    }
    const destination = join(directory, "index.html");
    requireRegularFile(destination);
    writeFileSync(temporary, renderIndex(entries, excluded, limited), { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
    return { path: destination, included: entries.length, excluded: excluded.length, limited };
  } finally {
    if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) unlinkSync(temporary);
    release();
  }
}
