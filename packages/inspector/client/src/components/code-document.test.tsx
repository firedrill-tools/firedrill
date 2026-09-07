import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeDocument } from "./code-document";

describe("document line numbering", () => {
  it("keeps source line numbers when displaying a later page", () => {
    const html = renderToStaticMarkup(<CodeDocument content={"first\nsecond"} startLine={101} />);
    expect(html).toContain('aria-hidden="true">101</span>');
    expect(html).toContain('aria-hidden="true">102</span>');
  });

  it("starts complete documents at one", () => {
    expect(renderToStaticMarkup(<CodeDocument content="source" />)).toContain('aria-hidden="true">1</span>');
  });
});
