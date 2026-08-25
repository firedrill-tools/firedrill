import { z } from "zod";
import {
  ActorIdSchema,
  EventRefSchema,
  OperationRefSchema,
  PackageIdSchema,
  StableIdSchema,
} from "./identifiers.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";
import { OperationIdempotencyDispositionSchema, OperationOutcomeStatusSchema } from "./operation.js";

export const ComparisonSchema = z.discriminatedUnion("operator", [
  z.object({ operator: z.literal("equals"), value: JsonValueSchema }).strict(),
  z.object({ operator: z.literal("not_equals"), value: JsonValueSchema }).strict(),
  z.object({ operator: z.literal("greater_than_or_equal"), value: z.number().finite() }).strict(),
  z.object({ operator: z.literal("less_than_or_equal"), value: z.number().finite() }).strict(),
  z.object({ operator: z.literal("one_of"), value: z.array(JsonValueSchema).min(1) }).strict(),
]);

export const NumericComparisonSchema = z.discriminatedUnion("operator", [
  z.object({ operator: z.literal("equals"), value: z.number().int().nonnegative() }).strict(),
  z.object({ operator: z.literal("not_equals"), value: z.number().int().nonnegative() }).strict(),
  z.object({ operator: z.literal("greater_than_or_equal"), value: z.number().int().nonnegative() }).strict(),
  z.object({ operator: z.literal("less_than_or_equal"), value: z.number().int().nonnegative() }).strict(),
]);

export const AssertionKindSchema = z.enum([
  "state.value",
  "state.count",
  "operation.count",
  "operation.order",
  "operation.arguments",
  "operation.denied",
  "event.count",
]);

const AssertionBase = {
  id: StableIdSchema,
  gate: z.boolean().default(true),
};

const OperationEvidenceFilter = {
  actorId: ActorIdSchema.optional(),
  idempotency: z.array(OperationIdempotencyDispositionSchema).min(1).optional(),
};

export const StateValueAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("state.value"),
    packageId: PackageIdSchema,
    namespace: StableIdSchema,
    rowId: z.string().min(1).max(512),
    path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1),
    comparison: ComparisonSchema,
  })
  .strict();

export const StateCountAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("state.count"),
    packageId: PackageIdSchema,
    namespace: StableIdSchema,
    where: JsonObjectSchema.optional(),
    comparison: NumericComparisonSchema,
  })
  .strict();

export const OperationCountAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("operation.count"),
    operation: OperationRefSchema,
    ...OperationEvidenceFilter,
    outcomes: z.array(OperationOutcomeStatusSchema).min(1).optional(),
    comparison: NumericComparisonSchema,
  })
  .strict();

export const OperationOrderAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("operation.order"),
    sequence: z
      .array(
        z
          .object({
            anyOf: z.array(OperationRefSchema).min(1),
            ...OperationEvidenceFilter,
            outcomes: z.array(OperationOutcomeStatusSchema).min(1).default(["ok"]),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

export const OperationArgumentsAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("operation.arguments"),
    operation: OperationRefSchema,
    ...OperationEvidenceFilter,
    outcomes: z.array(OperationOutcomeStatusSchema).min(1).default(["ok"]),
    occurrence: z.number().int().positive().default(1),
    contains: JsonObjectSchema,
  })
  .strict();

export const OperationDeniedAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("operation.denied"),
    operation: OperationRefSchema,
    ...OperationEvidenceFilter,
    outcomes: z
      .array(z.enum(["denied", "tool_error"]))
      .min(1)
      .optional(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9-]*\.[A-Z][A-Z0-9_]*$/)
      .optional(),
    attemptRequired: z.boolean().default(true),
  })
  .strict();

export const EventCountAssertionSchema = z
  .object({
    ...AssertionBase,
    kind: z.literal("event.count"),
    event: EventRefSchema,
    phase: z.enum(["emitted", "scheduled", "handled", "failed"]).default("emitted"),
    comparison: NumericComparisonSchema,
  })
  .strict();

export const AssertionDefinitionSchema = z.discriminatedUnion("kind", [
  StateValueAssertionSchema,
  StateCountAssertionSchema,
  OperationCountAssertionSchema,
  OperationOrderAssertionSchema,
  OperationArgumentsAssertionSchema,
  OperationDeniedAssertionSchema,
  EventCountAssertionSchema,
]);

export const AssertionStatusSchema = z.enum(["passed", "failed", "inconclusive", "invalid"]);

export const AssertionLocationSchema = z.discriminatedUnion("subject", [
  z
    .object({
      subject: z.literal("state"),
      packageId: PackageIdSchema,
      namespace: StableIdSchema,
      rowId: z.string().min(1).max(512).optional(),
      path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).default([]),
    })
    .strict(),
  z
    .object({
      subject: z.literal("operation"),
      operations: z.array(OperationRefSchema).min(1),
      occurrence: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      subject: z.literal("event"),
      event: EventRefSchema,
      phase: z.enum(["emitted", "scheduled", "handled", "failed"]),
    })
    .strict(),
]);

export const AssertionDiffSchema = z
  .object({
    operator: z.enum([
      "equals",
      "not_equals",
      "greater_than_or_equal",
      "less_than_or_equal",
      "one_of",
      "contains",
      "contains_in_order",
      "all_denied",
    ]),
    matched: z.boolean(),
    details: JsonObjectSchema.default({}),
  })
  .strict();

export const AssertionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    assertionId: StableIdSchema,
    kind: AssertionKindSchema,
    status: AssertionStatusSchema,
    gate: z.boolean(),
    message: z.string().min(1).max(4000),
    expected: JsonValueSchema,
    actual: JsonValueSchema,
    location: AssertionLocationSchema,
    diff: AssertionDiffSchema,
    evidenceSequences: z.array(z.number().int().positive().safe()).default([]),
  })
  .passthrough();

export type AssertionDefinition = z.infer<typeof AssertionDefinitionSchema>;
export type AssertionResult = z.infer<typeof AssertionResultSchema>;
export type AssertionLocation = z.infer<typeof AssertionLocationSchema>;
export type AssertionDiff = z.infer<typeof AssertionDiffSchema>;
