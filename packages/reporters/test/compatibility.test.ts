import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceEntry, RunResult } from "@firedrill-run/contracts";
import { canonicalJson, JsonValueSchema, RunResultSchema } from "@firedrill-run/contracts";
import { trajectoryHash } from "@firedrill-run/world-ir";
import { afterEach, describe, expect, it } from "vitest";
import { legacyProjections as initialProjections } from "../src/compatibility/initial.js";
import { renderReportPage as versionTwoHtml } from "../src/compatibility/report-html-v2.js";
import { trajectoryHash as initialTrajectoryHash } from "../src/compatibility/trajectory-initial.js";
import { legacyProjections as versionOneProjections } from "../src/compatibility/v1.js";
import { verifyLocalReport, writeLocalReport } from "../src/reporters.js";

const directories: string[] = [];
const HASH = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function hash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function semanticHash(value: unknown): string {
  return hash(canonicalJson(JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))));
}

function input(): { readonly result: RunResult; readonly evidence: readonly EvidenceEntry[] } {
  const evidence: readonly EvidenceEntry[] = [
    {
      schemaVersion: 1,
      sequence: 1,
      transactionId: "txn_compat001",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 0,
      correlationId: "corr_compat001",
      kind: "lifecycle",
      action: "world_created",
      worldInstanceId: "world_compat001",
    },
  ];
  const result = RunResultSchema.parse({
    schemaVersion: 1,
    identity: {
      runId: "run_compat001",
      worldInstanceId: "world_compat001",
      drillId: "empty-world",
      targetId: "local-target",
      buildHash: HASH,
      packageLockHash: HASH,
      seed: "13",
      trial: 1,
      trialCount: 1,
    },
    startedAtVirtualUs: 0,
    finishedAtVirtualUs: 0,
    bindingEvidence: "not_checked",
    worldConsistency: "atomic",
    interactions: [],
    checkpoints: [],
    budgetUsage: {
      toolCalls: { limit: 10, attempted: 0, rejected: 0 },
      scheduledEvents: { limit: 10, processed: 0, exhausted: false },
    },
    status: "sealed",
    verdict: "passed",
    assertionResults: [],
    evidenceRange: { fromSequence: 1, toSequence: 1 },
    stateHash: HASH,
    evidenceHash: semanticHash(evidence),
    trajectoryHash: trajectoryHash({ interactions: [], checkpoints: [], evidence }),
  });
  return { result, evidence };
}

interface MutableManifest {
  presentationVersion?: number;
  trajectoryVersion?: number;
  tools?: unknown[];
  runResultHash: string;
  projectedRunResultHash: string;
  trajectoryHash: string;
  projectedTrajectoryHash: string;
  artifacts: Array<{ path: string; hash: string; bytes: number }>;
}

function manifestAt(directory: string): MutableManifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as MutableManifest;
}

function saveManifest(directory: string, manifest: MutableManifest): void {
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function legacyBundle(version: "initial" | "v1" | "v2"): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-compatibility-"));
  directories.push(directory);
  const data = input();
  const report = writeLocalReport(data, join(directory, "run_compat001"));
  if (version === "v2") {
    const verified = verifyLocalReport(report.directory);
    const body = versionTwoHtml({
      ...verified,
      reproduce: `firedrill run empty-world --build-hash ${HASH} --seed 13 --trials 1`,
      reproductionNote:
        "Restores the same world inputs and seed. Your agent may make different choices on another run; use the original harness for external targets.",
    });
    const manifest = manifestAt(report.directory);
    manifest.presentationVersion = 2;
    const artifact = manifest.artifacts.find((entry) => entry.path === "index.html");
    if (artifact === undefined) throw new Error("fixture has no HTML artifact");
    writeFileSync(join(report.directory, artifact.path), body);
    artifact.bytes = Buffer.byteLength(body);
    artifact.hash = hash(body);
    saveManifest(report.directory, manifest);
    return report.directory;
  }
  const result = data.result;
  if (result.status !== "sealed") throw new Error("expected sealed fixture");
  const trajectory = version === "initial" ? initialTrajectoryHash : trajectoryHash;
  result.trajectoryHash = trajectory({
    interactions: result.interactions,
    checkpoints: result.checkpoints,
    evidence: data.evidence,
  });
  const projections = (version === "initial" ? initialProjections : versionOneProjections)({
    result,
    evidence: data.evidence,
    tools: [],
  });
  const bodies: Record<string, string> = {
    "run.json": `${JSON.stringify(result, null, 2)}\n`,
    "evidence.jsonl": `${data.evidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "report.json": projections.json,
    "terminal.txt": projections.terminal,
    "junit.xml": projections.junit,
    "index.html": projections.html,
  };
  const manifest = manifestAt(report.directory);
  delete manifest.presentationVersion;
  delete manifest.trajectoryVersion;
  if (version === "initial") delete manifest.tools;
  manifest.runResultHash = semanticHash(result);
  manifest.projectedRunResultHash = semanticHash(result);
  manifest.trajectoryHash = result.trajectoryHash;
  manifest.projectedTrajectoryHash = result.trajectoryHash;
  for (const artifact of manifest.artifacts) {
    const body = bodies[artifact.path];
    if (body === undefined) throw new Error("unexpected fixture artifact");
    writeFileSync(join(report.directory, artifact.path), body);
    artifact.bytes = Buffer.byteLength(body);
    artifact.hash = hash(body);
  }
  saveManifest(report.directory, manifest);
  return report.directory;
}

function fileHashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory).map((name) => [name, hash(readFileSync(join(directory, name), "utf8"))]),
  );
}

describe("versioned local report compatibility", () => {
  it.each(["initial", "v1", "v2"] as const)("verifies %s reports without rewriting evidence", (version) => {
    const directory = legacyBundle(version);
    const before = fileHashes(directory);
    expect(verifyLocalReport(directory).result.identity.drillId).toBe("empty-world");
    expect(readFileSync(join(directory, "index.html"), "utf8")).not.toContain("Content-Security-Policy");
    expect(fileHashes(directory)).toEqual(before);
  });

  it("recognizes an explicit version-one projection", () => {
    const directory = legacyBundle("v1");
    const manifest = manifestAt(directory);
    manifest.presentationVersion = 1;
    manifest.trajectoryVersion = 2;
    saveManifest(directory, manifest);
    expect(verifyLocalReport(directory).result.identity.runId).toBe("run_compat001");
  });

  it("explains unsupported old redaction envelopes without accepting or rewriting them", () => {
    const directory = legacyBundle("initial");
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    manifest.redaction.policy = "safe_fields_v1";
    delete manifest.projectedRunResultHash;
    delete manifest.projectedEvidenceHash;
    delete manifest.projectedTrajectoryHash;
    saveManifest(directory, manifest);
    const before = fileHashes(directory);
    expect(() => verifyLocalReport(directory)).toThrowError(
      expect.objectContaining({
        code: "reporter.VERSION_UNSUPPORTED",
        message: expect.stringContaining("older report format (safe_fields_v1) is not supported"),
      }),
    );
    expect(fileHashes(directory)).toEqual(before);
  });

  it.each(["broken-json", "incomplete-legacy-envelope"] as const)(
    "still rejects a genuinely malformed manifest: %s",
    (kind) => {
      const directory = legacyBundle("initial");
      writeFileSync(
        join(directory, "manifest.json"),
        kind === "broken-json" ? "{not json" : JSON.stringify({ redaction: { policy: "safe_fields_v1" } }),
      );
      const before = fileHashes(directory);
      expect(() => verifyLocalReport(directory)).toThrowError(
        expect.objectContaining({ code: "reporter.MANIFEST_INVALID" }),
      );
      expect(fileHashes(directory)).toEqual(before);
    },
  );

  it.each(["presentationVersion", "trajectoryVersion"] as const)("rejects an unknown %s", (field) => {
    const directory = legacyBundle("v1");
    const manifest = manifestAt(directory);
    manifest[field] = 999;
    saveManifest(directory, manifest);
    expect(() => verifyLocalReport(directory)).toThrowError(
      expect.objectContaining({ code: "reporter.VERSION_UNSUPPORTED" }),
    );
  });

  it.each(["initial", "v1", "v2"] as const)("rejects rehashed misleading HTML in %s reports", (version) => {
    const directory = legacyBundle(version);
    const manifest = manifestAt(directory);
    const artifact = manifest.artifacts.find((entry) => entry.path === "index.html");
    if (artifact === undefined) throw new Error("fixture has no HTML artifact");
    const changed = readFileSync(join(directory, "index.html"), "utf8").replace("passed", "failed");
    writeFileSync(join(directory, "index.html"), changed);
    artifact.bytes = Buffer.byteLength(changed);
    artifact.hash = hash(changed);
    saveManifest(directory, manifest);
    expect(() => verifyLocalReport(directory)).toThrowError(
      expect.objectContaining({ code: "reporter.REPORT_INVALID" }),
    );
  });

  it("does not fall back to a different trajectory algorithm when an explicit version disagrees", () => {
    const directory = legacyBundle("initial");
    const manifest = manifestAt(directory);
    manifest.trajectoryVersion = 2;
    saveManifest(directory, manifest);
    expect(() => verifyLocalReport(directory)).toThrowError(
      expect.objectContaining({ code: "reporter.SOURCE_HASH_MISMATCH" }),
    );
  });
});
