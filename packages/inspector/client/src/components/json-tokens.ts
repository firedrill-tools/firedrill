/** Lexical coloring only. Never interprets markup or changes the document text. */
export function jsonLineTokens(line: string): readonly { offset: number; text: string; kind: string }[] {
  const tokens: { offset: number; text: string; kind: string }[] = [];
  const pattern =
    /"(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > cursor)
      tokens.push({ offset: cursor, text: line.slice(cursor, match.index), kind: "plain" });
    const text = match[0];
    const kind = text.startsWith('"')
      ? /^\s*:/.test(line.slice(match.index + text.length))
        ? "key"
        : "string"
      : "literal";
    tokens.push({ offset: match.index, text, kind });
    cursor = match.index + text.length;
  }
  if (cursor < line.length) tokens.push({ offset: cursor, text: line.slice(cursor), kind: "plain" });
  return tokens.length === 0 ? [{ offset: 0, text: line, kind: "plain" }] : tokens;
}
