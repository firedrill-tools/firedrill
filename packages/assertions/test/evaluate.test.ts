import { AssertionDefinitionSchema, EvidenceEntrySchema } from "@firedrill/contracts";
import type { EvidenceEntry } from "@firedrill/contracts";
import type { StateScanOptions, StoredStateRecord } from "@firedrill/world-store";
import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../src/index.js";

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
        .sort((left, right) => left.rowId.localeCompare(right.rowId))
        .slice(0, options.limit ?? 1_000);
    },
  };
}

function operationEntry(input: {
  readonly sequence: number;
  readonly callId: string;
  readonly operation: (typeof operation)[keyof typeof operation];
  readonly arguments: Record<string, unknown>;
  readonly outcome:
    | { readonly status: "ok"; readonly value: Record<string, unknown> }
    | {
        readonly status: "denied";
        readonly error: {
          readonly schemaVersion: 1;
          readonly code: "world.CAPABILITY_DENIED";
          readonly source: "world";
          readonly message: string;
          readonly retryable: false;
          readonly issues: readonly [];
        };
      };
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
    outcome: input.outcome,
    idempotency: "not_requested",
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
