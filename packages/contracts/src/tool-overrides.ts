import { z } from "zod";
import { ActorIdSchema, OperationRefSchema, StableIdSchema } from "./identifiers.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

export const ToolOverrideOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("return"), value: JsonValueSchema }).strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      message: z.string().min(1).max(1_000),
      retryable: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("original") }).strict(),
]);

/** Serializable operation behavior. Matching compares each supplied argument's complete JSON value. */
export const ToolOverrideSchema = z
  .object({
    id: StableIdSchema,
    operation: OperationRefSchema,
    when: z
      .object({
        arguments: JsonObjectSchema.optional(),
        actorId: ActorIdSchema.optional(),
      })
      .strict()
      .optional(),
    outcome: ToolOverrideOutcomeSchema,
    times: z.number().int().positive().safe().optional(),
  })
  .strict();

/** Compiler-owned provenance; never accepted in repository-authored rules. */
export const ToolOverrideScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline") }).strict(),
  z.object({ kind: z.literal("scenario"), scenarioId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("drill"), drillId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("run"), drillId: StableIdSchema }).strict(),
]);

export const ResolvedToolOverrideSchema = ToolOverrideSchema.extend({ scope: ToolOverrideScopeSchema });

function uniqueIds(rules: readonly { readonly id: string }[], context: z.RefinementCtx): void {
  const ids = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (ids.has(rule.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `duplicate Tool override id ${rule.id}`,
      });
    }
    ids.add(rule.id);
  }
}

export const ToolOverridesSchema = z.array(ToolOverrideSchema).max(1_000).superRefine(uniqueIds);
export const ResolvedToolOverridesSchema = z
  .array(ResolvedToolOverrideSchema)
  .max(4_000)
  .superRefine(uniqueIds);

export const ToolOverrideEvidenceSchema = z
  .object({
    id: StableIdSchema,
    scope: ToolOverrideScopeSchema,
    outcome: z.enum(["return", "error", "original"]),
    matchIndex: z.number().int().positive().safe(),
  })
  .strict();

export type ToolOverride = z.infer<typeof ToolOverrideSchema>;
export type ResolvedToolOverride = z.infer<typeof ResolvedToolOverrideSchema>;
export type ToolOverrideScope = z.infer<typeof ToolOverrideScopeSchema>;
export type ToolOverrideEvidence = z.infer<typeof ToolOverrideEvidenceSchema>;

/** Later rules win. Replacing an identity moves its replacement to the higher-priority position. */
export function mergeToolOverrides(
  baseline: readonly ResolvedToolOverride[] = [],
  overlay: readonly ResolvedToolOverride[] = [],
): ResolvedToolOverride[] {
  const overridden = new Set(overlay.map((rule) => rule.id));
  return [...baseline.filter((rule) => !overridden.has(rule.id)), ...overlay];
}
