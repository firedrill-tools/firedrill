import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceEntry, RunResult, ToolPackageManifest } from "@firedrill/contracts";
import { AssertionResultSchema, canonicalJson, JsonValueSchema, RunResultSchema } from "@firedrill/contracts";
import { trajectoryHash } from "@firedrill/world-ir";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareLocalReports,
  renderHtmlReport,
  renderJsonReport,
  renderJunitReport,
  renderTerminalReport,
  verifyLocalReport,
  writeLocalReport,
} from "../src/index.js";

const directories: string[] = [];
const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-report-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function semanticHash(value: unknown): string {
  const json = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
  return `sha256:${createHash("sha256").update(canonicalJson(json)).digest("hex")}`;
}

function evidence(): readonly EvidenceEntry[] {
  return [
    {
      schemaVersion: 1,
      sequence: 1,
      transactionId: "txn_report001",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 500,
      correlationId: "corr_report001",
      kind: "lifecycle",
      action: "world_created",
      worldInstanceId: "world_report001",
      details: {
        source: "<script>alert('unsafe')</script>",
        apiToken: "built-in-secret-1234",
        sessionMaterial: "declared-secret-5678",
        note: "configured with declared-secret-5678",
      },
    },
    {
      schemaVersion: 1,
      sequence: 2,
      transactionId: "txn_report002",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 500,
      correlationId: "corr_report002",
      kind: "state_change",
      packageId: "generic-tool",
      namespace: "records",
      rowId: "item-1",
      change: "update",
      before: { status: "queued" },
      after: { status: "complete", sessionMaterial: "declared-secret-5678" },
      deltaHash: HASH,
    },
  ];
}

function run(entries: readonly EvidenceEntry[]): RunResult {
  const assertion = AssertionResultSchema.parse({
    schemaVersion: 1,
    assertionId: "no-extra-actions",
    kind: "operation.count",
    status: "passed",
    gate: true,
    message: "operation count matched",
    expected: { operator: "equals", value: 0 },
    actual: 0,
    location: {
      subject: "operation",
      operations: [{ packageId: "generic-tool", operationId: "items.update" }],
    },
    diff: { operator: "equals", matched: true, details: {} },
    evidenceSequences: [],
  });
  const interactions = [
    {
      schemaVersion: 1 as const,
      interactionId: "inspect-record",
      actorId: "operator",
      task: { instruction: "Verify the agent changes only the intended record." },
      scheduledAtVirtualUs: 500,
      startedAtVirtualUs: 500,
      finishedAtVirtualUs: 500,
      bindingEvidence: "issued" as const,
      targetResult: {
        schemaVersion: 1 as const,
        status: "completed" as const,
        output: {
          note: "<script>alert('unsafe')</script>",
          echoedToken: "built-in-secret-1234",
          forwarded: "declared-secret-5678",
        },
        attachments: [],
      },
    },
  ];
  const checkpoints = [
    {
      schemaVersion: 1 as const,
      checkpointId: "final",
      kind: "final" as const,
      virtualTimeUs: 500,
      verdict: "passed" as const,
      assertionResults: [assertion],
    },
  ];
  return RunResultSchema.parse({
    schemaVersion: 1,
    status: "sealed",
    identity: {
      runId: "run_report001",
      worldInstanceId: "world_report001",
      drillId: "generic-agent-behavior",
      scenarioId: "initial-state",
      targetId: "agent-under-test",
      buildHash: HASH,
      packageLockHash: HASH_B,
      seed: "41",
      trial: 1,
      trialCount: 1,
    },
    startedAtVirtualUs: 500,
    finishedAtVirtualUs: 500,
    bindingEvidence: "issued",
    worldConsistency: "atomic",
    budgetUsage: {
      toolCalls: { limit: 1000, attempted: 0, rejected: 0 },
      scheduledEvents: { limit: 10000, processed: 0, exhausted: false },
    },
    verdict: "passed",
    interactions,
    checkpoints,
    assertionResults: [assertion],
    evidenceRange: { fromSequence: 1, toSequence: entries.at(-1)?.sequence ?? 1 },
    stateHash: HASH,
    evidenceHash: semanticHash(entries),
    trajectoryHash: trajectoryHash({ interactions, checkpoints, evidence: entries }),
  });
}

function tools(): readonly ToolPackageManifest[] {
  return [
    {
      schemaVersion: 1,
      id: "generic-tool",
      version: "1.0.0",
      engine: "firedrill@1",
      capabilities: [],
      state: [],
      operations: [
        {
          id: "items.update",
          inputSchema: {
            type: "object",
            properties: {
              sessionMaterial: { type: "string", "x-firedrill-sensitive": true },
            },
          },
          outputSchema: { type: "object" },
          declaredErrors: [],
          idempotency: "none",
          fidelity: "contract",
        },
      ],
      events: [],
      faults: [],
      subscriptions: [],
    },
  ];
}

describe("local evidence reporters", () => {
  it("renders terminal, JSON, JUnit, and escaped self-contained HTML from one sealed input", () => {
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };
    expect(renderTerminalReport(input)).toContain("PASSED  generic-agent-behavior");
    expect(renderTerminalReport(input)).toContain(`Trajectory ${run(entries).trajectoryHash}`);
    expect(renderTerminalReport(input)).toContain("Budgets: 0/1000 Tool calls");
    expect(JSON.parse(renderJsonReport(input))).toMatchObject({
      schemaVersion: 1,
      run: { identity: { runId: "run_report001" } },
    });
    expect(renderJunitReport(input)).toContain('<testsuites tests="2" failures="0"');
    expect(renderJunitReport(input)).toContain('name="firedrill.trajectoryHash"');
    expect(renderJunitReport(input)).toContain('name="firedrill.toolCalls.limit" value="1000"');
    const html = renderHtmlReport(input);
    expect(html).toContain("Firedrill report");
    expect(html).toContain("Resource budgets");
    expect(html).not.toContain('class="eyebrow"');
    expect(html).toContain("Verify the agent changes only the intended record.");
    expect(html).toContain("generic-tool.records/item-1");
    expect(html).toContain("&lt;script&gt;alert(&#39;unsafe&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('unsafe')</script>");
    expect(html).not.toContain("built-in-secret-1234");
    expect(html).not.toContain("declared-secret-5678");
    expect(html).toContain(`--build-hash ${HASH}`);
    expect(renderJsonReport(input)).not.toContain("built-in-secret-1234");
    expect(renderJunitReport(input)).not.toContain("declared-secret-5678");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<strong>completed</strong><p");
  });

  it("prints concise expected and actual values for a failed terminal assertion", () => {
    const entries = evidence();
    const passed = run(entries);
    if (passed.status !== "sealed") throw new Error("fixture must be sealed");
    const original = passed.assertionResults[0];
    if (original === undefined) throw new Error("fixture has no assertion");
    const failedAssertion = AssertionResultSchema.parse({
      ...original,
      status: "failed",
      message: "operation count did not match",
      actual: 1,
      diff: { ...original.diff, matched: false },
    });
    const checkpoints = passed.checkpoints.map((checkpoint) =>
      checkpoint.kind === "final"
        ? { ...checkpoint, verdict: "failed" as const, assertionResults: [failedAssertion] }
        : checkpoint,
    );
    const failed = RunResultSchema.parse({
      ...passed,
      verdict: "failed",
      checkpoints,
      assertionResults: [failedAssertion],
      trajectoryHash: trajectoryHash({
        interactions: passed.interactions,
        checkpoints,
        evidence: entries,
      }),
    });

    const terminal = renderTerminalReport({ result: failed, evidence: entries });
    expect(terminal).toContain('expected {"operator":"equals","value":0}');
    expect(terminal).toContain("actual   1");
  });

  it("writes an atomic, hash-addressed bundle and refuses replacement", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };
    const destination = join(root, "report");
    const written = writeLocalReport(input, destination);

    expect(readdirSync(destination).sort()).toEqual([
      "evidence.jsonl",
      "index.html",
      "junit.xml",
      "manifest.json",
      "report.json",
      "run.json",
      "terminal.txt",
    ]);
    expect(written.manifest.artifacts).toHaveLength(6);
    expect(written.manifest.redaction).toMatchObject({
      policy: "safe_fields_v1",
      applied: true,
    });
    expect(written.manifest.redaction.replacements).toBeGreaterThan(0);
    expect(written.manifest.reproduction).toMatchObject({
      scope: "world_inputs",
      drillId: "generic-agent-behavior",
      buildHash: HASH,
      seed: "41",
    });
    expect(written.manifest.trajectoryHash).toBe(input.result.trajectoryHash);
    expect(JSON.parse(readFileSync(written.files.manifest, "utf8"))).toEqual(written.manifest);
    for (const file of readdirSync(destination)) {
      const body = readFileSync(join(destination, file), "utf8");
      expect(body).not.toContain("built-in-secret-1234");
      expect(body).not.toContain("declared-secret-5678");
    }
    expect(verifyLocalReport(destination)).toMatchObject({
      manifest: { runId: "run_report001", complete: true },
      result: { identity: { drillId: "generic-agent-behavior" } },
    });
    expect(() => writeLocalReport(input, destination)).toThrow(/refusing to overwrite/);
  });

  it("rejects tampered artifacts, extra files, and symbolic links", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };

    const tampered = writeLocalReport(input, join(root, "tampered"));
    writeFileSync(tampered.files.html, "modified");
    expect(() => verifyLocalReport(tampered.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.ARTIFACT_MISMATCH" }),
    );

    const extra = writeLocalReport(input, join(root, "extra"));
    writeFileSync(join(extra.directory, "unlisted.txt"), "not in manifest");
    expect(() => verifyLocalReport(extra.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const linked = writeLocalReport(input, join(root, "linked"));
    symlinkSync(linked.files.html, join(linked.directory, "unlisted-link"));
    expect(() => verifyLocalReport(linked.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const linkedManifest = writeLocalReport(input, join(root, "linked-manifest"));
    const outsideManifest = join(root, "outside-manifest.json");
    writeFileSync(outsideManifest, "not a report manifest");
    rmSync(linkedManifest.files.manifest);
    symlinkSync(outsideManifest, linkedManifest.files.manifest);
    expect(() => verifyLocalReport(linkedManifest.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const oversized = writeLocalReport(input, join(root, "oversized"));
    const oversizedManifest = JSON.parse(readFileSync(oversized.files.manifest, "utf8")) as {
      artifacts: Array<{ path: string; bytes: number }>;
    };
    const htmlArtifact = oversizedManifest.artifacts.find((artifact) => artifact.path === "index.html");
    if (htmlArtifact === undefined) throw new Error("fixture has no HTML artifact");
    htmlArtifact.bytes = 64 * 1024 * 1024 + 1;
    writeFileSync(oversized.files.manifest, `${JSON.stringify(oversizedManifest, null, 2)}\n`);
    expect(() => verifyLocalReport(oversized.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_LIMIT_EXCEEDED" }),
    );
  });

  it("rejects a projection that is internally rehashed but disagrees with the run", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const written = writeLocalReport(
      { result: run(entries), evidence: entries, tools: tools() },
      join(root, "inconsistent"),
    );
    const changed = readFileSync(written.files.terminal, "utf8").replace("PASSED", "FAILED");
    writeFileSync(written.files.terminal, changed);
    const manifest = JSON.parse(readFileSync(written.files.manifest, "utf8")) as {
      artifacts: Array<{ path: string; bytes: number; hash: string }>;
    };
    const terminal = manifest.artifacts.find((artifact) => artifact.path === "terminal.txt");
    if (terminal === undefined) throw new Error("fixture has no terminal artifact");
    terminal.bytes = Buffer.byteLength(changed);
    terminal.hash = `sha256:${createHash("sha256").update(changed).digest("hex")}`;
    writeFileSync(written.files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyLocalReport(written.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.REPORT_INVALID" }),
    );
  });

  it("rejects evidence that does not belong to the sealed result", () => {
    const entries = evidence();
    expect(() => renderTerminalReport({ result: run(entries), evidence: [] })).toThrow(
      /does not match the sealed run range/,
    );
  });

  it("compares exact-input runs without inventing a regression label", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const baselineResult = run(entries);
    const baseline = writeLocalReport({ result: baselineResult, evidence: entries }, join(root, "baseline"));
    if (baselineResult.status !== "sealed") throw new Error("fixture must be sealed");
    const baselineAssertion = baselineResult.assertionResults[0];
    if (baselineAssertion === undefined) throw new Error("fixture has no assertion");
    const failedAssertion = AssertionResultSchema.parse({
      ...baselineAssertion,
      status: "failed",
      message: "operation count did not match",
      actual: 1,
      diff: { ...baselineAssertion.diff, matched: false },
    });
    const checkpoints = baselineResult.checkpoints.map((checkpoint) =>
      checkpoint.kind === "final"
        ? { ...checkpoint, verdict: "failed" as const, assertionResults: [failedAssertion] }
        : checkpoint,
    );
    const candidateResult = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report002",
        worldInstanceId: "world_report002",
      },
      verdict: "failed",
      stateHash: HASH_B,
      checkpoints,
      assertionResults: [failedAssertion],
      trajectoryHash: trajectoryHash({
        interactions: baselineResult.interactions,
        checkpoints,
        evidence: entries,
      }),
    });
    const candidate = writeLocalReport(
      { result: candidateResult, evidence: entries },
      join(root, "candidate"),
    );

    const comparison = compareLocalReports(baseline.directory, candidate.directory);
    expect(comparison).toMatchObject({
      compatibility: {
        status: "exact_inputs",
        canAttributeBehaviorChange: true,
        differences: [],
      },
      outcome: "changed",
      baseline: { verdict: "passed" },
      candidate: { verdict: "failed" },
      changes: {
        verdictChanged: true,
        stateChanged: true,
        trajectoryChanged: true,
        assertions: [
          {
            checkpointId: "final",
            assertionId: "no-extra-actions",
            baseline: "passed",
            candidate: "failed",
            actualChanged: true,
          },
        ],
      },
    });
    expect(comparison).not.toHaveProperty("regression");
  });

  it("downgrades changed worlds and rejects mismatched run inputs", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const baselineResult = run(entries);
    const baseline = writeLocalReport({ result: baselineResult, evidence: entries }, join(root, "baseline"));
    const changedBuild = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report003",
        worldInstanceId: "world_report003",
        buildHash: HASH_B,
      },
    });
    const buildCandidate = writeLocalReport(
      { result: changedBuild, evidence: entries },
      join(root, "changed-build"),
    );
    expect(compareLocalReports(baseline.directory, buildCandidate.directory)).toMatchObject({
      compatibility: {
        status: "descriptive_only",
        canAttributeBehaviorChange: false,
        differences: ["build"],
      },
    });

    const changedSeed = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report004",
        worldInstanceId: "world_report004",
        seed: "42",
      },
    });
    const seedCandidate = writeLocalReport(
      { result: changedSeed, evidence: entries },
      join(root, "changed-seed"),
    );
    expect(compareLocalReports(baseline.directory, seedCandidate.directory)).toMatchObject({
      compatibility: { status: "incompatible", differences: ["seed"] },
      outcome: "not_comparable",
    });
  });
});
