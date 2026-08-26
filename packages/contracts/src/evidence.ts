import { z } from "zod";
import { AssertionResultSchema } from "./assertions.js";
import {
  ActorBindingIdSchema,
  ActorIdSchema,
  CallbackDeliveryIdSchema,
  CallbackRefSchema,
  CorrelationIdSchema,
  EventRefSchema,
  OperationRefSchema,
  PackageIdSchema,
  ScheduledEventIdSchema,
  Sha256Schema,
  StableIdSchema,
  SnapshotIdSchema,
  TransactionIdSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "./identifiers.js";
import { JsonObjectSchema } from "./json.js";
import {
  OperationIdempotencyDispositionSchema,
  OperationInvocationSchema,
  OperationOutcomeSchema,
} from "./operation.js";

const EvidenceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive().safe(),
  transactionId: TransactionIdSchema,
  transactionIndex: z.number().int().nonnegative(),
  transactionSize: z.number().int().positive(),
  virtualTimeUs: VirtualTimeSchema,
  causeSequence: z.number().int().positive().safe().optional(),
  correlationId: CorrelationIdSchema,
});

export const OperationEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("operation"),
  invocation: OperationInvocationSchema,
  actorId: ActorIdSchema.optional(),
  outcome: OperationOutcomeSchema,
  idempotency: OperationIdempotencyDispositionSchema,
  replayedFromSequence: z.number().int().positive().safe().optional(),
}).passthrough();

export const StateChangeEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("state_change"),
  packageId: PackageIdSchema,
  namespace: StableIdSchema,
  rowId: z.string().min(1).max(512),
  change: z.enum(["insert", "update", "delete"]),
  before: JsonObjectSchema.nullable(),
  after: JsonObjectSchema.nullable(),
  deltaHash: Sha256Schema,
}).passthrough();

export const EventEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("event"),
  event: EventRefSchema,
  phase: z.enum(["emitted", "scheduled", "handled", "failed"]),
  payload: JsonObjectSchema,
  scheduledEventId: ScheduledEventIdSchema.optional(),
  scheduledForUs: VirtualTimeSchema.optional(),
  handlerPackageId: PackageIdSchema.optional(),
  subscriptionId: StableIdSchema.optional(),
}).passthrough();

export const CallbackRequestEvidenceSchema = z
  .object({
    method: z.enum(["POST", "PUT"]),
    path: z.string().min(1).max(512),
    bodyHash: Sha256Schema,
    bodyBytes: z.number().int().nonnegative().safe(),
    signature: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({
          kind: z.literal("hmac-sha256"),
          header: z.string().min(1).max(128),
        })
        .strict(),
    ]),
  })
  .strict();

export const CallbackResponseEvidenceSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.string().max(65_536),
    bodyHash: Sha256Schema,
    bodyBytes: z.number().int().nonnegative().max(65_536),
  })
  .strict();

export const CallbackErrorEvidenceSchema = z
  .object({
    code: z.string().regex(/^framework\.[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();

export const CallbackEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("callback"),
  callback: CallbackRefSchema,
  deliveryId: CallbackDeliveryIdSchema,
  receiverId: StableIdSchema,
  event: EventRefSchema,
  phase: z.enum(["queued", "attempt_started", "delivered", "retry_scheduled", "failed", "recovered"]),
  attempt: z.number().int().positive().max(10).optional(),
  idempotencyKey: z.string().min(1).max(128),
  scheduledForUs: VirtualTimeSchema.optional(),
  request: CallbackRequestEvidenceSchema.optional(),
  response: CallbackResponseEvidenceSchema.optional(),
  error: CallbackErrorEvidenceSchema.optional(),
  durationMs: z.number().finite().nonnegative().max(60_000).optional(),
}).passthrough();

export const FaultEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("fault"),
  packageId: PackageIdSchema,
  faultId: StableIdSchema,
  operation: OperationRefSchema,
  timing: z.enum(["before", "after_commit"]),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
}).passthrough();

export const RandomEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("random"),
  packageId: PackageIdSchema,
  draw: z.number().int().positive().safe(),
  value: z.string().regex(/^(0|[1-9]\d{0,19})$/),
}).passthrough();

export const ClockEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("clock"),
  fromUs: VirtualTimeSchema,
  toUs: VirtualTimeSchema,
  reason: z.enum(["scenario", "explicit", "scheduled_work", "reset"]),
})
  .passthrough()
  .refine((entry) => entry.toUs >= entry.fromUs, {
    path: ["toUs"],
    message: "virtual clock cannot move backward",
  });

export const LifecycleEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("lifecycle"),
  action: z.enum(["world_created", "snapshot_created", "world_reset", "world_forked", "world_closed"]),
  worldInstanceId: WorldInstanceIdSchema,
  snapshotId: SnapshotIdSchema.optional(),
  actorBindingId: ActorBindingIdSchema.optional(),
  details: JsonObjectSchema.optional(),
}).passthrough();

export const VerificationEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("verification"),
  checkpointId: StableIdSchema,
  checkpointKind: z.enum(["after_interaction", "after_event", "horizon", "final"]),
  interactionId: StableIdSchema.optional(),
  result: AssertionResultSchema,
}).passthrough();

export const EvidenceEntrySchema = z
  .discriminatedUnion("kind", [
    OperationEvidenceSchema,
    StateChangeEvidenceSchema,
    EventEvidenceSchema,
    CallbackEvidenceSchema,
    FaultEvidenceSchema,
    RandomEvidenceSchema,
    ClockEvidenceSchema,
    LifecycleEvidenceSchema,
    VerificationEvidenceSchema,
  ])
  .superRefine((entry, context) => {
    if (entry.transactionIndex >= entry.transactionSize) {
      context.addIssue({
        code: "custom",
        path: ["transactionIndex"],
        message: "transaction index must be smaller than transaction size",
      });
    }
    if (entry.causeSequence !== undefined && entry.causeSequence >= entry.sequence) {
      context.addIssue({
        code: "custom",
        path: ["causeSequence"],
        message: "a cause must precede its consequence",
      });
    }
    if (entry.kind === "operation" && entry.correlationId !== entry.invocation.correlationId) {
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "operation evidence correlation must match its invocation",
      });
    }
    if (entry.kind === "operation") {
      const replayCoherent =
        (entry.idempotency === "replayed" && entry.replayedFromSequence !== undefined) ||
        (entry.idempotency !== "replayed" && entry.replayedFromSequence === undefined);
      if (!replayCoherent) {
        context.addIssue({
          code: "custom",
          path: ["replayedFromSequence"],
          message: "only replayed idempotent operations identify an earlier sequence",
        });
      }
    }
    if (entry.kind === "state_change") {
      const valid =
        (entry.change === "insert" && entry.before === null && entry.after !== null) ||
        (entry.change === "update" && entry.before !== null && entry.after !== null) ||
        (entry.change === "delete" && entry.before !== null && entry.after === null);
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["change"],
          message: "state change does not match before/after values",
        });
      }
    }
    if (entry.kind === "clock" && entry.virtualTimeUs !== entry.toUs) {
      context.addIssue({
        code: "custom",
        path: ["virtualTimeUs"],
        message: "clock evidence virtualTimeUs must equal toUs",
      });
    }
    if (entry.kind === "event") {
      const hasCompleteHandler = entry.handlerPackageId !== undefined && entry.subscriptionId !== undefined;
      const hasPartialHandler =
        (entry.handlerPackageId === undefined) !== (entry.subscriptionId === undefined);
      const deliveryFieldsCoherent =
        !hasPartialHandler && (entry.phase === "handled" ? hasCompleteHandler : true);
      if (!deliveryFieldsCoherent) {
        context.addIssue({
          code: "custom",
          path: ["handlerPackageId"],
          message: "handled and failed events require both handler package and subscription ids",
        });
      }
      if (entry.phase === "scheduled" && entry.scheduledForUs === undefined) {
        context.addIssue({
          code: "custom",
          path: ["scheduledForUs"],
          message: "scheduled event evidence requires a due time",
        });
      }
    }
    if (entry.kind === "callback") {
      if (
        (entry.phase === "queued" || entry.phase === "retry_scheduled" || entry.phase === "recovered") &&
        entry.scheduledForUs === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["scheduledForUs"],
          message: `${entry.phase} callback evidence requires a scheduled time`,
        });
      }
      if (entry.phase !== "queued" && entry.attempt === undefined) {
        context.addIssue({
          code: "custom",
          path: ["attempt"],
          message: `${entry.phase} callback evidence requires an attempt number`,
        });
      }
      if (entry.phase === "attempt_started" && entry.request === undefined) {
        context.addIssue({
          code: "custom",
          path: ["request"],
          message: "attempted callback evidence requires request metadata",
        });
      }
      if (entry.phase === "delivered" && entry.response === undefined) {
        context.addIssue({
          code: "custom",
          path: ["response"],
          message: "delivered callback evidence requires a response",
        });
      }
      if (
        (entry.phase === "retry_scheduled" || entry.phase === "failed") &&
        entry.response === undefined &&
        entry.error === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: `${entry.phase} callback evidence requires a response or error`,
        });
      }
    }
  });

export const EvidencePageSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(EvidenceEntrySchema),
    nextSequence: z.number().int().positive().safe().optional(),
  })
  .passthrough()
  .superRefine((page, context) => {
    for (let index = 1; index < page.entries.length; index += 1) {
      const previous = page.entries[index - 1];
      const current = page.entries[index];
      if (previous !== undefined && current !== undefined && current.sequence <= previous.sequence) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sequence"],
          message: "evidence is not ordered",
        });
      }
    }
  });

export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
export type EvidencePage = z.infer<typeof EvidencePageSchema>;
export type OperationEvidence = z.infer<typeof OperationEvidenceSchema>;
export type StateChangeEvidence = z.infer<typeof StateChangeEvidenceSchema>;
export type EventEvidence = z.infer<typeof EventEvidenceSchema>;
export type CallbackEvidence = z.infer<typeof CallbackEvidenceSchema>;
export type CallbackRequestEvidence = z.infer<typeof CallbackRequestEvidenceSchema>;
export type CallbackResponseEvidence = z.infer<typeof CallbackResponseEvidenceSchema>;
export type CallbackErrorEvidence = z.infer<typeof CallbackErrorEvidenceSchema>;
export type FaultEvidence = z.infer<typeof FaultEvidenceSchema>;
export type RandomEvidence = z.infer<typeof RandomEvidenceSchema>;
export type ClockEvidence = z.infer<typeof ClockEvidenceSchema>;
export type LifecycleEvidence = z.infer<typeof LifecycleEvidenceSchema>;
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
