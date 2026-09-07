import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeDocument } from "./code-document";
import { sourceLines } from "./source-tokens";

describe("read-only executable source", () => {
  it("preserves exact TypeScript text and multi-line comment coloring", () => {
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: inspect literal source rather than executing its interpolation.
      "/* first\nsecond */\nexport function handle(input: string) {\n  return `<script>${input}</script>`;\n}\n";
    const lines = sourceLines(source, "typescript");
    expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(source);
    expect(lines[0]?.every((token) => token.kind === "comment")).toBe(true);
    expect(lines[1]?.every((token) => token.kind === "comment")).toBe(true);
    expect(lines[2]?.some((token) => token.kind === "keyword" && token.text === "export")).toBe(true);
    const markup = renderToStaticMarkup(<CodeDocument content={source} language="typescript" />);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain('class="fd-document-line__number"');
    expect(markup).toContain("Wrap lines");
    expect(markup).toContain("Copy");
  });

  it("does not truncate large files, unfamiliar syntax, or long lines", () => {
    for (const [source, language] of [
      ["x".repeat(100_000), "javascript"],
      ["a\n\nβ\n", "unknown"],
    ]) {
      const lines = sourceLines(source ?? "", language);
      expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(source);
      expect(lines.flat().every((token) => token.kind === "plain")).toBe(true);
    }
  });
});
