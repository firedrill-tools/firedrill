import { z } from "zod";
import { AssertionResultSchema } from "./assertions.js";
import { DrillTaskSchema } from "./drill.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import {
  ActorIdSchema,
  RunIdSchema,
  SeedSchema,
  Sha256Schema,
  StableIdSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "./identifiers.js";
import { TargetResultSchema } from "./target.js";
import { RunSetupRecordSchema } from "./setup.js";

export const RunPhaseSchema = z.enum([
  "created",
  "binding",
  "running",
  "settling",
  "verifying",
  "sealed",
  "runner_failed",
  "cancelled",
]);

export const BindingEvidenceSchema = z.enum([
  "not_checked",
  "issued",
  "route_verified",
  "observed",
  "enforced",
]);
export const WorldConsistencySchema = z.enum(["atomic", "degraded", "unknown"]);
export const VerdictSchema = z.enum(["passed", "failed", "inconclusive"]);

const EvidenceRangeSchema = z
  .object({
    fromSequence: z.number().int().positive().safe(),
    toSequence: z.number().int().positive().safe(),
  })
  .strict();

export const InteractionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    interactionId: StableIdSchema,
    actorId: ActorIdSchema,
    task: DrillTaskSchema,
    scheduledAtVirtualUs: VirtualTimeSchema,
    startedAtVirtualUs: VirtualTimeSchema,
    finishedAtVirtualUs: VirtualTimeSchema,
    bindingEvidence: BindingEvidenceSchema,
    targetResult: TargetResultSchema,
  })
  .strict()
  .superRefine((interaction, context) => {
    if (interaction.startedAtVirtualUs < interaction.scheduledAtVirtualUs) {
      context.addIssue({
        code: "custom",
        path: ["startedAtVirtualUs"],
        message: "interaction cannot start before its scheduled virtual time",
      });
    }
    if (interaction.finishedAtVirtualUs < interaction.startedAtVirtualUs) {
      context.addIssue({
        code: "custom",
        path: ["finishedAtVirtualUs"],
        message: "interaction cannot finish before it starts",
      });
    }
  });

export const CheckpointResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkpointId: StableIdSchema,
    kind: z.enum(["after_interaction", "after_event", "horizon", "final"]),
    interactionId: StableIdSchema.optional(),
    virtualTimeUs: VirtualTimeSchema,
    verdict: VerdictSchema,
    assertionResults: z.array(AssertionResultSchema).min(1),
  })
  .strict();

export const RunBudgetUsageSchema = z
  .object({
    toolCalls: z
      .object({
        limit: z.number().int().positive().safe(),
        attempted: z.number().int().nonnegative().safe(),
        rejected: z.number().int().nonnegative().safe(),
      })
      .strict(),
    scheduledEvents: z
      .object({
        limit: z.number().int().positive().safe(),
        processed: z.number().int().nonnegative().safe(),
        exhausted: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.toolCalls.rejected > usage.toolCalls.attempted) {
      context.addIssue({
        code: "custom",
        path: ["toolCalls", "rejected"],
        message: "rejected Tool calls cannot exceed attempted Tool calls",
      });
    }
    if (usage.scheduledEvents.processed > usage.scheduledEvents.limit) {
      context.addIssue({
        code: "custom",
        path: ["scheduledEvents", "processed"],
        message: "processed scheduled events cannot exceed the configured limit",
      });
    }
  });

export const RunIdentitySchema = z
  .object({
    runId: RunIdSchema,
    worldInstanceId: WorldInstanceIdSchema,
    drillId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    targetId: StableIdSchema,
    buildHash: Sha256Schema,
    packageLockHash: Sha256Schema,
    setupHash: Sha256Schema.optional(),
    seed: SeedSchema,
    trial: z.number().int().positive(),
    trialCount: z.number().int().positive(),
    attempt: z.number().int().positive().default(1),
    attemptLimit: z.number().int().positive().default(1),
  })
  .strict()
  .refine((identity) => identity.trial <= identity.trialCount, {
    path: ["trial"],
    message: "trial cannot exceed trialCount",
  })
  .refine((identity) => identity.attempt <= identity.attemptLimit, {
    path: ["attempt"],
    message: "attempt cannot exceed attemptLimit",
  });

export const RunProgressSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: RunIdentitySchema,
    phase: RunPhaseSchema,
    virtualTimeUs: VirtualTimeSchema,
    message: z.string().min(1).max(1000).optional(),
  })
  .passthrough();

const TerminalRunBase = {
  schemaVersion: z.literal(1),
  identity: RunIdentitySchema,
  setup: RunSetupRecordSchema.optional(),
  startedAtVirtualUs: VirtualTimeSchema,
  finishedAtVirtualUs: VirtualTimeSchema,
  bindingEvidence: BindingEvidenceSchema,
  worldConsistency: WorldConsistencySchema,
  interactions: z.array(InteractionResultSchema),
  checkpoints: z.array(CheckpointResultSchema),
  budgetUsage: RunBudgetUsageSchema,
};

const SealedRunSchema = z
  .object({
    ...TerminalRunBase,
    status: z.literal("sealed"),
    verdict: VerdictSchema,
    assertionResults: z.array(AssertionResultSchema),
    evidenceRange: EvidenceRangeSchema,
    stateHash: Sha256Schema,
    evidenceHash: Sha256Schema,
    trajectoryHash: Sha256Schema,
  })
  .passthrough();

const FailedRunSchema = z
  .object({
    ...TerminalRunBase,
    status: z.literal("runner_failed"),
    error: ErrorEnvelopeSchema,
    assertionResults: z.array(AssertionResultSchema).default([]),
    evidenceRange: EvidenceRangeSchema.optional(),
  })
  .passthrough();

const CancelledRunSchema = z
  .object({
    ...TerminalRunBase,
    status: z.literal("cancelled"),
    reason: z.string().min(1).max(1000),
    assertionResults: z.array(AssertionResultSchema).default([]),
    evidenceRange: EvidenceRangeSchema.optional(),
  })
  .passthrough();

export const RunResultSchema = z
  .discriminatedUnion("status", [SealedRunSchema, FailedRunSchema, CancelledRunSchema])
  .superRefine((result, context) => {
    if ((result.setup === undefined) !== (result.identity.setupHash === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["setup"],
        message: "run setup and identity setupHash must be present together",
      });
    }
    if (
      result.setup !== undefined &&
      (result.setup.setupHash !== result.identity.setupHash ||
        result.setup.drillId !== result.identity.drillId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["setup"],
        message: "run setup does not match run identity",
      });
    }
    if (result.finishedAtVirtualUs < result.startedAtVirtualUs) {
      context.addIssue({
        code: "custom",
        path: ["finishedAtVirtualUs"],
        message: "run cannot finish before it starts",
      });
    }
    if (
      result.evidenceRange !== undefined &&
      result.evidenceRange.toSequence < result.evidenceRange.fromSequence
    ) {
      context.addIssue({ code: "custom", path: ["evidenceRange"], message: "evidence range is reversed" });
    }
  });

export type RunResult = z.infer<typeof RunResultSchema>;
export type RunProgress = z.infer<typeof RunProgressSchema>;
export type BindingEvidence = z.infer<typeof BindingEvidenceSchema>;
export type InteractionResult = z.infer<typeof InteractionResultSchema>;
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;
export type RunBudgetUsage = z.infer<typeof RunBudgetUsageSchema>;
