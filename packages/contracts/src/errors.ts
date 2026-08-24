import { z } from "zod";
import { CorrelationIdSchema, RunIdSchema } from "./identifiers.js";
import { JsonObjectSchema } from "./json.js";

export const ErrorSourceSchema = z.enum(["framework", "world", "tool", "target", "assertion", "reporter"]);
export const ErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]*\.[A-Z][A-Z0-9_]*$/);

export const ErrorIssueSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2000),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
    suggestion: z.string().min(1).max(4000).optional(),
  })
  .passthrough();

export const ErrorEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    code: ErrorCodeSchema,
    source: ErrorSourceSchema,
    message: z.string().min(1).max(4000),
    retryable: z.boolean(),
    correlationId: CorrelationIdSchema.optional(),
    issues: z.array(ErrorIssueSchema).default([]),
    details: JsonObjectSchema.optional(),
    evidence: z
      .object({
        runId: RunIdSchema.optional(),
        sequence: z.number().int().positive().safe().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((error, context) => {
    const namespace = error.code.slice(0, error.code.indexOf("."));
    if (namespace !== error.source) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: `error code namespace ${namespace} does not match source ${error.source}`,
      });
    }
  });

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;
