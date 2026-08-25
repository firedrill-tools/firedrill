import { isDeepStrictEqual } from "node:util";
import { AssertionResultSchema } from "@firedrill/contracts";
import type {
  AssertionDefinition,
  AssertionDiff,
  AssertionLocation,
  AssertionResult,
  EvidenceEntry,
  JsonObject,
  JsonValue,
  OperationEvidence,
  OperationRef,
} from "@firedrill/contracts";
import type { StateScanOptions, StoredStateRecord } from "@firedrill/world-store";
import { AssertionEvidenceIndex } from "./evidence-index.js";

export interface AssertionStateReader {
  readState(packageId: string, namespace: string, rowId: string): StoredStateRecord | null;
  scanState(packageId: string, namespace: string, options?: StateScanOptions): readonly StoredStateRecord[];
}

export interface EvaluateAssertionsInput {
  readonly assertions: readonly AssertionDefinition[];
  readonly state: AssertionStateReader;
  /** Evidence must already be scoped to this drill run and ordered by sequence. */
  readonly evidence: readonly EvidenceEntry[] | AssertionEvidenceIndex;
}

type Comparison = Extract<AssertionDefinition, { kind: "state.value" }>["comparison"];
type NumericComparison = Extract<AssertionDefinition, { kind: "state.count" }>["comparison"];

interface PathResult {
  readonly found: boolean;
  readonly value: JsonValue | null;
}

function operationEqual(left: OperationRef, right: OperationRef): boolean {
  return left.packageId === right.packageId && left.operationId === right.operationId;
}

function partialMatch(actual: JsonValue, expected: JsonValue): boolean {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => {
    if (!(key in actual)) return false;
    return partialMatch(actual[key] as JsonValue, value);
  });
}

function valueAtPath(value: JsonValue, path: readonly (string | number)[]): PathResult {
  let current: JsonValue = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { found: false, value: null };
      const child = current[segment];
      if (child === undefined) return { found: false, value: null };
      current = child;
      continue;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return { found: false, value: null };
    }
    if (!Object.hasOwn(current, segment)) return { found: false, value: null };
    const child = current[segment];
    if (child === undefined) return { found: false, value: null };
    current = child;
  }
  return { found: true, value: current };
}

function compareValue(actual: JsonValue, comparison: Comparison): boolean {
  if (comparison.operator === "equals") return isDeepStrictEqual(actual, comparison.value);
  if (comparison.operator === "not_equals") return !isDeepStrictEqual(actual, comparison.value);
  if (comparison.operator === "one_of") {
    return comparison.value.some((candidate) => isDeepStrictEqual(actual, candidate));
  }
  if (typeof actual !== "number") return false;
  return comparison.operator === "greater_than_or_equal"
    ? actual >= comparison.value
    : actual <= comparison.value;
}

function compareNumber(actual: number, comparison: NumericComparison): boolean {
  if (comparison.operator === "equals") return actual === comparison.value;
  if (comparison.operator === "not_equals") return actual !== comparison.value;
  return comparison.operator === "greater_than_or_equal"
    ? actual >= comparison.value
    : actual <= comparison.value;
}

function stateLocation(
  packageId: string,
  namespace: string,
  rowId?: string,
  path: readonly (string | number)[] = [],
): AssertionLocation {
  return {
    subject: "state",
    packageId,
    namespace,
    ...(rowId === undefined ? {} : { rowId }),
    path: [...path],
  };
}

function operationLocation(operations: readonly OperationRef[], occurrence?: number): AssertionLocation {
  return {
    subject: "operation",
    operations: [...operations],
    ...(occurrence === undefined ? {} : { occurrence }),
  };
}

function result(input: {
  readonly assertion: AssertionDefinition;
  readonly matched: boolean;
  readonly message: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
  readonly location: AssertionLocation;
  readonly operator: AssertionDiff["operator"];
  readonly details?: JsonObject;
  readonly evidenceSequences?: readonly number[];
}): AssertionResult {
  return AssertionResultSchema.parse({
    schemaVersion: 1,
    assertionId: input.assertion.id,
    kind: input.assertion.kind,
    status: input.matched ? "passed" : "failed",
    gate: input.assertion.gate,
    message: input.message,
    expected: input.expected,
    actual: input.actual,
    location: input.location,
    diff: {
      operator: input.operator,
      matched: input.matched,
      details: input.details ?? {},
    },
    evidenceSequences: [...new Set(input.evidenceSequences ?? [])].sort((left, right) => left - right),
  });
}

function stateEvidence(
  evidence: AssertionEvidenceIndex,
  packageId: string,
  namespace: string,
  rowId?: string,
): readonly number[] {
  return evidence.stateSequences(packageId, namespace, rowId);
}

function allState(
  state: AssertionStateReader,
  packageId: string,
  namespace: string,
): readonly StoredStateRecord[] {
  const records: StoredStateRecord[] = [];
  let afterRowId: string | undefined;
  for (;;) {
    const page = state.scanState(packageId, namespace, {
      ...(afterRowId === undefined ? {} : { afterRowId }),
      limit: 1_000,
    });
    records.push(...page);
    if (page.length < 1_000) return records;
    const last = page.at(-1);
    if (last === undefined || last.rowId === afterRowId) {
      throw new Error("state reader did not advance its pagination cursor");
    }
    afterRowId = last.rowId;
  }
}

interface OperationEvidenceFilter {
  readonly actorId?: string;
  readonly outcomes?: readonly OperationEvidence["outcome"]["status"][];
  readonly idempotency?: readonly OperationEvidence["idempotency"][];
}

function normalizedOperationFilter(input: {
  readonly actorId?: string | undefined;
  readonly outcomes?: readonly OperationEvidence["outcome"]["status"][] | undefined;
  readonly idempotency?: readonly OperationEvidence["idempotency"][] | undefined;
}): OperationEvidenceFilter {
  return {
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.outcomes === undefined ? {} : { outcomes: input.outcomes }),
    ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
  };
}

function matchesOperationEvidence(entry: OperationEvidence, filter: OperationEvidenceFilter): boolean {
  return (
    (filter.actorId === undefined || entry.actorId === filter.actorId) &&
    (filter.outcomes === undefined || filter.outcomes.includes(entry.outcome.status)) &&
    (filter.idempotency === undefined || filter.idempotency.includes(entry.idempotency))
  );
}

function operationFilterDetails(filter: OperationEvidenceFilter): JsonObject {
  return {
    ...(filter.actorId === undefined ? {} : { actorId: filter.actorId }),
    ...(filter.outcomes === undefined ? {} : { outcomes: [...filter.outcomes] }),
    ...(filter.idempotency === undefined ? {} : { idempotency: [...filter.idempotency] }),
  };
}

function operationAttempt(entry: OperationEvidence): JsonObject {
  return {
    sequence: entry.sequence,
    operation: entry.invocation.operation,
    outcome: entry.outcome.status,
    idempotency: entry.idempotency,
    ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
    ...(entry.outcome.error === undefined ? {} : { errorCode: entry.outcome.error.code }),
  };
}

function evaluateOne(
  assertion: AssertionDefinition,
  state: AssertionStateReader,
  evidence: AssertionEvidenceIndex,
): AssertionResult {
  if (assertion.kind === "state.value") {
    const record = state.readState(assertion.packageId, assertion.namespace, assertion.rowId);
    const selected =
      record === null ? { found: false, value: null } : valueAtPath(record.value, assertion.path);
    const matched = selected.found && compareValue(selected.value, assertion.comparison);
    return result({
      assertion,
      matched,
      message: matched ? "state value matched" : "state value did not match",
      expected: assertion.comparison,
      actual: selected.value,
      location: stateLocation(assertion.packageId, assertion.namespace, assertion.rowId, assertion.path),
      operator: assertion.comparison.operator,
      details: { missing: !selected.found },
      evidenceSequences: stateEvidence(evidence, assertion.packageId, assertion.namespace, assertion.rowId),
    });
  }

  if (assertion.kind === "state.count") {
    const records = allState(state, assertion.packageId, assertion.namespace);
    const count =
      assertion.where === undefined
        ? records.length
        : records.filter((record) => partialMatch(record.value, assertion.where ?? {})).length;
    const matched = compareNumber(count, assertion.comparison);
    return result({
      assertion,
      matched,
      message: matched ? "state record count matched" : "state record count did not match",
      expected: assertion.comparison,
      actual: count,
      location: stateLocation(assertion.packageId, assertion.namespace),
      operator: assertion.comparison.operator,
      ...(assertion.where === undefined ? {} : { details: { where: assertion.where } }),
      evidenceSequences: stateEvidence(evidence, assertion.packageId, assertion.namespace),
    });
  }

  if (assertion.kind === "operation.count") {
    const filter = {
      ...(assertion.actorId === undefined ? {} : { actorId: assertion.actorId }),
      ...(assertion.outcomes === undefined ? {} : { outcomes: assertion.outcomes }),
      ...(assertion.idempotency === undefined ? {} : { idempotency: assertion.idempotency }),
    };
    const attempts = evidence
      .operation(assertion.operation)
      .filter((entry) => matchesOperationEvidence(entry, filter));
    const matched = compareNumber(attempts.length, assertion.comparison);
    return result({
      assertion,
      matched,
      message: matched ? "operation count matched" : "operation count did not match",
      expected: assertion.comparison,
      actual: attempts.length,
      location: operationLocation([assertion.operation]),
      operator: assertion.comparison.operator,
      details: operationFilterDetails(filter),
      evidenceSequences: attempts.map((entry) => entry.sequence),
    });
  }

  if (assertion.kind === "operation.order") {
    const attempts = evidence.allOperations();
    const expectedSequence = assertion.sequence.map((step) => ({
      anyOf: step.anyOf,
      ...operationFilterDetails(normalizedOperationFilter(step)),
    }));
    let cursor = 0;
    const matchedSequences: number[] = [];
    for (const step of assertion.sequence) {
      const index = attempts.findIndex(
        (entry, candidate) =>
          candidate >= cursor &&
          step.anyOf.some((operation) => operationEqual(entry.invocation.operation, operation)) &&
          matchesOperationEvidence(entry, normalizedOperationFilter(step)),
      );
      if (index < cursor) {
        return result({
          assertion,
          matched: false,
          message: "operation sequence was not observed in order",
          expected: expectedSequence,
          actual: attempts.map(operationAttempt),
          location: operationLocation(assertion.sequence.flatMap((step) => step.anyOf)),
          operator: "contains_in_order",
          details: { matchedSteps: matchedSequences.length, totalSteps: assertion.sequence.length },
          evidenceSequences: matchedSequences,
        });
      }
      const entry = attempts[index];
      if (entry !== undefined) matchedSequences.push(entry.sequence);
      cursor = index + 1;
    }
    return result({
      assertion,
      matched: true,
      message: "operation sequence was observed in order",
      expected: expectedSequence,
      actual: attempts.map(operationAttempt),
      location: operationLocation(assertion.sequence.flatMap((step) => step.anyOf)),
      operator: "contains_in_order",
      details: { matchedSteps: matchedSequences.length, totalSteps: assertion.sequence.length },
      evidenceSequences: matchedSequences,
    });
  }

  if (assertion.kind === "operation.arguments") {
    const filter = {
      ...(assertion.actorId === undefined ? {} : { actorId: assertion.actorId }),
      outcomes: assertion.outcomes,
      ...(assertion.idempotency === undefined ? {} : { idempotency: assertion.idempotency }),
    };
    const attempts = evidence
      .operation(assertion.operation)
      .filter((entry) => matchesOperationEvidence(entry, filter));
    const attempt = attempts[assertion.occurrence - 1];
    const actual = attempt?.invocation.arguments ?? null;
    const matched = attempt !== undefined && partialMatch(actual, assertion.contains);
    return result({
      assertion,
      matched,
      message: matched
        ? "operation arguments contained the expected value"
        : "operation arguments did not match",
      expected: assertion.contains,
      actual,
      location: operationLocation([assertion.operation], assertion.occurrence),
      operator: "contains",
      details: { occurrenceFound: attempt !== undefined, ...operationFilterDetails(filter) },
      evidenceSequences: attempt === undefined ? [] : [attempt.sequence],
    });
  }

  if (assertion.kind === "operation.denied") {
    const outcomes =
      assertion.outcomes ?? (assertion.errorCode?.startsWith("tool.") === true ? ["tool_error"] : ["denied"]);
    const filter = {
      ...(assertion.actorId === undefined ? {} : { actorId: assertion.actorId }),
      ...(assertion.idempotency === undefined ? {} : { idempotency: assertion.idempotency }),
    };
    const attempts = evidence
      .operation(assertion.operation)
      .filter((entry) => matchesOperationEvidence(entry, filter));
    const allDenied = attempts.every(
      (entry) =>
        outcomes.includes(entry.outcome.status as "denied" | "tool_error") &&
        (assertion.errorCode === undefined || entry.outcome.error?.code === assertion.errorCode),
    );
    const matched = allDenied && (!assertion.attemptRequired || attempts.length > 0);
    return result({
      assertion,
      matched,
      message: matched ? "all operation attempts were denied" : "operation denial requirement was not met",
      expected: {
        outcomes,
        attemptRequired: assertion.attemptRequired,
        ...(assertion.errorCode === undefined ? {} : { errorCode: assertion.errorCode }),
      },
      actual: attempts.map(operationAttempt),
      location: operationLocation([assertion.operation]),
      operator: "all_denied",
      details: { attemptCount: attempts.length, ...operationFilterDetails(filter) },
      evidenceSequences: attempts.map((entry) => entry.sequence),
    });
  }

  const events = evidence.event(assertion.event, assertion.phase);
  const matched = compareNumber(events.length, assertion.comparison);
  return result({
    assertion,
    matched,
    message: matched ? "event count matched" : "event count did not match",
    expected: assertion.comparison,
    actual: events.length,
    location: { subject: "event", event: assertion.event, phase: assertion.phase },
    operator: assertion.comparison.operator,
    evidenceSequences: events.map((entry) => entry.sequence),
  });
}

export function evaluateAssertions(input: EvaluateAssertionsInput): readonly AssertionResult[] {
  const evidence =
    input.evidence instanceof AssertionEvidenceIndex
      ? input.evidence
      : new AssertionEvidenceIndex(input.evidence);
  return input.assertions.map((assertion) => evaluateOne(assertion, input.state, evidence));
}
