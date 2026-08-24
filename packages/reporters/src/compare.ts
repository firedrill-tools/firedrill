import { canonicalJson } from "@firedrill/contracts";
import type { AssertionResult, EvidenceEntry, JsonValue, RunResult } from "@firedrill/contracts";
import { verifyLocalReport } from "./reporters.js";

export type LocalRunCompatibilityStatus = "exact_inputs" | "descriptive_only" | "incompatible";

export interface LocalRunCompatibility {
  readonly status: LocalRunCompatibilityStatus;
  /** True only when world inputs match closely enough to attribute a behavioral delta to the agent/target. */
  readonly canAttributeBehaviorChange: boolean;
  readonly differences: readonly ("drill" | "scenario" | "target" | "seed" | "build" | "package_lock")[];
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

function compatibility(baseline: RunResult, candidate: RunResult): LocalRunCompatibility {
  const differences: LocalRunCompatibility["differences"][number][] = [];
  if (baseline.identity.drillId !== candidate.identity.drillId) differences.push("drill");
  if (baseline.identity.scenarioId !== candidate.identity.scenarioId) differences.push("scenario");
  if (baseline.identity.targetId !== candidate.identity.targetId) differences.push("target");
  if (baseline.identity.seed !== candidate.identity.seed) differences.push("seed");
  if (baseline.identity.buildHash !== candidate.identity.buildHash) differences.push("build");
  if (baseline.identity.packageLockHash !== candidate.identity.packageLockHash)
    differences.push("package_lock");

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
      return {
        checkpointId,
        assertionId,
        ...(left === undefined ? {} : { baseline: left.status }),
        ...(right === undefined ? {} : { candidate: right.status }),
        actualChanged,
      };
    })
    .filter((change) => change.baseline !== change.candidate || change.actualChanged);
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
  const grade = compatibility(baseline.result, candidate.result);
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
