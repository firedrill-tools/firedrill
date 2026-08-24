import { z } from "zod";
import { JsonObjectSchema } from "./json.js";

export const SourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), {
    message: "source paths must be repository-relative POSIX paths",
  });

export const SourcePositionSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});

export const SourceSpanSchema = z
  .object({
    path: SourcePathSchema,
    start: SourcePositionSchema,
    end: SourcePositionSchema,
  })
  .superRefine((span, context) => {
    const before = span.end.line < span.start.line;
    const sameLineBefore = span.end.line === span.start.line && span.end.column < span.start.column;
    if (before || sameLineBefore) context.addIssue({ code: "custom", message: "span end precedes start" });
  });

export const DiagnosticSchema = z
  .object({
    code: z.string().regex(/^FD\d{4}$/),
    severity: z.enum(["error", "warning", "info"]),
    message: z.string().min(1).max(2000),
    span: SourceSpanSchema.optional(),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
    suggestion: z.string().min(1).max(4000).optional(),
    data: JsonObjectSchema.optional(),
  })
  .passthrough();

export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type SourcePosition = z.infer<typeof SourcePositionSchema>;
export type SourceSpan = z.infer<typeof SourceSpanSchema>;
