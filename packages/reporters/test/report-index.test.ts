import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  type EvidenceEntry,
  JsonValueSchema,
  RunResultSchema,
} from "@firedrill-run/contracts";
import { trajectoryHash } from "@firedrill-run/world-ir";
import { afterEach, describe, expect, it } from "vitest";
import { writeReportIndex } from "../src/report-index.js";
import { verifyLocalReport, writeLocalReport } from "../src/reporters.js";

const directories: string[] = [];
let sequence = 0;
const HASH = `sha256:${"a".repeat(64)}`;

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "firedrill-report-index-"));
  directories.push(path);
  return path;
}

function report(directory: string, name: string, verdict: "passed" | "failed" = "passed", repeated = true) {
  const evidence: readonly EvidenceEntry[] = [
    {
      schemaVersion: 1,
      sequence: 1,
      transactionId: "txn_index001",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 0,
      correlationId: "corr_index001",
      kind: "lifecycle",
      action: "world_created",
      worldInstanceId: "world_index001",
      details: {},
    },
  ];
  const result = RunResultSchema.parse({
    schemaVersion: 1,
    status: "sealed",
    identity: {
      runId: `run_index${String(++sequence).padStart(6, "0")}`,
      worldInstanceId: "world_index001",
      drillId: "record-change",
      targetId: "agent-under-test",
      buildHash: HASH,
      packageLockHash: HASH,
      seed: "7",
      trial: repeated ? 2 : 1,
      trialCount: repeated ? 3 : 1,
      attempt: 1,
      attemptLimit: repeated ? 2 : 1,
    },
    startedAtVirtualUs: 0,
    finishedAtVirtualUs: 0,
    bindingEvidence: "not_checked",
    worldConsistency: "atomic",
    interactions: [],
    checkpoints: [],
    budgetUsage: {
      toolCalls: { limit: 100, attempted: 0, rejected: 0 },
      scheduledEvents: { limit: 100, processed: 0, exhausted: false },
    },
    verdict,
    assertionResults: [],
    evidenceRange: { fromSequence: 1, toSequence: 1 },
    stateHash: HASH,
    evidenceHash: `sha256:${createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(evidence)))
      .digest("hex")}`,
    trajectoryHash: trajectoryHash({ interactions: [], checkpoints: [], evidence }),
  });
  return writeLocalReport({ result, evidence }, join(directory, name));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("central report index", () => {
  it("links verified folders with escaped names, saved timestamps and usable offline controls", async () => {
    const root = temporary();
    const older = report(root, "old-report");
    const malicious = 'new <img src=x onerror="alert(1)"> #?';
    const latest = report(root, malicious, "failed");
    utimesSync(older.directory, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
    utimesSync(latest.directory, new Date("2025-02-01T00:00:00Z"), new Date("2025-02-01T00:00:00Z"));
    const original = readFileSync(latest.files.html);
    const index = await writeReportIndex(root);
    expect(index).toMatchObject({ path: join(root, "index.html"), included: 2, excluded: 0, limited: false });
    const html = readFileSync(index.path, "utf8");
    expect(html).toContain(`${encodeURIComponent(malicious)}/index.html`);
    expect(html).not.toContain("<img src=x");
    expect(html.indexOf(encodeURIComponent(malicious))).toBeLessThan(
      html.indexOf('href="old-report/index.html"'),
    );
    expect(html).toContain("Report saved");
    expect(html).toContain("2025-02-01 00:00:00 UTC");
    expect(html).toContain("Repeat 2 of 3 · attempt 1 of 2");
    expect(html).toContain("<strong>2</strong> saved executions");
    expect(html).toContain("<strong>1</strong> passed");
    expect(html).toContain("<strong>1</strong> failed");
    expect(html).toContain('id="report-search"');
    expect(html).toContain('id="report-status"');
    expect(html).toContain('data-status="passed"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('id="previous"');
    expect(html).toContain('id="next"');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(readFileSync(latest.files.html)).toEqual(original);
    expect(verifyLocalReport(latest.directory).manifest.runId).toBe(latest.manifest.runId);
  });

  it("keeps single executions readable without retry boilerplate or a prominent run ID", async () => {
    const root = temporary();
    const saved = report(root, "single", "passed", false);
    const index = await writeReportIndex(root);
    const html = readFileSync(index.path, "utf8");
    expect(html).toContain("<strong>1</strong> saved execution");
    expect(html).not.toContain("Repeat 1 of 1");
    expect(html).not.toContain("attempt 1 of 1");
    expect(html).toContain(`title="Run ${saved.manifest.runId}"`);
    expect(html).not.toContain(`<code>${saved.manifest.runId}</code>`);
  });

  it("shows unavailable reports without linking tampered or symlink HTML and skips temporary directories", async () => {
    const root = temporary();
    const safe = report(root, "safe");
    const tampered = report(root, "tampered");
    appendFileSync(tampered.files.html, "tampered");
    symlinkSync(safe.directory, join(root, "linked"), "dir");
    mkdirSync(join(root, ".in-progress"));
    const index = await writeReportIndex(root);
    expect(index).toMatchObject({ included: 1, excluded: 2, limited: false });
    const html = readFileSync(index.path, "utf8");
    expect(html).toContain("2 unavailable reports");
    expect(html).toContain("Symbolic links are not followed");
    expect(html).not.toContain('href="tampered/index.html"');
    expect(html).not.toContain('href="linked/index.html"');
    expect(html).not.toContain(".in-progress");
  });

  it("bounds candidate discovery and visibly discloses omitted older reports", async () => {
    const root = temporary();
    for (let index = 0; index < 501; index++) mkdirSync(join(root, `unsealed-${index}`));
    const result = await writeReportIndex(root);
    expect(result).toMatchObject({ included: 0, excluded: 500, limited: true });
    expect(readFileSync(result.path, "utf8")).toContain("Some older reports are not listed");
  });

  it("refuses unsafe output paths without following or overwriting their target", async () => {
    const root = temporary();
    const outside = join(root, "keep.txt");
    writeFileSync(outside, "keep");
    const reports = join(root, "reports");
    mkdirSync(reports);
    symlinkSync(outside, join(reports, "index.html"));
    await expect(writeReportIndex(reports)).rejects.toMatchObject({ code: "reporter.INDEX_UNSAFE_PATH" });
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(existsSync(join(reports, ".report-index.lock"))).toBe(false);
    symlinkSync(reports, join(root, "linked-reports"), "dir");
    await expect(writeReportIndex(join(root, "linked-reports"))).rejects.toMatchObject({
      code: "reporter.INDEX_UNSAFE_PATH",
    });
  });

  it("fails safely on malformed stale locks instead of stealing ownership", async () => {
    const root = temporary();
    const lock = join(root, ".report-index.lock");
    writeFileSync(lock, JSON.stringify({ host: hostname(), pid: -1 }));
    await expect(writeReportIndex(root)).rejects.toMatchObject({ code: "reporter.INDEX_LOCK_STALE" });
    expect(readFileSync(lock, "utf8")).toContain('"pid":-1');
    expect(readdirSync(root)).toEqual([".report-index.lock"]);
  });

  it("serializes independent processes so concurrent refreshes leave one complete index", async () => {
    const root = temporary();
    report(root, "first");
    report(root, "second");
    const module = new URL("../src/report-index.ts", import.meta.url).href;
    const child = () =>
      new Promise<void>((resolvePromise, reject) => {
        const process_ = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { writeReportIndex } from ${JSON.stringify(module)}; await writeReportIndex(${JSON.stringify(root)});`,
          ],
          { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] },
        );
        let errors = "";
        process_.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        process_.on("error", reject);
        process_.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(errors))));
      });
    await Promise.all([child(), child(), child()]);
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toContain('href="first/index.html"');
    expect(html).toContain('href="second/index.html"');
    expect(html).toContain("</html>");
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
  });
});
