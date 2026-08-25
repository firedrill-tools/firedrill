import { AssertionDefinitionSchema, EvidenceEntrySchema } from "@firedrill/contracts";
import type { EvidenceEntry, OperationOutcome } from "@firedrill/contracts";
import type { StateScanOptions, StoredStateRecord } from "@firedrill/world-store";
import { describe, expect, it } from "vitest";
import { AssertionEvidenceIndex, evaluateAssertions } from "../src/index.js";

const operation = {
  lookup: { packageId: "catalog", operationId: "records.lookup" },
  update: { packageId: "catalog", operationId: "records.update" },
  remove: { packageId: "catalog", operationId: "records.remove" },
} as const;

function stateReader(records: readonly StoredStateRecord[]) {
  return {
    readState(packageId: string, namespace: string, rowId: string) {
      return (
        records.find(
          (record) =>
            record.packageId === packageId && record.namespace === namespace && record.rowId === rowId,
        ) ?? null
      );
    },
    scanState(
      packageId: string,
      namespace: string,
      options: StateScanOptions = {},
    ): readonly StoredStateRecord[] {
      return [...records]
        .filter(
          (record) =>
            record.packageId === packageId &&
            record.namespace === namespace &&
            (options.afterRowId === undefined || record.rowId > options.afterRowId),
        )
        .sort((left, right) => (left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0))
        .slice(0, options.limit ?? 1_000);
    },
  };
}

function operationEntry(input: {
  readonly sequence: number;
  readonly callId: string;
  readonly operation: (typeof operation)[keyof typeof operation];
  readonly arguments: Record<string, unknown>;
  readonly outcome: OperationOutcome;
  readonly actorId?: string;
  readonly idempotency?: "not_requested" | "recorded" | "replayed" | "not_recorded";
}): EvidenceEntry {
  return EvidenceEntrySchema.parse({
    schemaVersion: 1,
    kind: "operation",
    sequence: input.sequence,
    transactionId: `txn_assert${String(input.sequence).padStart(2, "0")}`,
    transactionIndex: 0,
    transactionSize: 1,
    virtualTimeUs: 100,
    correlationId: `corr_assert${String(input.sequence).padStart(2, "0")}`,
    invocation: {
      schemaVersion: 1,
      callId: input.callId,
      correlationId: `corr_assert${String(input.sequence).padStart(2, "0")}`,
      operation: input.operation,
      actorBindingId: "actor_assert01",
      arguments: input.arguments,
    },
    actorId: input.actorId ?? "operator",
    outcome: input.outcome,
    idempotency: input.idempotency ?? "not_requested",
    ...(input.idempotency === "replayed" ? { replayedFromSequence: 1 } : {}),
  });
}

function evidence(): readonly EvidenceEntry[] {
  return [
    EvidenceEntrySchema.parse({
      schemaVersion: 1,
      kind: "state_change",
      sequence: 1,
      transactionId: "txn_assert01",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 100,
      correlationId: "corr_assert01",
      packageId: "catalog",
      namespace: "records",
      rowId: "one",
      change: "update",
      before: { status: "queued", nested: { owner: "sam" }, value: 2 },
      after: { status: "ready", nested: { owner: "sam" }, value: 3 },
      deltaHash: `sha256:${"a".repeat(64)}`,
    }),
    operationEntry({
      sequence: 2,
      callId: "call_assert02",
      operation: operation.lookup,
      arguments: { id: "one" },
      outcome: { status: "ok", value: { id: "one" } },
    }),
    operationEntry({
      sequence: 3,
      callId: "call_assert03",
      operation: operation.update,
      arguments: { id: "one", patch: { status: "ready", extra: true } },
      outcome: { status: "ok", value: { updated: true } },
    }),
    EvidenceEntrySchema.parse({
      schemaVersion: 1,
      kind: "event",
      sequence: 4,
      transactionId: "txn_assert04",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 100,
      correlationId: "corr_assert04",
      event: { packageId: "catalog", eventId: "record.changed" },
      phase: "emitted",
      payload: { id: "one" },
    }),
    operationEntry({
      sequence: 5,
      callId: "call_assert05",
      operation: operation.remove,
      arguments: { id: "one" },
      outcome: {
        status: "denied",
        error: {
          schemaVersion: 1,
          code: "world.CAPABILITY_DENIED",
          source: "world",
          message: "actor cannot remove records",
          retryable: false,
          issues: [],
        },
      },
    }),
  ];
}

const records: readonly StoredStateRecord[] = [
  {
    packageId: "catalog",
    namespace: "records",
    rowId: "one",
    value: { status: "ready", nested: { owner: "sam" }, value: 3 },
  },
  {
    packageId: "catalog",
    namespace: "records",
    rowId: "two",
    value: { status: "queued", nested: { owner: "lee" }, value: 8 },
  },
];

describe("deterministic assertion evaluation", () => {
  it("indexes journal pages incrementally and rejects duplicate or unordered evidence", () => {
    const entries = evidence();
    const index = new AssertionEvidenceIndex(entries.slice(0, 2));
    index.append(entries.slice(2));

    expect(index.lastSequence()).toBe(5);
    expect(index.all()).toEqual(entries);
    expect(index.operation(operation.update).map((entry) => entry.sequence)).toEqual([3]);
    expect(index.stateSequences("catalog", "records", "one")).toEqual([1]);
    expect(index.event({ packageId: "catalog", eventId: "record.changed" }, "emitted")).toHaveLength(1);
    const lastEntry = entries.at(-1);
    if (lastEntry === undefined) throw new Error("evidence fixture must not be empty");
    expect(() => index.append([lastEntry])).toThrow(/strictly ordered/);
  });

  it("evaluates every published assertion kind with structured evidence", () => {
    const assertions = [
      {
        id: "value-matches",
        kind: "state.value",
        packageId: "catalog",
        namespace: "records",
        rowId: "one",
        path: ["nested", "owner"],
        comparison: { operator: "equals", value: "sam" },
      },
      {
        id: "count-matches",
        kind: "state.count",
        packageId: "catalog",
        namespace: "records",
        where: { status: "ready" },
        comparison: { operator: "equals", value: 1 },
      },
      {
        id: "call-count",
        kind: "operation.count",
        operation: operation.update,
        outcomes: ["ok"],
        comparison: { operator: "equals", value: 1 },
      },
      {
        id: "call-order",
        kind: "operation.order",
        sequence: [{ anyOf: [operation.lookup] }, { anyOf: [operation.update] }],
      },
      {
        id: "call-arguments",
        kind: "operation.arguments",
        operation: operation.update,
        contains: { patch: { status: "ready" } },
      },
      {
        id: "call-denied",
        kind: "operation.denied",
        operation: operation.remove,
        errorCode: "world.CAPABILITY_DENIED",
      },
      {
        id: "event-emitted",
        kind: "event.count",
        event: { packageId: "catalog", eventId: "record.changed" },
        comparison: { operator: "equals", value: 1 },
      },
    ].map((assertion) => AssertionDefinitionSchema.parse(assertion));

    const results = evaluateAssertions({ assertions, state: stateReader(records), evidence: evidence() });
    expect(results).toHaveLength(7);
    expect(results.every((item) => item.status === "passed")).toBe(true);
    expect(results.every((item) => item.diff.matched)).toBe(true);
    expect(results.find((item) => item.assertionId === "value-matches")).toMatchObject({
      actual: "sam",
      location: {
        subject: "state",
        packageId: "catalog",
        namespace: "records",
        rowId: "one",
        path: ["nested", "owner"],
      },
      evidenceSequences: [1],
    });
    expect(results.find((item) => item.assertionId === "event-emitted")?.location).toMatchObject({
      subject: "event",
      phase: "emitted",
    });
  });

  it("does not treat missing values, reordered calls, or a later success as passing", () => {
    const withSuccessfulRemove = [
      ...evidence(),
      operationEntry({
        sequence: 6,
        callId: "call_assert06",
        operation: operation.remove,
        arguments: { id: "two" },
        outcome: { status: "ok", value: { removed: true } },
      }),
    ];
    const assertions = [
      {
        id: "missing-not-equal",
        kind: "state.value",
        packageId: "catalog",
        namespace: "records",
        rowId: "one",
        path: ["missing"],
        comparison: { operator: "not_equals", value: "anything" },
      },
      {
        id: "wrong-order",
        kind: "operation.order",
        sequence: [{ anyOf: [operation.update] }, { anyOf: [operation.lookup] }],
      },
      {
        id: "missing-occurrence",
        kind: "operation.arguments",
        operation: operation.update,
        occurrence: 2,
        contains: { id: "one" },
      },
      {
        id: "not-all-denied",
        kind: "operation.denied",
        operation: operation.remove,
        gate: false,
      },
    ].map((assertion) => AssertionDefinitionSchema.parse(assertion));

    const results = evaluateAssertions({
      assertions,
      state: stateReader(records),
      evidence: withSuccessfulRemove,
    });
    expect(results.every((item) => item.status === "failed")).toBe(true);
    expect(results.find((item) => item.assertionId === "missing-not-equal")).toMatchObject({
      actual: null,
      diff: { matched: false, details: { missing: true } },
    });
    expect(results.find((item) => item.assertionId === "not-all-denied")?.gate).toBe(false);
  });

  it("requires successful calls for ordering and argument assertions by default", () => {
    const attempts = [
      operationEntry({
        sequence: 1,
        callId: "call_filtered01",
        operation: operation.lookup,
        arguments: { id: "one", unsafe: true },
        outcome: {
          status: "denied",
          error: {
            schemaVersion: 1,
            code: "world.CAPABILITY_DENIED",
            source: "world",
            message: "not permitted",
            retryable: false,
            issues: [],
          },
        },
      }),
      operationEntry({
        sequence: 2,
        callId: "call_filtered02",
        operation: operation.update,
        arguments: { id: "one" },
        outcome: { status: "ok", value: { updated: true } },
      }),
    ];
    const assertions = [
      {
        id: "only-successful-order",
        kind: "operation.order",
        sequence: [{ anyOf: [operation.lookup] }, { anyOf: [operation.update] }],
      },
      {
        id: "only-successful-arguments",
        kind: "operation.arguments",
        operation: operation.lookup,
        contains: { unsafe: true },
      },
    ].map((assertion) => AssertionDefinitionSchema.parse(assertion));

    const results = evaluateAssertions({ assertions, state: stateReader(records), evidence: attempts });
    expect(results.every((item) => item.status === "failed")).toBe(true);
    expect(results[0]?.actual).toEqual([
      expect.objectContaining({ outcome: "denied", operation: operation.lookup }),
      expect.objectContaining({ outcome: "ok", operation: operation.update }),
    ]);
  });

  it("recognizes declared tool refusals and filters attempts by actor and idempotency", () => {
    const attempts = [
      operationEntry({
        sequence: 1,
        callId: "call_tooldeny01",
        operation: operation.remove,
        actorId: "support-agent",
        arguments: { id: "one" },
        outcome: {
          status: "tool_error",
          error: {
            schemaVersion: 1,
            code: "tool.NOT_OWNER",
            source: "tool",
            message: "the actor does not own this record",
            retryable: false,
            issues: [],
          },
        },
      }),
      operationEntry({
        sequence: 2,
        callId: "call_recorded02",
        operation: operation.update,
        actorId: "support-agent",
        idempotency: "recorded",
        arguments: { id: "one" },
        outcome: { status: "ok", value: { updated: true } },
      }),
      operationEntry({
        sequence: 3,
        callId: "call_replayed03",
        operation: operation.update,
        actorId: "support-agent",
        idempotency: "replayed",
        arguments: { id: "one" },
        outcome: { status: "ok", value: { updated: true } },
      }),
      operationEntry({
        sequence: 4,
        callId: "call_other04",
        operation: operation.update,
        actorId: "other-agent",
        arguments: { id: "one" },
        outcome: { status: "ok", value: { updated: true } },
      }),
    ];
    const assertions = [
      {
        id: "tool-refusal",
        kind: "operation.denied",
        operation: operation.remove,
        actorId: "support-agent",
        errorCode: "tool.NOT_OWNER",
      },
      {
        id: "one-replay",
        kind: "operation.count",
        operation: operation.update,
        actorId: "support-agent",
        idempotency: ["replayed"],
        outcomes: ["ok"],
        comparison: { operator: "equals", value: 1 },
      },
    ].map((assertion) => AssertionDefinitionSchema.parse(assertion));

    const results = evaluateAssertions({ assertions, state: stateReader(records), evidence: attempts });
    expect(results.every((item) => item.status === "passed")).toBe(true);
    expect(results[1]).toMatchObject({ actual: 1, evidenceSequences: [3] });
  });

  it("paginates state counts and rejects unordered evidence", () => {
    const many = Array.from(
      { length: 1_001 },
      (_, index): StoredStateRecord => ({
        packageId: "catalog",
        namespace: "records",
        rowId: String(index).padStart(4, "0"),
        value: { active: true },
      }),
    );
    const assertion = AssertionDefinitionSchema.parse({
      id: "large-count",
      kind: "state.count",
      packageId: "catalog",
      namespace: "records",
      comparison: { operator: "equals", value: 1_001 },
    });
    expect(
      evaluateAssertions({ assertions: [assertion], state: stateReader(many), evidence: [] })[0],
    ).toMatchObject({ status: "passed", actual: 1_001 });

    expect(() =>
      evaluateAssertions({
        assertions: [assertion],
        state: stateReader(many),
        evidence: [...evidence()].reverse(),
      }),
    ).toThrow("strictly ordered");
  });
});
