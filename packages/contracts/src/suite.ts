import { z } from "zod";
import { StableIdSchema } from "./identifiers.js";
import { compareStableStrings } from "./json.js";

export const DrillShardSchema = z
  .object({
    /** Zero-based shard index. */
    index: z.number().int().nonnegative().safe(),
    total: z.number().int().positive().max(1_000).safe(),
  })
  .strict()
  .refine((shard) => shard.index < shard.total, {
    path: ["index"],
    message: "shard index must be less than shard total",
  });

/**
 * Repository-owned selection and execution policy. Explicit drill ids and tags
 * form a union; leaving both empty selects every drill in the repository.
 */
export const DrillSuiteDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    drills: z.array(StableIdSchema).default([]),
    tags: z.array(StableIdSchema).default([]),
    trials: z.number().int().positive().max(10_000).optional(),
    concurrency: z.number().int().positive().max(64).default(1),
    retries: z.number().int().nonnegative().max(10).default(0),
  })
  .strict()
  .superRefine((suite, context) => {
    for (const key of ["drills", "tags"] as const) {
      const values = suite[key];
      for (const [index, value] of values.entries()) {
        if (values.indexOf(value) !== index) {
          context.addIssue({
            code: "custom",
            path: [key, index],
            message: `duplicate ${key === "drills" ? "drill" : "tag"} ${value}`,
          });
        }
        if (index > 0 && compareStableStrings(values[index - 1] ?? "", value) >= 0) {
          context.addIssue({
            code: "custom",
            path: [key, index],
            message: `${key} must be sorted by stable identity`,
          });
        }
      }
    }
  });

export type DrillShard = z.infer<typeof DrillShardSchema>;
export type DrillSuiteDefinition = z.infer<typeof DrillSuiteDefinitionSchema>;
