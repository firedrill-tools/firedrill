import { z } from "zod";
import { ErrorEnvelopeSchema } from "./errors.js";
import { ActorIdSchema, RunIdSchema, StableIdSchema } from "./identifiers.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

const RelativeModulePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "module path must stay inside the consumer repository",
  });

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const EnvironmentMappingSchema = z.record(EnvironmentNameSchema, EnvironmentNameSchema);
const HeaderMappingSchema = z.record(HeaderNameSchema, EnvironmentNameSchema);
const HttpTargetUrlSchema = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "HTTP target URL must use http or https",
});

export const TargetBindingKindSchema = z.enum(["direct", "http", "mcp"]);

const InProcessBindingsSchema = z
  .array(TargetBindingKindSchema)
  .min(1)
  .max(3)
  .refine((bindings) => new Set(bindings).size === bindings.length, {
    message: "target bindings must be unique",
  });

const NetworkBindingsSchema = z
  .array(z.enum(["http", "mcp"]))
  .min(1)
  .max(2)
  .refine((bindings) => new Set(bindings).size === bindings.length, {
    message: "target bindings must be unique",
  });

export const TargetDescriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: StableIdSchema,
      kind: z.literal("module"),
      bindings: InProcessBindingsSchema,
      module: RelativeModulePathSchema,
      export: z.string().min(1).max(128).default("default"),
      timeoutMs: z.number().int().positive().max(3_600_000),
    })
    .strict(),
  z
    .object({
      id: StableIdSchema,
      kind: z.literal("command"),
      bindings: NetworkBindingsSchema,
      executable: z.string().min(1).max(1024),
      arguments: z.array(z.string().max(4096)).default([]),
      workingDirectory: RelativeModulePathSchema.optional(),
      environmentFromHost: EnvironmentMappingSchema.default({}),
      timeoutMs: z.number().int().positive().max(3_600_000),
    })
    .strict(),
  z
    .object({
      id: StableIdSchema,
      kind: z.literal("http"),
      bindings: NetworkBindingsSchema,
      url: HttpTargetUrlSchema,
      method: z.enum(["POST", "PUT"]),
      headersFromEnvironment: HeaderMappingSchema.default({}),
      timeoutMs: z.number().int().positive().max(3_600_000),
    })
    .strict(),
  z
    .object({
      id: StableIdSchema,
      kind: z.literal("external"),
      bindings: InProcessBindingsSchema,
      timeoutMs: z.number().int().positive().max(86_400_000),
    })
    .strict(),
]);

export const TargetInvocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    interactionId: StableIdSchema,
    actorId: ActorIdSchema,
    instruction: z.string().min(1).max(20_000),
    input: JsonValueSchema.optional(),
    bindingEnvironment: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const TargetResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["completed", "failed", "timed_out", "cancelled"]),
    output: JsonValueSchema.optional(),
    attachments: z.array(JsonObjectSchema).default([]),
    error: ErrorEnvelopeSchema.optional(),
  })
  .passthrough()
  .superRefine((result, context) => {
    if (result.status === "completed" && result.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "completed target cannot carry an error",
      });
    }
    if (result.status !== "completed" && result.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: `${result.status} target requires an error`,
      });
    }
  });

export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;
export type TargetBindingKind = z.infer<typeof TargetBindingKindSchema>;
export type TargetInvocation = z.infer<typeof TargetInvocationSchema>;
export type TargetResult = z.infer<typeof TargetResultSchema>;
