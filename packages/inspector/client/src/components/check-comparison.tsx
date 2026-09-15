import { ValueDiff } from "./value-diff";

/** Put actionable results first without mutating the recorded/source assertion order. */
export function checksForReview<T extends { readonly status: string }>(checks: readonly T[]): T[] {
  const priority: Readonly<Record<string, number>> = { failed: 0, invalid: 1, inconclusive: 2, passed: 3 };
  return [...checks].sort((a, b) => (priority[a.status] ?? 2) - (priority[b.status] ?? 2));
}

/** Only comparison-based assertions wrap their expected value in an operator. */
export function checkExpectation(assertion: { readonly kind: string; readonly expected: unknown }) {
  const { expected } = assertion;
  const operationConditions: Readonly<Record<string, string>> = {
    "operation.arguments": "Actual arguments must contain the expected fields; extra fields are allowed.",
    "operation.order": "The expected calls must appear in this order; other calls may appear between them.",
    "operation.denied":
      "Every recorded attempt must match the expected denial rules, including whether an attempt is required.",
  };
  const operationCondition = operationConditions[assertion.kind];
  if (operationCondition !== undefined) return { value: expected, condition: operationCondition };
  if (
    !["state.value", "state.count", "operation.count", "event.count", "callback.count"].includes(
      assertion.kind,
    ) ||
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  )
    return { value: expected };
  const comparison = expected as Record<string, unknown>;
  const conditions: Readonly<Record<string, string>> = {
    equals: "Actual must equal the expected value.",
    not_equals: "Actual must differ from the expected value.",
    greater_than_or_equal: "Actual must be at least the expected value.",
    less_than_or_equal: "Actual must be at most the expected value.",
    one_of: "Actual must match one of the expected values.",
  };
  const condition = typeof comparison.operator === "string" ? conditions[comparison.operator] : undefined;
  if (condition === undefined || !Object.hasOwn(comparison, "value") || Object.keys(comparison).length !== 2)
    return { value: expected };
  return { value: comparison.value, ...(comparison.operator === "equals" ? {} : { condition }) };
}

export function CheckComparison({
  assertion,
}: {
  readonly assertion: {
    readonly kind: string;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly diff?: { readonly details: Readonly<Record<string, unknown>> };
  };
}) {
  const expected = checkExpectation(assertion);
  return (
    <div className="fd-check-comparison">
      {expected.condition === undefined ? null : (
        <p className="fd-check-comparison__condition">{expected.condition}</p>
      )}
      <ValueDiff
        before={expected.value}
        after={assertion.actual}
        afterLabel={
          assertion.diff?.details.missing === true
            ? "Actual (record or field not found)"
            : assertion.diff?.details.occurrenceFound === false
              ? "Actual (call not observed)"
              : "Actual"
        }
        label="Expected and actual"
      />
    </div>
  );
}
