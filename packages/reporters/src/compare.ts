import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssertionResult,
  EvidenceEntry,
  JsonObject,
  JsonValue,
  ReportRedaction,
  RunResult,
} from "@firedrill/contracts";
import { canonicalJson } from "@firedrill/contracts";
import { verifyLocalReport } from "./reporters.js";

export type LocalRunCompatibilityStatus = "exact_inputs" | "descriptive_only" | "incompatible";

export interface LocalRunCompatibility {
  readonly status: LocalRunCompatibilityStatus;
  /** True only when world inputs match closely enough to attribute a behavioral delta to the agent/target. */
  readonly canAttributeBehaviorChange: boolean;
  readonly differences: readonly (
    | "drill"
    | "scenario"
    | "target"
    | "seed"
    | "build"
    | "package_lock"
    | "runtime_controls"
  )[];
  readonly explanation: string;
}

export interface ComparedRun {
  readonly reportDirectory: string;
  readonly runId: string;
  readonly status: RunResult["status"];
  readonly verdict?: "passed" | "failed" | "inconclusive";
  readonly drillId: string;
  readonly scenarioId?: string;
  readonly targetId: string;
  readonly seed: string;
  readonly buildHash: string;
  readonly packageLockHash: string;
  readonly stateHash?: string;
  readonly trajectoryHash?: string;
}

export interface CountDelta {
  readonly subject: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
}

export interface OperationDelta extends CountDelta {
  readonly baselineErrors: number;
  readonly candidateErrors: number;
}

export interface AssertionDelta {
  readonly checkpointId: string;
  readonly assertionId: string;
  readonly baseline?: AssertionResult["status"];
  readonly candidate?: AssertionResult["status"];
  readonly actualChanged: boolean;
  readonly expectedChanged?: boolean;
}

export interface InteractionDelta {
  readonly interactionId: string;
  readonly baseline?: string;
  readonly candidate?: string;
}

export interface LocalRunComparison {
  readonly schemaVersion: 1;
  readonly compatibility: LocalRunCompatibility;
  readonly outcome: "unchanged" | "changed" | "not_comparable";
  readonly baseline: ComparedRun;
  readonly candidate: ComparedRun;
  readonly changes: {
    readonly verdictChanged: boolean;
    readonly stateChanged?: boolean;
    readonly trajectoryChanged?: boolean;
    readonly operationCounts: readonly OperationDelta[];
    readonly stateChangeCounts: readonly CountDelta[];
    readonly eventCounts: readonly CountDelta[];
    readonly assertions: readonly AssertionDelta[];
    readonly interactions: readonly InteractionDelta[];
  };
}

function side(directory: string, result: RunResult): ComparedRun {
  return {
    reportDirectory: directory,
    runId: result.identity.runId,
    status: result.status,
    ...(result.status === "sealed" ? { verdict: result.verdict } : {}),
    drillId: result.identity.drillId,
    ...(result.identity.scenarioId === undefined ? {} : { scenarioId: result.identity.scenarioId }),
    targetId: result.identity.targetId,
    seed: result.identity.seed,
    buildHash: result.identity.buildHash,
    packageLockHash: result.identity.packageLockHash,
    ...(result.status === "sealed"
      ? { stateHash: result.stateHash, trajectoryHash: result.trajectoryHash }
      : {}),
  };
}

function compatibility(
  baseline: RunResult,
  candidate: RunResult,
  baselineEvidence: readonly EvidenceEntry[],
  candidateEvidence: readonly EvidenceEntry[],
): LocalRunCompatibility {
  const differences: LocalRunCompatibility["differences"][number][] = [];
  if (baseline.identity.drillId !== candidate.identity.drillId) differences.push("drill");
  if (baseline.identity.scenarioId !== candidate.identity.scenarioId) differences.push("scenario");
  if (baseline.identity.targetId !== candidate.identity.targetId) differences.push("target");
  if (baseline.identity.seed !== candidate.identity.seed) differences.push("seed");
  if (baseline.identity.buildHash !== candidate.identity.buildHash) differences.push("build");
  if (baseline.identity.packageLockHash !== candidate.identity.packageLockHash)
    differences.push("package_lock");
  const controls = (entries: readonly EvidenceEntry[]) =>
    entries
      .filter((entry) => entry.kind === "fault_control")
      .map((entry) => ({
        sequence: entry.sequence,
        virtualTimeUs: entry.virtualTimeUs,
        packageId: entry.packageId,
        faultId: entry.faultId,
        previouslyActive: entry.previouslyActive,
        active: entry.active,
      }));
  const baselineControls = controls(baselineEvidence);
  const candidateControls = controls(candidateEvidence);
  if (canonicalJson(baselineControls) !== canonicalJson(candidateControls))
    differences.push("runtime_controls");

  if (
    differences.some(
      (item) => item === "drill" || item === "scenario" || item === "target" || item === "seed",
    )
  ) {
    return {
      status: "incompatible",
      canAttributeBehaviorChange: false,
      differences,
      explanation:
        "The drill, scenario, target, or seed differs. The runs are not a controlled behavioral comparison.",
    };
  }
  if (baselineControls.length > 0 || candidateControls.length > 0) {
    return {
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      differences,
      explanation:
        "Runtime fault controls were supplied by a harness, not the immutable world inputs. Even matching recorded controls do not prove the harness schedule matches. Deltas cannot be attributed solely to the agent.",
    };
  }
  if (differences.length > 0) {
    return {
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      differences,
      explanation:
        "The world build or package lock differs. Deltas are factual, but they cannot be attributed solely to the agent.",
    };
  }
  return {
    status: "exact_inputs",
    canAttributeBehaviorChange: true,
    differences,
    explanation:
      "Drill, scenario, target, seed, world build, and package lock match. Behavioral deltas can be attributed to the target execution boundary.",
  };
}

function countBy(values: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function reportCompatibility(
  baseline: ReturnType<typeof verifyLocalReport>,
  candidate: ReturnType<typeof verifyLocalReport>,
): LocalRunCompatibility {
  const grade = compatibility(baseline.result, candidate.result, baseline.evidence, candidate.evidence);
  if (
    grade.status !== "incompatible" &&
    (baseline.manifest.redaction.applied || candidate.manifest.redaction.applied)
  )
    return {
      ...grade,
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      explanation: `${grade.status === "exact_inputs" ? "The recorded immutable input identities match." : grade.explanation} At least one retained report contains redacted values. Differences are descriptive: redaction can conceal or transform source values, and matching retained values do not prove the original values match.`,
    };
  return grade;
}

function countDeltas(
  baseline: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
): readonly CountDelta[] {
  const subjects = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  return subjects
    .map((subject) => {
      const before = baseline.get(subject) ?? 0;
      const after = candidate.get(subject) ?? 0;
      return { subject, baseline: before, candidate: after, delta: after - before };
    })
    .filter((change) => change.delta !== 0);
}

function operationSummary(evidence: readonly EvidenceEntry[]) {
  const operations = evidence.filter((entry) => entry.kind === "operation");
  const names = operations.map(
    (entry) => `${entry.invocation.operation.packageId}.${entry.invocation.operation.operationId}`,
  );
  const errors = operations
    .filter((entry) => entry.outcome.status !== "ok")
    .map((entry) => `${entry.invocation.operation.packageId}.${entry.invocation.operation.operationId}`);
  return { counts: countBy(names), errors: countBy(errors) };
}

function operationDeltas(
  baselineEvidence: readonly EvidenceEntry[],
  candidateEvidence: readonly EvidenceEntry[],
): readonly OperationDelta[] {
  const baseline = operationSummary(baselineEvidence);
  const candidate = operationSummary(candidateEvidence);
  const subjects = [
    ...new Set([
      ...baseline.counts.keys(),
      ...candidate.counts.keys(),
      ...baseline.errors.keys(),
      ...candidate.errors.keys(),
    ]),
  ].sort();
  return subjects
    .map((subject) => {
      const before = baseline.counts.get(subject) ?? 0;
      const after = candidate.counts.get(subject) ?? 0;
      return {
        subject,
        baseline: before,
        candidate: after,
        delta: after - before,
        baselineErrors: baseline.errors.get(subject) ?? 0,
        candidateErrors: candidate.errors.get(subject) ?? 0,
      };
    })
    .filter((change) => change.delta !== 0 || change.baselineErrors !== change.candidateErrors);
}

function assertionMap(result: RunResult): ReadonlyMap<string, AssertionResult> {
  const assertions = new Map<string, AssertionResult>();
  for (const checkpoint of result.checkpoints) {
    for (const assertion of checkpoint.assertionResults) {
      assertions.set(`${checkpoint.checkpointId}/${assertion.assertionId}`, assertion);
    }
  }
  return assertions;
}

function assertionDeltas(baseline: RunResult, candidate: RunResult): readonly AssertionDelta[] {
  const before = assertionMap(baseline);
  const after = assertionMap(candidate);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((key) => {
      const [checkpointId = "unknown", assertionId = "unknown"] = key.split("/", 2);
      const left = before.get(key);
      const right = after.get(key);
      const leftActual = left?.actual as JsonValue | undefined;
      const rightActual = right?.actual as JsonValue | undefined;
      const actualChanged =
        leftActual === undefined || rightActual === undefined
          ? leftActual !== rightActual
          : canonicalJson(leftActual) !== canonicalJson(rightActual);
      const expectedChanged =
        left === undefined || right === undefined
          ? left !== right
          : canonicalJson(left.expected) !== canonicalJson(right.expected);
      return {
        checkpointId,
        assertionId,
        ...(left === undefined ? {} : { baseline: left.status }),
        ...(right === undefined ? {} : { candidate: right.status }),
        actualChanged,
        expectedChanged,
      };
    })
    .filter(
      (change) => change.baseline !== change.candidate || change.actualChanged || change.expectedChanged,
    );
}

function interactionDeltas(baseline: RunResult, candidate: RunResult): readonly InteractionDelta[] {
  const before = new Map(
    baseline.interactions.map((interaction) => [interaction.interactionId, interaction.targetResult.status]),
  );
  const after = new Map(
    candidate.interactions.map((interaction) => [interaction.interactionId, interaction.targetResult.status]),
  );
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((interactionId) => {
      const baselineStatus = before.get(interactionId);
      const candidateStatus = after.get(interactionId);
      return {
        interactionId,
        ...(baselineStatus === undefined ? {} : { baseline: baselineStatus }),
        ...(candidateStatus === undefined ? {} : { candidate: candidateStatus }),
      };
    })
    .filter((change) => change.baseline !== change.candidate);
}

/**
 * Verifies and compares two local report bundles. It never infers improvement or
 * regression; callers receive factual deltas plus an explicit compatibility grade.
 */
export function compareLocalReports(
  baselineDirectory: string,
  candidateDirectory: string,
): LocalRunComparison {
  const baseline = verifyLocalReport(baselineDirectory);
  const candidate = verifyLocalReport(candidateDirectory);
  const grade = reportCompatibility(baseline, candidate);
  const operations = operationDeltas(baseline.evidence, candidate.evidence);
  const stateChanges = countDeltas(
    countBy(
      baseline.evidence
        .filter((entry) => entry.kind === "state_change")
        .map((entry) => `${entry.packageId}.${entry.namespace}/${entry.rowId}`),
    ),
    countBy(
      candidate.evidence
        .filter((entry) => entry.kind === "state_change")
        .map((entry) => `${entry.packageId}.${entry.namespace}/${entry.rowId}`),
    ),
  );
  const events = countDeltas(
    countBy(
      baseline.evidence
        .filter((entry) => entry.kind === "event")
        .map((entry) => `${entry.event.packageId}.${entry.event.eventId}`),
    ),
    countBy(
      candidate.evidence
        .filter((entry) => entry.kind === "event")
        .map((entry) => `${entry.event.packageId}.${entry.event.eventId}`),
    ),
  );
  const assertions = assertionDeltas(baseline.result, candidate.result);
  const interactions = interactionDeltas(baseline.result, candidate.result);
  const verdictChanged =
    baseline.result.status !== candidate.result.status ||
    (baseline.result.status === "sealed" &&
      candidate.result.status === "sealed" &&
      baseline.result.verdict !== candidate.result.verdict);
  const stateChanged =
    baseline.result.status === "sealed" && candidate.result.status === "sealed"
      ? baseline.result.stateHash !== candidate.result.stateHash
      : undefined;
  const trajectoryChanged =
    baseline.result.status === "sealed" && candidate.result.status === "sealed"
      ? baseline.result.trajectoryHash !== candidate.result.trajectoryHash
      : undefined;
  const changed =
    verdictChanged ||
    stateChanged === true ||
    trajectoryChanged === true ||
    operations.length > 0 ||
    stateChanges.length > 0 ||
    events.length > 0 ||
    assertions.length > 0 ||
    interactions.length > 0;

  return {
    schemaVersion: 1,
    compatibility: grade,
    outcome: grade.status === "incompatible" ? "not_comparable" : changed ? "changed" : "unchanged",
    baseline: side(baseline.directory, baseline.result),
    candidate: side(candidate.directory, candidate.result),
    changes: {
      verdictChanged,
      ...(stateChanged === undefined ? {} : { stateChanged }),
      ...(trajectoryChanged === undefined ? {} : { trajectoryChanged }),
      operationCounts: operations,
      stateChangeCounts: stateChanges,
      eventCounts: events,
      assertions,
      interactions,
    },
  };
}

export type RunComparisonDetailKind = "state_changes" | "operations" | "assertions";
export type RecordedComparisonValue =
  | {
      readonly state: "available";
      readonly value: JsonValue;
      readonly bytes: number;
      readonly digest: string;
    }
  | {
      readonly state: "omitted";
      readonly reason: "size_limit";
      readonly bytes: number;
      readonly digest: string;
    }
  | { readonly state: "absent" };
interface DetailFields {
  readonly key: string;
  readonly changedFields: readonly string[];
  readonly baseline: RecordedComparisonValue;
  readonly candidate: RecordedComparisonValue;
}
export type RunComparisonDetailItem = DetailFields &
  (
    | {
        readonly kind: "state_changes";
        readonly identity: {
          readonly packageId: string;
          readonly namespace: string;
          readonly rowId: string;
          readonly mutation: number;
        };
      }
    | { readonly kind: "operations"; readonly identity: { readonly position: number } }
    | {
        readonly kind: "assertions";
        readonly identity: { readonly checkpointId: string; readonly assertionId: string };
      }
  );
export interface LocalRunComparisonDetailPage {
  readonly schemaVersion: 1;
  readonly baseline: {
    readonly runId: string;
    readonly manifestDigest: string;
    readonly redaction: ReportRedaction;
  };
  readonly candidate: {
    readonly runId: string;
    readonly manifestDigest: string;
    readonly redaction: ReportRedaction;
  };
  readonly compatibility: LocalRunCompatibility;
  readonly kind: RunComparisonDetailKind;
  readonly alignment: string;
  readonly offset: number;
  readonly total: number;
  readonly items: readonly RunComparisonDetailItem[];
  readonly nextOffset?: number;
}
export interface LocalRunComparisonDetailOptions {
  readonly kind: RunComparisonDetailKind;
  /** Offset into changed entries, not raw evidence. */
  readonly offset?: number;
  readonly limit?: number;
}

const DETAIL_VALUE_BYTES = 16_384;
const detailAlignment: Record<RunComparisonDetailKind, string> = {
  state_changes:
    "Recorded mutations align by exact package, namespace, record ID and per-record mutation ordinal. Includes seed loading and later mutations; not agent-only changes or reconstructed final state. Absent means no recorded mutation at that ordinal, not a deleted or missing world record.",
  operations:
    "Calls align by one-based position among recorded operation entries, not inferred causal correspondence or a best-match edit script. Insertions shift later positions. Arguments, outcomes, actor, idempotency and overrides are compared; incidental evidence identities and timing are not. Absent means no recorded call at that position.",
  assertions:
    "Recorded checks align by exact checkpoint and assertion ID. Expected conditions, actual values and recorded result fields are compared without evaluating any assertion. Absent means the check was not recorded at that checkpoint.",
};
function json(value: unknown): JsonValue {
  return value as JsonValue;
}
function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function recordedValue(value: unknown | undefined): RecordedComparisonValue {
  if (value === undefined) return { state: "absent" };
  const encoded = canonicalJson(json(value));
  const bytes = Buffer.byteLength(encoded, "utf8");
  const hash = digest(encoded);
  return bytes > DETAIL_VALUE_BYTES
    ? { state: "omitted", reason: "size_limit", bytes, digest: hash }
    : { state: "available", value: json(value), bytes, digest: hash };
}
function changedFields(before: JsonObject | undefined, after: JsonObject | undefined): string[] {
  if (before === undefined || after === undefined) return ["presence"];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((key) => {
    const left = before[key],
      right = after[key];
    return left === undefined || right === undefined
      ? left !== right
      : canonicalJson(left) !== canonicalJson(right);
  });
}
interface DetailEntry {
  readonly identity: RunComparisonDetailItem["identity"];
  readonly recorded: unknown;
  readonly semantic: JsonObject;
}
function detailEntries(
  report: ReturnType<typeof verifyLocalReport>,
  kind: RunComparisonDetailKind,
): Map<string, DetailEntry> {
  const entries = new Map<string, DetailEntry>();
  if (kind === "assertions") {
    for (const checkpoint of report.result.checkpoints)
      for (const result of checkpoint.assertionResults) {
        const identity = { checkpointId: checkpoint.checkpointId, assertionId: result.assertionId };
        const key = canonicalJson([identity.checkpointId, identity.assertionId]);
        if (entries.has(key))
          throw new TypeError("recorded comparison has duplicate checkpoint/assertion identity");
        entries.set(key, {
          identity,
          recorded: result,
          semantic: {
            kind: result.kind,
            status: result.status,
            gate: result.gate,
            message: result.message,
            expected: result.expected,
            actual: result.actual,
            location: json(result.location),
            diff: json(result.diff),
          },
        });
      }
    return entries;
  }
  const mutationCounts = new Map<string, number>();
  let position = 0;
  for (const entry of report.evidence) {
    if (kind === "operations" && entry.kind === "operation") {
      position += 1;
      const identity = { position };
      entries.set(String(position), {
        identity,
        recorded: entry,
        semantic: {
          operation: json(entry.invocation.operation),
          arguments: entry.invocation.arguments,
          ...(entry.invocation.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: entry.invocation.idempotencyKey }),
          outcome: json(entry.outcome),
          idempotency: entry.idempotency,
          ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
          ...(entry.toolOverride === undefined ? {} : { toolOverride: json(entry.toolOverride) }),
        },
      });
    } else if (kind === "state_changes" && entry.kind === "state_change") {
      const subject = canonicalJson([entry.packageId, entry.namespace, entry.rowId]);
      const mutation = (mutationCounts.get(subject) ?? 0) + 1;
      mutationCounts.set(subject, mutation);
      const identity = {
        packageId: entry.packageId,
        namespace: entry.namespace,
        rowId: entry.rowId,
        mutation,
      };
      const key = canonicalJson([entry.packageId, entry.namespace, entry.rowId, mutation]);
      entries.set(key, {
        identity,
        recorded: entry,
        semantic: { change: entry.change, before: entry.before, after: entry.after },
      });
    }
  }
  return entries;
}

/** Bounded factual detail over two fully verified, already-redacted report bundles.
 * It never reconstructs unrecorded state, unredacts values, aligns calls causally,
 * evaluates checks or modifies either report. Each value is at most 16 KiB; larger
 * values retain their exact canonical-JSON byte count and SHA-256, not a prefix. */
export function compareLocalReportDetails(
  baselineDirectory: string,
  candidateDirectory: string,
  options: LocalRunComparisonDetailOptions,
): LocalRunComparisonDetailPage {
  const { kind, offset = 0, limit = 10 } = options;
  if (
    !Object.hasOwn(detailAlignment, kind) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 25
  )
    throw new TypeError(
      "comparison details require a supported kind, nonnegative safe offset, and limit 1–25",
    );
  const baseline = verifyLocalReport(baselineDirectory),
    candidate = verifyLocalReport(candidateDirectory);
  const before = detailEntries(baseline, kind),
    after = detailEntries(candidate, kind);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => {
    if (kind === "operations") return Number(left) - Number(right);
    if (kind === "state_changes") {
      const a = before.get(left) ?? after.get(left),
        b = before.get(right) ?? after.get(right);
      const x = a?.identity as { packageId: string; namespace: string; rowId: string; mutation: number };
      const y = b?.identity as typeof x;
      const xSubject = canonicalJson([x.packageId, x.namespace, x.rowId]),
        ySubject = canonicalJson([y.packageId, y.namespace, y.rowId]);
      return xSubject < ySubject ? -1 : xSubject > ySubject ? 1 : x.mutation - y.mutation;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const items: RunComparisonDetailItem[] = [];
  let total = 0;
  for (const key of keys) {
    const left = before.get(key),
      right = after.get(key);
    const fields = changedFields(left?.semantic, right?.semantic);
    if (!fields.length) continue;
    if (total >= offset && items.length < limit) {
      const entry = left ?? right;
      if (!entry) throw new TypeError("comparison identity is missing");
      items.push({
        kind,
        key,
        identity: entry.identity,
        changedFields: fields,
        baseline: recordedValue(left?.recorded),
        candidate: recordedValue(right?.recorded),
      } as RunComparisonDetailItem);
    }
    total += 1;
  }
  if (offset > total) throw new TypeError("comparison detail offset exceeds changed entry count");
  const identity = (report: ReturnType<typeof verifyLocalReport>) => ({
    runId: report.result.identity.runId,
    manifestDigest: digest(readFileSync(join(report.directory, "manifest.json"))),
    redaction: report.manifest.redaction,
  });
  return {
    schemaVersion: 1,
    baseline: identity(baseline),
    candidate: identity(candidate),
    compatibility: reportCompatibility(baseline, candidate),
    kind,
    alignment: detailAlignment[kind],
    offset,
    total,
    items,
    ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}),
  };
}
