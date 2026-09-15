import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckComparison, checkExpectation, checksForReview } from "./check-comparison";
import { compareValueLines, formatDiffValue, ValueDiff } from "./value-diff";

describe("inline evidence comparisons", () => {
  it("puts failures on the first page without reordering recorded results", () => {
    const source = [
      { status: "passed", id: 1 },
      { status: "failed", id: 2 },
      { status: "inconclusive", id: 3 },
      { status: "failed", id: 4 },
    ];
    expect(checksForReview(source).map((item) => item.id)).toEqual([2, 4, 3, 1]);
    expect(source.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });
  it("normalizes object keys without changing array order, value types, or missing data", () => {
    expect(formatDiffValue({ z: 1, a: { c: 3, b: 2 } })).toBe(formatDiffValue({ a: { b: 2, c: 3 }, z: 1 }));
    const representations = [undefined, null, "Not recorded", "null", false, 0, "0", [1, 2], [2, 1]].map(
      formatDiffValue,
    );
    expect(new Set(representations).size).toBe(representations.length);
    expect(formatDiffValue({ é: 1, é: 2 })).toBe(formatDiffValue({ é: 2, é: 1 }));
  });
  it("aligns changed values and preserves both documents and line numbers", () => {
    const before = formatDiffValue({ count: 8, unchanged: true });
    const after = formatDiffValue({ count: 7, note: "new", unchanged: true });
    const result = compareValueLines(before, after);
    expect(result.aligned).toBe(true);
    expect(
      result.rows
        .filter((row) => row.before)
        .map((row) => row.before?.text)
        .join("\n"),
    ).toBe(before);
    expect(
      result.rows
        .filter((row) => row.after)
        .map((row) => row.after?.text)
        .join("\n"),
    ).toBe(after);
    expect(result.rows.find((row) => row.before?.text.includes('"count"'))).toMatchObject({
      before: { number: 2 },
      after: { number: 2 },
      changed: true,
    });
    expect(result.rows.find((row) => row.after?.text.includes('"note"'))).toMatchObject({
      after: { number: 3 },
      changed: true,
    });
    expect(result.rows.find((row) => row.before?.text.includes('"unchanged"'))?.changed).toBe(false);
  });
  it("renders expected and actual together without viewer buttons or interpreted markup", () => {
    const html = renderToStaticMarkup(
      <ValueDiff
        before={{ label: '<script>alert("x")</script>', count: 8 }}
        after={{ label: "changed", count: 7 }}
      />,
    );
    expect(html).toContain("− Expected");
    expect(html).toContain("+ Actual");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("View value");
    expect(html).not.toContain("<dialog");
    expect(html).toContain('data-changed="true"');
  });
  it("preserves comparison operators instead of implying unequal values are failures", () => {
    for (const operator of ["not_equals", "greater_than_or_equal", "less_than_or_equal", "one_of"]) {
      const assertion = { kind: "state.value", expected: { operator, value: [1, 2] }, actual: 2 };
      expect(checkExpectation(assertion).condition).toBeDefined();
      expect(renderToStaticMarkup(<CheckComparison assertion={assertion} />)).toContain("Actual must");
    }
    expect(checkExpectation({ kind: "state.value", expected: { operator: "equals", value: 0 } })).toEqual({
      value: 0,
    });
    const expected = { operator: "equals", value: 0 };
    expect(checkExpectation({ kind: "operation.order", expected })).toMatchObject({
      value: expected,
      condition: expect.stringContaining("in this order"),
    });
    expect(checkExpectation({ kind: "state.value", expected: { ...expected, extra: true } }).value).toEqual({
      ...expected,
      extra: true,
    });
  });
  it("explains containment and missing evidence without turning absence into a null value", () => {
    const html = renderToStaticMarkup(
      <CheckComparison
        assertion={{
          kind: "operation.arguments",
          expected: { id: 1 },
          actual: null,
          diff: { details: { occurrenceFound: false } },
        }}
      />,
    );
    expect(html).toContain("extra fields are allowed");
    expect(html).toContain("Actual (call not observed)");
    const missing = renderToStaticMarkup(
      <CheckComparison
        assertion={{
          kind: "state.value",
          expected: { operator: "equals", value: null },
          actual: null,
          diff: { details: { missing: true } },
        }}
      />,
    );
    expect(missing).toContain("record or field not found");
  });
  it("keeps a long scalar complete inside the bounded document surface", () => {
    const value = "very-long-value".repeat(10000);
    const html = renderToStaticMarkup(<ValueDiff before="short" after={value} />);
    expect(html).toContain(value);
    expect(html).toContain('aria-label="Value comparison content"');
    expect(html).toContain("fd-value-diff__scroll");
  });
  it("pages long documents without dropping lines from the underlying comparison", () => {
    const before = Array.from({ length: 200 }, (_, index) => ({ id: index, value: index }));
    const after = before.map((item, index) => (index === 199 ? { ...item, value: -1 } : item));
    const comparison = compareValueLines(formatDiffValue(before), formatDiffValue(after));
    expect(comparison.rows.filter((row) => row.after).length).toBe(formatDiffValue(after).split("\n").length);
    const html = renderToStaticMarkup(<ValueDiff before={before} after={after} />);
    expect(html).toContain("Jump to first change");
    expect(html).toContain("Next value comparison lines");
    expect(html.match(/class="fd-value-diff__row"/g)).toHaveLength(80);
  });
  it("falls back safely for large unrelated documents rather than blocking or truncating", () => {
    const before = Array.from({ length: 1700 }, (_, index) => `before-${index}`).join("\n");
    const after = Array.from({ length: 1750 }, (_, index) => `after-${index}`).join("\n");
    const result = compareValueLines(before, after);
    expect(result.aligned).toBe(false);
    expect(result.rows).toHaveLength(1750);
    expect(
      result.rows
        .filter((row) => row.before)
        .map((row) => row.before?.text)
        .join("\n"),
    ).toBe(before);
    expect(
      result.rows
        .filter((row) => row.after)
        .map((row) => row.after?.text)
        .join("\n"),
    ).toBe(after);
  });
});
