import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { SourceSpan } from "@firedrill-run/contracts";
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { LineCounter, isNode, parseDocument } from "yaml";
import { diagnostic } from "./diagnostics.js";
import type { SourceDocument } from "./types.js";
import type { Diagnostic } from "@firedrill-run/contracts";

const MAX_SOURCE_BYTES = 1_048_576;

function linePosition(text: string, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, bounded);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function span(text: string, repositoryPath: string, start: number, end: number): SourceSpan {
  const boundedStart = Math.max(0, Math.min(start, text.length));
  const boundedEnd = Math.max(boundedStart + 1, Math.min(Math.max(end, start + 1), text.length));
  return {
    path: repositoryPath,
    start: linePosition(text, boundedStart),
    end: linePosition(text, boundedEnd),
  };
}

export type ParseSourceResult =
  | { readonly status: "success"; readonly document: SourceDocument }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };

function parseJson(text: string, absolutePath: string, repositoryPath: string): ParseSourceResult {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0 || root === undefined) {
    return {
      status: "failed",
      diagnostics: (errors.length > 0 ? errors : [{ error: 4, offset: 0, length: 1 }]).map((error) =>
        diagnostic({
          code: "FD1101",
          message: `invalid JSON: ${printParseErrorCode(error.error)}`,
          span: span(text, repositoryPath, error.offset, error.offset + Math.max(error.length, 1)),
          suggestion: "Fix the JSON syntax and run validation again.",
        }),
      ),
    };
  }
  const spanAt = (path: readonly (string | number)[]) => {
    let node: JsonNode | undefined = root;
    if (path.length > 0) node = findNodeAtLocation(root, [...path]);
    return span(text, repositoryPath, node?.offset ?? root.offset, (node?.offset ?? 0) + (node?.length ?? 1));
  };
  return {
    status: "success",
    document: { absolutePath, repositoryPath, value: getNodeValue(root), spanAt },
  };
}

function parseYaml(text: string, absolutePath: string, repositoryPath: string): ParseSourceResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      status: "failed",
      diagnostics: document.errors.map((error) => {
        const [start = 0, end = start + 1] = error.pos;
        return diagnostic({
          code: "FD1101",
          message: `invalid YAML: ${error.message}`,
          span: span(text, repositoryPath, start, end),
          suggestion: "Fix the YAML syntax and run validation again.",
        });
      }),
    };
  }
  const root = document.contents;
  const spanAt = (path: readonly (string | number)[]) => {
    const selected = path.length === 0 ? root : document.getIn([...path], true);
    const node = isNode(selected) ? selected : root;
    const [start = 0, end = start + 1] = node?.range ?? [0, 1];
    return span(text, repositoryPath, start, end);
  };
  return {
    status: "success",
    document: {
      absolutePath,
      repositoryPath,
      value: document.toJS({ maxAliasCount: 100 }),
      spanAt,
    },
  };
}

export function parseSource(absolutePath: string, repositoryPath: string): ParseSourceResult {
  let text: string;
  try {
    const bytes = readFileSync(absolutePath);
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return {
        status: "failed",
        diagnostics: [
          diagnostic({
            code: "FD1003",
            message: `source file exceeds the ${MAX_SOURCE_BYTES}-byte limit`,
            span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            suggestion: "Split the resource into smaller source files.",
          }),
        ],
      };
    }
    text = bytes.toString("utf8");
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1001",
          message: `cannot read source: ${error instanceof Error ? error.message : String(error)}`,
          span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        }),
      ],
    };
  }

  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".json") return parseJson(text, absolutePath, repositoryPath);
  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(text, absolutePath, repositoryPath);
  }
  return {
    status: "failed",
    diagnostics: [
      diagnostic({
        code: "FD1004",
        message: `unsupported source extension ${extension || "(none)"}`,
        span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        suggestion: "Use JSON, YAML, or YML for typed Firedrill source.",
      }),
    ],
  };
}
