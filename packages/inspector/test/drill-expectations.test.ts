import { describe, expect, it } from "vitest";
import { describeExpectation } from "../client/src/features/drill-expectations.js";

const base = { id: "unrelated-display-name", gate: true };
const operation = { packageId: "records", operationId: "write" };

describe("authored drill expectation descriptions", () => {
  it("keeps record identity, literal path segments and falsy expected values intact", () => {
    const result = describeExpectation({
      ...base,
      kind: "state.value",
      packageId: "records",
      namespace: "items",
      rowId: 'item/1 "primary"',
      path: ["profile.name", 0, "0", "active"],
      comparison: { operator: "equals", value: false },
    });
    expect(result).toEqual({
      subject: 'records / items / row "item/1 \\"primary\\"" / $["profile.name"][0]["0"]["active"]',
      expectation: "The field must exist and equal false exactly.",
      scope: [],
      filters: [],
    });
    expect(JSON.stringify(result)).not.toContain(base.id);
  });

  it.each([
    [{ operator: "equals", value: null }, "equal null exactly"],
    [{ operator: "not_equals", value: { ready: false } }, 'differ from {"ready":false}'],
    [{ operator: "greater_than_or_equal", value: 0 }, "be a number greater than or equal to 0"],
    [{ operator: "less_than_or_equal", value: 12 }, "be a number less than or equal to 12"],
    [{ operator: "one_of", value: [false, 0, null, "0"] }, 'equal one of [false,0,null,"0"] exactly'],
  ] as const)("preserves comparison operators and JSON values: %j", (comparison, wording) => {
    const result = describeExpectation({
      ...base,
      kind: "state.value",
      packageId: "records",
      namespace: "items",
      rowId: "one",
      path: ["value"],
      comparison:
        comparison.operator === "one_of" ? { ...comparison, value: [...comparison.value] } : comparison,
    });
    expect(result.expectation).toBe(`The field must exist and ${wording}.`);
  });

  it("describes partial record filters without dropping nested values or implying exact object equality", () => {
    const result = describeExpectation({
      ...base,
      kind: "state.count",
      packageId: "records",
      namespace: "items",
      where: { nested: { active: true }, labels: ["a", "b"] },
      comparison: { operator: "not_equals", value: 0 },
    });
    expect(result.subject).toBe("Record count in records / items");
    expect(result.expectation).toBe("The count must differ from 0.");
    expect(result.scope).toEqual(['Record values include {"nested":{"active":true},"labels":["a","b"]}']);
    expect(result.filters).toEqual([
      'Record values must include {"nested":{"active":true},"labels":["a","b"]}. Nested object fields are matched; arrays must match exactly.',
    ]);
  });

  it("keeps operation count filters and does not silently count only successful or first-time calls", () => {
    const definition = {
      ...base,
      kind: "operation.count" as const,
      operation,
      comparison: { operator: "equals" as const, value: 2 },
    };
    expect(describeExpectation(definition)).toEqual({
      subject: "Recorded calls to records / write",
      expectation: "The matching call count must equal 2 exactly.",
      scope: [],
      filters: [
        "All outcomes count, including unsuccessful calls.",
        "All idempotency dispositions count, including replayed calls.",
      ],
    });
    expect(
      describeExpectation({
        ...definition,
        actorId: "reviewer",
        outcomes: ["ok", "tool_error"],
        idempotency: ["recorded", "replayed"],
      }).filters,
    ).toEqual([
      "Actor: reviewer",
      "Outcome: ok or tool_error",
      "Idempotency disposition: recorded or replayed",
    ]);
    expect(
      describeExpectation({
        ...definition,
        actorId: "reviewer",
        outcomes: ["tool_error"],
        idempotency: ["recorded", "replayed"],
      }).scope,
    ).toEqual(["Actor: reviewer", "Outcome: tool_error", "Idempotency disposition: recorded or replayed"]);
  });

  it("describes a subsequence, per-step alternatives and filters rather than consecutive calls", () => {
    const result = describeExpectation({
      ...base,
      kind: "operation.order",
      sequence: [
        { anyOf: [{ packageId: "records", operationId: "read" }], outcomes: ["ok"], actorId: "reader" },
        {
          anyOf: [operation, { packageId: "queue", operationId: "enqueue" }],
          outcomes: ["ok", "denied"],
          idempotency: ["not_requested"],
        },
      ],
    });
    expect(result.expectation).toBe(
      "Observe records / read then (records / write or queue / enqueue) in this order. Other calls may occur before, between or after these calls.",
    );
    expect(result.filters).toEqual([
      "Step 1: Actor: reader",
      "Step 1: Outcome: ok",
      "Step 1: All idempotency dispositions count, including replayed calls.",
      "Step 2: Outcome: ok or denied",
      "Step 2: Idempotency disposition: not_requested",
    ]);
    expect(result.scope).toEqual([
      "Step 1: Actor: reader",
      "Step 1: Outcome: ok",
      "Step 2: Outcome: ok or denied",
      "Step 2: Idempotency disposition: not_requested",
    ]);
  });

  it("identifies the occurrence AFTER filtering and preserves the entire argument pattern", () => {
    const text = "long value ".repeat(60);
    const result = describeExpectation({
      ...base,
      kind: "operation.arguments",
      operation,
      actorId: "editor",
      outcomes: ["ok"],
      idempotency: ["not_recorded"],
      occurrence: 3,
      contains: { value: text, nested: { enabled: false }, labels: [1, 2] },
    });
    expect(result.subject).toBe("Arguments of matching call 3 to records / write");
    expect(result.expectation).toContain(
      JSON.stringify({ value: text, nested: { enabled: false }, labels: [1, 2] }),
    );
    expect(result.expectation).toContain("That call must exist");
    expect(result.expectation).toContain("Extra object fields are allowed; arrays must match exactly");
    expect(result.filters).toEqual(["Actor: editor", "Outcome: ok", "Idempotency disposition: not_recorded"]);
    expect(result.scope).toEqual(["Actor: editor", "Outcome: ok", "Idempotency disposition: not_recorded"]);
  });

  it("does not turn denial requirements into outcome filters or require an optional attempt", () => {
    const result = describeExpectation({
      ...base,
      kind: "operation.denied",
      operation,
      actorId: "restricted",
      idempotency: ["not_requested"],
      outcomes: ["denied", "tool_error"],
      errorCode: "tool.BLOCKED",
      attemptRequired: false,
    });
    expect(result.expectation).toBe(
      "Every matching attempt must have outcome denied or tool_error and error code tool.BLOCKED. No attempt is required; zero matching attempts also passes.",
    );
    expect(result.filters).toEqual(["Actor: restricted", "Idempotency disposition: not_requested"]);
    expect(result.scope).toEqual(["Actor: restricted", "Idempotency disposition: not_requested"]);
  });

  it.each([
    [undefined, "denied"],
    ["world.FORBIDDEN", "denied"],
    ["tool.REJECTED", "tool_error"],
  ])("matches the evaluator's implicit denial outcome for %s", (errorCode, outcome) => {
    const result = describeExpectation({
      ...base,
      kind: "operation.denied",
      operation,
      attemptRequired: true,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    expect(result.expectation).toContain(`must have outcome ${outcome}`);
    expect(result.expectation).toContain("At least one matching attempt is required.");
    expect(result.filters).toEqual(["All idempotency dispositions are checked, including replayed calls."]);
    expect(result.scope).toEqual([]);
  });

  it.each(["emitted", "scheduled", "handled", "failed"] as const)(
    "names the exact event phase %s",
    (phase) => {
      expect(
        describeExpectation({
          ...base,
          kind: "event.count",
          event: { packageId: "queue", eventId: "changed" },
          phase,
          comparison: { operator: "greater_than_or_equal", value: 1 },
        }),
      ).toEqual({
        subject: "Recorded events for queue / changed",
        expectation: `The number of ${phase} event entries must be a number greater than or equal to 1.`,
        scope: [],
        filters: [],
      });
    },
  );

  it.each(["queued", "attempt_started", "delivered", "retry_scheduled", "failed", "recovered"] as const)(
    "counts callback phase entries, not distinct callbacks: %s",
    (phase) => {
      const result = describeExpectation({
        ...base,
        kind: "callback.count",
        callback: { packageId: "queue", callbackId: "notify" },
        phase,
        comparison: { operator: "less_than_or_equal", value: 2 },
      });
      expect(result.subject).toBe("Recorded callbacks for queue / notify");
      expect(result.expectation).toContain("number of callback entries in phase");
      expect(result.expectation).toContain(phase);
      expect(result.expectation).toContain("less than or equal to 2");
      expect(result.scope).toEqual([]);
    },
  );
});
