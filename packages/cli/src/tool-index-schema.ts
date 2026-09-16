import {
  FidelitySchema,
  NodePackageNameSchema,
  OperationIdSchema,
  PackageIdSchema,
  SemverSchema,
} from "@firedrill/contracts";
import { z } from "zod";

// Indexes describe packages. They never grant permission to install or execute one.
const plainText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}]*$/u);
const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .regex(/^https:\/\/[^/?#\s@]+(?:\/[^?#\s]*)?$/u);

export const ToolIndexSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npm") }).strict(),
  z
    .object({
      kind: z.literal("git"),
      url: httpsUrl,
      commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
      subdirectory: z
        .string()
        .min(1)
        .max(512)
        .regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u)
        .optional(),
    })
    .strict(),
]);

export const ToolIndexEntrySchema = z
  .object({
    packageName: NodePackageNameSchema,
    packageVersion: SemverSchema.max(128),
    title: plainText(160).optional(),
    description: plainText(2048),
    lifecycle: z.enum(["active", "deprecated", "revoked"]),
    keywords: z.array(plainText(96)).max(64).default([]),
    source: ToolIndexSourceSchema.optional(),
    tool: z
      .object({
        id: PackageIdSchema,
        operations: z
          .array(z.object({ id: OperationIdSchema, fidelity: FidelitySchema }).passthrough())
          .min(1)
          .max(256),
        compatibility: z
          .array(z.object({ limitations: z.array(plainText(2048)).max(128) }).passthrough())
          .max(64)
          .default([]),
      })
      .passthrough(),
  })
  .passthrough();

/** Versioned discovery metadata; source/package conformance is checked separately. */
export const ToolIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    packages: z.array(ToolIndexEntrySchema).max(1000),
  })
  .passthrough()
  .superRefine((index, context) => {
    const packages = new Set<string>();
    for (const [entryIndex, entry] of index.packages.entries()) {
      const key = `${entry.packageName}@${entry.packageVersion}`;
      if (packages.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Each package name and version must appear only once.",
          path: ["packages", entryIndex, "packageName"],
        });
      }
      packages.add(key);
      const operations = new Set<string>();
      for (const [operationIndex, operation] of entry.tool.operations.entries()) {
        if (operations.has(operation.id)) {
          context.addIssue({
            code: "custom",
            message: "Each operation ID must appear only once in a Tool.",
            path: ["packages", entryIndex, "tool", "operations", operationIndex, "id"],
          });
        }
        operations.add(operation.id);
      }
    }
  });

export type ToolIndex = z.infer<typeof ToolIndexSchema>;
export type ToolIndexEntry = z.infer<typeof ToolIndexEntrySchema>;
export type ToolIndexSource = z.infer<typeof ToolIndexSourceSchema>;

export function toolIndexJsonSchema() {
  return {
    $id: "https://firedrill.run/schema/v1/tool-index.json",
    ...z.toJSONSchema(ToolIndexSchema, { target: "draft-2020-12", io: "input" }),
  };
}
