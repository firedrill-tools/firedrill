import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import { jsonLineTokens } from "./json-tokens";

// React owns rendering. Prism only returns tokens; it must not rewrite the DOM.
Prism.manual = true;

export interface SourceToken {
  readonly offset: number;
  readonly text: string;
  readonly kind: string;
}

/** Preserve exact source text, including multi-line comments, without interpreting HTML. */
export function sourceLines(content: string, language?: string): readonly (readonly SourceToken[])[] {
  if (language === "json") return content.split("\n").map(jsonLineTokens);
  const grammar =
    language === "typescript" || language === "javascript" ? Prism.languages[language] : undefined;
  // Large documents remain complete and copyable without spending unbounded work on coloring.
  if (grammar === undefined || content.length > 64 * 1024) {
    return content.split("\n").map((text) => [{ offset: 0, text, kind: "plain" }]);
  }
  const lines: SourceToken[][] = [[]];
  let offset = 0;
  const append = (token: string | Prism.Token, kind = "plain") => {
    if (typeof token !== "string") {
      for (const child of Array.isArray(token.content) ? token.content : [token.content]) {
        append(child, token.type);
      }
      return;
    }
    const parts = token.split("\n");
    for (const [index, text] of parts.entries()) {
      if (index > 0) {
        lines.push([]);
        offset = 0;
      }
      if (text.length > 0) lines[lines.length - 1]?.push({ offset, text, kind });
      offset += text.length;
    }
  };
  for (const token of Prism.tokenize(content, grammar)) append(token);
  return lines;
}
