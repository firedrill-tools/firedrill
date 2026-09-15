import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function elementsInBranch(node: ts.Node): readonly (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return [node];
  if (ts.isJsxExpression(node)) return node.expression === undefined ? [] : elementsInBranch(node.expression);
  if (ts.isParenthesizedExpression(node)) return elementsInBranch(node.expression);
  if (ts.isConditionalExpression(node))
    return [...elementsInBranch(node.whenTrue), ...elementsInBranch(node.whenFalse)];
  return [];
}

function siblingKeyCollisions(sourceText: string): readonly string[] {
  const source = ts.createSourceFile("runs.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const collisions: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const siblingKeys = new Map<string, number>();
      node.children.forEach((child, index) => {
        for (const element of elementsInBranch(child)) {
          const opening = ts.isJsxElement(element) ? element.openingElement : element;
          const key = opening.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "key",
          )?.initializer;
          if (key === undefined) continue;
          const value = key.getText(source);
          const prior = siblingKeys.get(value);
          if (prior !== undefined && prior !== index)
            collisions.push(`${opening.tagName.getText(source)} repeats sibling key ${value}`);
          siblingKeys.set(value, index);
        }
      });
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return collisions;
}

describe("run workspace section identities", () => {
  it("gives separately mounted sibling sections distinct explicit React keys", () => {
    // Static rendering cannot catch orphan DOM from keyed client reconciliation. Keep this
    // structural canary alongside the browser check that polls a run with attachments and state.
    expect(
      siblingKeyCollisions(readFileSync(new URL("../client/src/features/runs.tsx", import.meta.url), "utf8")),
    ).toEqual([]);
  });

  it("detects the former duplicate key through separately conditional section siblings", () => {
    expect(
      siblingKeyCollisions(`
        <>
          {detail?.result === undefined ? null : <RunAttachments key={summary.runId} />}
          <section />
          {detail === undefined ? null : <StateBrowser key={summary.runId} />}
        </>
      `),
    ).toEqual(["StateBrowser repeats sibling key {summary.runId}"]);
  });
});
