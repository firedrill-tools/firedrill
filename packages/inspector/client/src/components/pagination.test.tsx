import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageBounds, PaginatedContent, Pagination } from "./pagination";

describe("inspector pagination", () => {
  it("bounds empty, partial and refreshed pages without skipping rows", () => {
    expect(pageBounds(0, 8, 25)).toEqual({ page: 0, pageSize: 25, start: 0, end: 0 });
    expect(pageBounds(53, 1, 25)).toEqual({ page: 1, pageSize: 25, start: 25, end: 50 });
    expect(pageBounds(53, 20, 25)).toEqual({ page: 2, pageSize: 25, start: 50, end: 53 });
    expect(pageBounds(3, 2, 25)).toEqual({ page: 0, pageSize: 25, start: 0, end: 3 });
    expect(pageBounds(53, -1, 25).start).toBe(0);
    expect(pageBounds(3, 0, 0).end).toBe(1);
    const indices = Array.from({ length: 53 }, (_, index) => index);
    expect(
      [0, 1, 2].flatMap((page) => {
        const { start, end } = pageBounds(indices.length, page, 25);
        return indices.slice(start, end);
      }),
    ).toEqual(indices);
  });

  it("uses named native buttons, disables boundaries, and announces the visible range", () => {
    const markup = renderToStaticMarkup(
      <Pagination
        label="Scenarios"
        total={53}
        page={0}
        pageSize={25}
        onPageChange={() => {}}
        variant="rail"
      />,
    );
    expect(markup).toContain('aria-label="Scenarios pages"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("1–25 of 53");
    expect(markup).toMatch(/<button[^>]*aria-label="Previous scenarios"[^>]*disabled=""/);
    expect(markup).not.toMatch(/<button[^>]*aria-label="Next scenarios"[^>]*disabled/);
    const last = renderToStaticMarkup(
      <Pagination label="Scenarios" total={53} page={2} pageSize={25} onPageChange={() => {}} />,
    );
    expect(last).toContain("51–53 of 53");
    expect(last).toMatch(/<button[^>]*aria-label="Next scenarios"[^>]*disabled=""/);
  });

  it("does not add controls to empty or one-page lists", () => {
    for (const total of [0, 1, 10]) {
      expect(
        renderToStaticMarkup(
          <Pagination label="Checks" total={total} page={0} pageSize={10} onPageChange={() => {}} />,
        ),
      ).toBe("");
    }
  });

  it("disables both directions while fetching the next server page", () => {
    const markup = renderToStaticMarkup(
      <Pagination label="State rows" total={130} page={3} pageSize={25} onPageChange={() => {}} disabled />,
    );
    expect(markup.match(/ disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("76–100 of 130");
  });

  it("renders only the current page and keeps navigation outside the list", () => {
    const markup = renderToStaticMarkup(
      <PaginatedContent label="Checks" items={Array.from({ length: 27 }, (_, index) => index + 1)}>
        {(items, start) => (
          <ol start={start + 1}>
            {items.map((item) => (
              <li key={item}>Check {item}</li>
            ))}
          </ol>
        )}
      </PaginatedContent>,
    );
    expect(markup.match(/<li\b/g)).toHaveLength(10);
    expect(markup).not.toContain("Check 11");
    expect(markup).toContain('</ol><nav class="fd-pagination');
    expect(markup).toContain("1–10 of 27");
  });
});
