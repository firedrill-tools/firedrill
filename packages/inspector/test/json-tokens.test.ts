import { describe, expect, it } from "vitest";
import { jsonLineTokens } from "../client/src/components/json-tokens.js";

describe("read-only JSON display", () => {
  it("preserves an empty line", () => {
    expect(
      jsonLineTokens("")
        .map((token) => token.text)
        .join(""),
    ).toBe("");
  });
  it("preserves every character including escaped content and markup", () => {
    const value = {
      'key"quoted': '<script>alert("test")</script>\nvalue',
      number: -1.25e8,
      nil: null,
      flag: true,
    };
    const content = JSON.stringify(value, null, 2);
    expect(
      content
        .split("\n")
        .map((line) =>
          jsonLineTokens(line)
            .map((token) => token.text)
            .join(""),
        )
        .join("\n"),
    ).toBe(content);
  });
  it("colors keys and values separately without treating numeric strings as numbers", () => {
    expect(
      jsonLineTokens('  "value": "123",')
        .filter((token) => token.kind !== "plain")
        .map((token) => token.kind),
    ).toEqual(["key", "string"]);
    expect(
      jsonLineTokens('  "value": false')
        .filter((token) => token.kind !== "plain")
        .map((token) => token.kind),
    ).toEqual(["key", "literal"]);
  });
});
