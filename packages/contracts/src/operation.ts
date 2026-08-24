import { z } from "zod";
import {
  ActorBindingIdSchema,
  CallIdSchema,
  CorrelationIdSchema,
  EventIdSchema,
  EventRefSchema,
  OperationIdSchema,
  OperationRefSchema,
  PackageIdSchema,
  SemverSchema,
  StableIdSchema,
} from "./identifiers.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

export const FidelitySchema = z.enum(["contract", "stateful", "behavioral", "validated"]);

export const ToolCapabilitySchema = z.enum([
  "state.read",
  "state.write",
  "clock.read",
  "clock.schedule",
  "random.draw",
  "event.emit",
]);

export const OperationContractSchema = z
  .object({
    id: OperationIdSchema,
    description: z.string().min(1).max(1000).optional(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    declaredErrors: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    idempotency: z.enum(["none", "optional", "required"]),
    fidelity: FidelitySchema,
  })
  .strict();

export const ToolEventContractSchema = z
  .object({
    id: EventIdSchema,
    payloadSchema: JsonObjectSchema,
  })
  .strict();

export const ToolStateContractSchema = z
  .object({
    namespace: StableIdSchema,
    schema: JsonObjectSchema,
    description: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const ToolFaultContractSchema = z
  .object({
    id: StableIdSchema,
    appliesTo: z.array(OperationIdSchema).min(1),
    timing: z.enum(["before", "after_commit"]),
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string().min(1).max(1000),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ToolSubscriptionContractSchema = z
  .object({
    id: StableIdSchema,
    event: EventRefSchema,
  })
  .strict();

export const ToolPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: PackageIdSchema,
    version: SemverSchema,
    engine: z.string().min(1).max(128),
    capabilities: z.array(ToolCapabilitySchema),
    state: z.array(ToolStateContractSchema).default([]),
    operations: z.array(OperationContractSchema).min(1),
    events: z.array(ToolEventContractSchema).default([]),
    faults: z.array(ToolFaultContractSchema).default([]),
    subscriptions: z.array(ToolSubscriptionContractSchema).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, operation] of manifest.operations.entries()) {
      if (seen.has(operation.id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "id"],
          message: "duplicate operation id",
        });
      }
      seen.add(operation.id);
    }
    const operationIds = new Set(manifest.operations.map((operation) => operation.id));
    const operationsById = new Map(manifest.operations.map((operation) => [operation.id, operation]));
    for (const [index, fault] of manifest.faults.entries()) {
      for (const operationId of fault.appliesTo) {
        if (!operationIds.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: ["faults", index, "appliesTo"],
            message: `fault references unknown operation ${operationId}`,
          });
        } else if (!operationsById.get(operationId)?.declaredErrors.includes(fault.error.code)) {
          context.addIssue({
            code: "custom",
            path: ["faults", index, "error", "code"],
            message: `fault error ${fault.error.code} is not declared by operation ${operationId}`,
          });
        }
      }
    }
    for (const [field, values] of [
      ["events", manifest.events.map((event) => event.id)],
      ["faults", manifest.faults.map((fault) => fault.id)],
      ["subscriptions", manifest.subscriptions.map((subscription) => subscription.id)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not contain duplicate ids`,
        });
      }
    }
    for (const [field, values] of [
      ["capabilities", manifest.capabilities],
      ["state", manifest.state.map((state) => state.namespace)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates` });
      }
    }
  });

export const OperationInvocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    callId: CallIdSchema,
    correlationId: CorrelationIdSchema,
    operation: OperationRefSchema,
    actorBindingId: ActorBindingIdSchema,
    arguments: JsonObjectSchema,
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict();

export const OperationOutcomeStatusSchema = z.enum(["ok", "denied", "tool_error", "unsupported", "invalid"]);

export const OperationOutcomeSchema = z
  .object({
    status: OperationOutcomeStatusSchema,
    value: JsonValueSchema.optional(),
    error: ErrorEnvelopeSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.status === "ok" && outcome.value === undefined) {
      context.addIssue({ code: "custom", path: ["value"], message: "successful operation requires a value" });
    }
    if (outcome.status === "ok" && outcome.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "successful operation cannot carry an error",
      });
    }
    if (outcome.status !== "ok" && outcome.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "unsuccessful operation requires an error",
      });
    }
    if (outcome.status !== "ok" && outcome.value !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "unsuccessful operation cannot carry a value",
      });
    }
  });

export type OperationContract = z.infer<typeof OperationContractSchema>;
export type ToolEventContract = z.infer<typeof ToolEventContractSchema>;
export type ToolStateContract = z.infer<typeof ToolStateContractSchema>;
export type ToolFaultContract = z.infer<typeof ToolFaultContractSchema>;
export type ToolSubscriptionContract = z.infer<typeof ToolSubscriptionContractSchema>;
export type ToolPackageManifest = z.infer<typeof ToolPackageManifestSchema>;
export type OperationInvocation = z.infer<typeof OperationInvocationSchema>;
export type OperationOutcome = z.infer<typeof OperationOutcomeSchema>;
