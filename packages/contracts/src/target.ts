import { z } from "zod";
import { ErrorEnvelopeSchema } from "./errors.js";
import { ActorIdSchema, RunIdSchema, Sha256Schema, StableIdSchema } from "./identifiers.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

const RelativeModulePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "module path must stay inside the consumer repository",
  });

export const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const EnvironmentMappingSchema = z.record(EnvironmentNameSchema, EnvironmentNameSchema);
const HeaderMappingSchema = z.record(HeaderNameSchema, EnvironmentNameSchema);
const HttpTargetUrlSchema = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "HTTP target URL must use http or https",
});

export const TargetBindingKindSchema = z.enum(["direct", "http", "mcp", "cli"]);

/** Canonical, invocation-scoped values emitted by Firedrill protocol bindings. */
export const WorldBindingEnvironmentNameSchema = z.enum([
  "FIREDRILL_HTTP_URL",
  "FIREDRILL_HTTP_TOKEN",
  "FIREDRILL_MCP_URL",
  "FIREDRILL_MCP_TOKEN",
  "FIREDRILL_CLI_URL",
  "FIREDRILL_CLI_TOKEN",
]);

/**
 * Maps an environment variable already consumed by an agent to one canonical
 * Firedrill binding value. Canonical names remain present alongside aliases.
 */
export const BindingEnvironmentProjectionSchema = z
  .record(EnvironmentNameSchema, WorldBindingEnvironmentNameSchema)
  .superRefine((projection, context) => {
    for (const targetName of Object.keys(projection)) {
      if (targetName.startsWith("FIREDRILL_")) {
        context.addIssue({
          code: "custom",
          path: [targetName],
          message: "binding aliases cannot replace reserved FIREDRILL_* variables",
        });
      }
    }
  });

const InProcessBindingsSchema = z
  .array(TargetBindingKindSchema)
  .min(1)
  .max(4)
  .refine((bindings) => new Set(bindings).size === bindings.length, {
    message: "target bindings must be unique",
  });

const NetworkBindingsSchema = z
  .array(z.enum(["http", "mcp", "cli"]))
  .min(1)
  .max(3)
  .refine((bindings) => new Set(bindings).size === bindings.length, {
    message: "target bindings must be unique",
  });

export const TargetDescriptorSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        id: StableIdSchema,
        kind: z.literal("module"),
        bindings: InProcessBindingsSchema,
        bindingEnvironment: BindingEnvironmentProjectionSchema.optional(),
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
        bindingEnvironment: BindingEnvironmentProjectionSchema.optional(),
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
        bindingEnvironment: BindingEnvironmentProjectionSchema.optional(),
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
        bindingEnvironment: BindingEnvironmentProjectionSchema.optional(),
        timeoutMs: z.number().int().positive().max(86_400_000),
      })
      .strict(),
  ])
  .superRefine((descriptor, context) => {
    const available = new Set<string>();
    for (const binding of descriptor.bindings) {
      if (binding === "http") {
        available.add("FIREDRILL_HTTP_URL");
        available.add("FIREDRILL_HTTP_TOKEN");
      } else if (binding === "mcp") {
        available.add("FIREDRILL_MCP_URL");
        available.add("FIREDRILL_MCP_TOKEN");
      } else if (binding === "cli") {
        available.add("FIREDRILL_CLI_URL");
        available.add("FIREDRILL_CLI_TOKEN");
      }
    }
    for (const [targetName, sourceName] of Object.entries(descriptor.bindingEnvironment ?? {})) {
      if (!available.has(sourceName)) {
        context.addIssue({
          code: "custom",
          path: ["bindingEnvironment", targetName],
          message: `${sourceName} is unavailable because target ${descriptor.id} does not declare its protocol binding`,
        });
      }
      if (descriptor.kind === "command" && Object.hasOwn(descriptor.environmentFromHost, targetName)) {
        context.addIssue({
          code: "custom",
          path: ["bindingEnvironment", targetName],
          message: `${targetName} cannot come from both a world binding and the host environment`,
        });
      }
    }
  });

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

const PortableAttachmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message:
      "attachment name must be a portable file name using letters, numbers, dots, dashes, or underscores",
  })
  .refine((value) => value !== "." && value !== "..", {
    message: "attachment name cannot be a relative path segment",
  });

export const TargetFileAttachmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("file"),
    id: StableIdSchema,
    name: PortableAttachmentNameSchema,
    mediaType: z.string().min(1).max(200),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    hash: Sha256Schema,
    redaction: z
      .object({
        status: z.enum(["not_applied", "applied_by_caller"]),
        note: z.string().min(1).max(500).nullable().default(null),
      })
      .strict(),
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
    for (const [index, attachment] of result.attachments.entries()) {
      if (attachment.kind !== "file") continue;
      const parsed = TargetFileAttachmentSchema.safeParse(attachment);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["attachments", index, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  });

export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;
export type TargetBindingKind = z.infer<typeof TargetBindingKindSchema>;
export type BindingEnvironmentProjection = z.infer<typeof BindingEnvironmentProjectionSchema>;
export type WorldBindingEnvironmentName = z.infer<typeof WorldBindingEnvironmentNameSchema>;
export type TargetInvocation = z.infer<typeof TargetInvocationSchema>;
export type TargetResult = z.infer<typeof TargetResultSchema>;
export type TargetFileAttachment = z.infer<typeof TargetFileAttachmentSchema>;
