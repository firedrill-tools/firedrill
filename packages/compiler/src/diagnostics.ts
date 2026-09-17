import { DiagnosticSchema, compareStableStrings } from "@firedrill-tools/contracts";
import type { Diagnostic, SourceSpan } from "@firedrill-tools/contracts";
import type { z } from "zod";
import type { SourceDocument } from "./types.js";

export function diagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly severity?: "error" | "warning" | "info";
  readonly span?: SourceSpan;
  readonly path?: readonly (string | number)[];
  readonly suggestion?: string;
}): Diagnostic {
  return DiagnosticSchema.parse({
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    ...(input.span === undefined ? {} : { span: input.span }),
    ...(input.path === undefined ? {} : { path: [...input.path] }),
    ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
  });
}

export function schemaDiagnostics(
  document: SourceDocument,
  issues: readonly z.core.$ZodIssue[],
): Diagnostic[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
    const label = path.reduce(
      (current, segment) =>
        typeof segment === "number"
          ? `${current}[${segment}]`
          : current === ""
            ? segment
            : `${current}.${segment}`,
      "",
    );
    const leaf = path.at(-1);
    const suggestion = (() => {
      if (issue.code === "unrecognized_keys") {
        const keys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys.map(String) : [];
        return keys.length === 0
          ? `Remove fields that are not part of ${label || "this resource"}.`
          : `Remove unknown field${keys.length === 1 ? "" : "s"} ${keys.join(", ")} from ${label || "this resource"}.`;
      }
      if (issue.code === "invalid_type" && typeof leaf === "string") {
        return `Add or correct ${label} with a value matching the published source schema.`;
      }
      if (issue.code === "invalid_value") {
        return `Use an allowed value for ${label || "this field"}.`;
      }
      if (issue.code === "too_small" || issue.code === "too_big") {
        return `Adjust ${label || "this value"} to satisfy its documented range or size constraint.`;
      }
      return `Correct ${label || "this resource"} to match the published source schema.`;
    })();
    const closestPath: Array<string | number> = [];
    let current = document.value;
    for (const segment of path) {
      if (typeof segment === "number") {
        if (!Array.isArray(current) || segment >= current.length) break;
        current = current[segment];
      } else {
        if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) break;
        current = (current as Record<string, unknown>)[segment];
      }
      closestPath.push(segment);
    }
    return diagnostic({
      code: "FD1102",
      message: `${label || "source"}: ${issue.message}`,
      span: document.spanAt(closestPath),
      path,
      suggestion,
    });
  });
}

export function sortDiagnostics(values: readonly Diagnostic[]): Diagnostic[] {
  return [...values].sort((left, right) => {
    const leftPath = left.span?.path ?? "";
    const rightPath = right.span?.path ?? "";
    const pathOrder = compareStableStrings(leftPath, rightPath);
    if (pathOrder !== 0) return pathOrder;
    const lineOrder = (left.span?.start.line ?? 0) - (right.span?.start.line ?? 0);
    if (lineOrder !== 0) return lineOrder;
    const columnOrder = (left.span?.start.column ?? 0) - (right.span?.start.column ?? 0);
    if (columnOrder !== 0) return columnOrder;
    const codeOrder = compareStableStrings(left.code, right.code);
    return codeOrder === 0 ? compareStableStrings(left.message, right.message) : codeOrder;
  });
}
