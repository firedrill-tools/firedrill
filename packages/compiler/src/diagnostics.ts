import { DiagnosticSchema } from "@firedrill/contracts";
import type { Diagnostic, SourceSpan } from "@firedrill/contracts";
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
    return diagnostic({
      code: "FD1102",
      message: issue.message,
      span: document.spanAt(path),
      path,
      suggestion: "Use the published source schema and remove unknown execution-affecting fields.",
    });
  });
}

export function sortDiagnostics(values: readonly Diagnostic[]): Diagnostic[] {
  return [...values].sort((left, right) => {
    const leftPath = left.span?.path ?? "";
    const rightPath = right.span?.path ?? "";
    const pathOrder = leftPath.localeCompare(rightPath);
    if (pathOrder !== 0) return pathOrder;
    const lineOrder = (left.span?.start.line ?? 0) - (right.span?.start.line ?? 0);
    if (lineOrder !== 0) return lineOrder;
    const columnOrder = (left.span?.start.column ?? 0) - (right.span?.start.column ?? 0);
    if (columnOrder !== 0) return columnOrder;
    const codeOrder = left.code.localeCompare(right.code);
    return codeOrder === 0 ? left.message.localeCompare(right.message) : codeOrder;
  });
}
