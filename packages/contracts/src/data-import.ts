import { z } from "zod";
import { SourcePathSchema } from "./diagnostics.js";
import { PackageIdSchema, StableIdSchema } from "./identifiers.js";
import { JsonValueSchema } from "./json.js";

const Pointer = z
  .string()
  .max(512)
  .refine(
    (value) => value === "" || /^\/(?:[^~]|~[01])*$/.test(value),
    "use a JSON Pointer such as /records",
  );
const HeaderEnvironment = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/),
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
);
export const DataImportPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("json"), path: SourcePathSchema }).strict(),
      z
        .object({
          kind: z.literal("http"),
          url: z.string().url().max(4096),
          headersFromEnvironment: HeaderEnvironment.default({}),
          pagination: z
            .object({
              nextPointer: Pointer,
              cursorParameter: z
                .string()
                .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
    recordsPointer: Pointer.default(""),
    packageId: PackageIdSchema,
    namespace: StableIdSchema,
    idPointer: Pointer,
    /** An explicit allowlist. Unmapped provider fields never enter the preview or source. */
    fields: z
      .record(z.string().min(1).max(128), Pointer)
      .refine(
        (fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 100,
        "select 1–100 fields",
      ),
    selectIds: z.array(z.string().min(1).max(512)).min(1).max(5000).optional(),
    /** Paths in each mapped output row, not the provider response. */
    redactions: z
      .array(z.object({ path: Pointer, replacement: JsonValueSchema.default("[REDACTED]") }).strict())
      .max(100)
      .default([]),
    maxRecords: z.number().int().min(1).max(5000).default(500),
    maxPages: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export type DataImportPlan = z.infer<typeof DataImportPlanSchema>;
export type DataImportPlanInput = z.input<typeof DataImportPlanSchema>;
