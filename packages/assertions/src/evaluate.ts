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

export interface AssertionStateReader {
  readState(packageId: string, namespace: string, rowId: string): StoredStateRecord | null;
  scanState(packageId: string, namespace: string, options?: StateScanOptions): readonly StoredStateRecord[];
}

export interface EvaluateAssertionsInput {
  readonly assertions: readonly AssertionDefinition[];
  readonly state: AssertionStateReader;
  /** Evidence must already be scoped to this drill run and ordered by sequence. */
  readonly evidence: readonly EvidenceEntry[];
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
  evidence: readonly EvidenceEntry[],
  packageId: string,
  namespace: string,
  rowId?: string,
): readonly number[] {
  return evidence
    .filter(
      (entry) =>
        entry.kind === "state_change" &&
        entry.packageId === packageId &&
        entry.namespace === namespace &&
        (rowId === undefined || entry.rowId === rowId),
    )
    .map((entry) => entry.sequence);
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

function operationEvidence(
  evidence: readonly EvidenceEntry[],
  operation: OperationRef,
): readonly OperationEvidence[] {
  return evidence.filter(
    (entry): entry is OperationEvidence =>
      entry.kind === "operation" && operationEqual(entry.invocation.operation, operation),
  );
}

function evaluateOne(
  assertion: AssertionDefinition,
  state: AssertionStateReader,
  evidence: readonly EvidenceEntry[],
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
    const attempts = operationEvidence(evidence, assertion.operation).filter(
      (entry) => assertion.outcomes === undefined || assertion.outcomes.includes(entry.outcome.status),
    );
    const matched = compareNumber(attempts.length, assertion.comparison);
    return result({
      assertion,
      matched,
      message: matched ? "operation count matched" : "operation count did not match",
      expected: assertion.comparison,
      actual: attempts.length,
      location: operationLocation([assertion.operation]),
      operator: assertion.comparison.operator,
      ...(assertion.outcomes === undefined ? {} : { details: { outcomes: assertion.outcomes } }),
      evidenceSequences: attempts.map((entry) => entry.sequence),
    });
  }

  if (assertion.kind === "operation.order") {
    const attempts = evidence.filter((entry) => entry.kind === "operation");
    let cursor = 0;
    const matchedSequences: number[] = [];
    for (const step of assertion.sequence) {
      const index = attempts.findIndex(
        (entry, candidate) =>
          candidate >= cursor &&
          step.anyOf.some((operation) => operationEqual(entry.invocation.operation, operation)),
      );
      if (index < cursor) {
        return result({
          assertion,
          matched: false,
          message: "operation sequence was not observed in order",
          expected: assertion.sequence,
          actual: attempts.map((entry) => entry.invocation.operation),
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
      expected: assertion.sequence,
      actual: attempts.map((entry) => entry.invocation.operation),
      location: operationLocation(assertion.sequence.flatMap((step) => step.anyOf)),
      operator: "contains_in_order",
      details: { matchedSteps: matchedSequences.length, totalSteps: assertion.sequence.length },
      evidenceSequences: matchedSequences,
    });
  }

  if (assertion.kind === "operation.arguments") {
    const attempts = operationEvidence(evidence, assertion.operation);
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
      details: { occurrenceFound: attempt !== undefined },
      evidenceSequences: attempt === undefined ? [] : [attempt.sequence],
    });
  }

  if (assertion.kind === "operation.denied") {
    const attempts = operationEvidence(evidence, assertion.operation);
    const allDenied = attempts.every(
      (entry) =>
        entry.outcome.status === "denied" &&
        (assertion.errorCode === undefined || entry.outcome.error?.code === assertion.errorCode),
    );
    const matched = allDenied && (!assertion.attemptRequired || attempts.length > 0);
    return result({
      assertion,
      matched,
      message: matched ? "all operation attempts were denied" : "operation denial requirement was not met",
      expected: {
        status: "denied",
        attemptRequired: assertion.attemptRequired,
        ...(assertion.errorCode === undefined ? {} : { errorCode: assertion.errorCode }),
      },
      actual: attempts.map((entry) => ({
        sequence: entry.sequence,
        status: entry.outcome.status,
        ...(entry.outcome.error === undefined ? {} : { errorCode: entry.outcome.error.code }),
      })),
      location: operationLocation([assertion.operation]),
      operator: "all_denied",
      details: { attemptCount: attempts.length },
      evidenceSequences: attempts.map((entry) => entry.sequence),
    });
  }

  const events = evidence.filter(
    (entry) =>
      entry.kind === "event" &&
      entry.event.packageId === assertion.event.packageId &&
      entry.event.eventId === assertion.event.eventId &&
      entry.phase === assertion.phase,
  );
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
  for (let index = 1; index < input.evidence.length; index += 1) {
    const previous = input.evidence[index - 1];
    const current = input.evidence[index];
    if (previous !== undefined && current !== undefined && current.sequence <= previous.sequence) {
      throw new TypeError("assertion evidence must be strictly ordered by sequence");
    }
  }
  return input.assertions.map((assertion) => evaluateOne(assertion, input.state, input.evidence));
}
