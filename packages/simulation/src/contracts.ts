import {
  ActorDefinitionSchema,
  ActorBindingIdSchema,
  AssertionStatusSchema,
  CallbackDeliveryIdSchema,
  CallbackRefSchema,
  CorrelationIdSchema,
  DiagnosticSchema,
  ErrorEnvelopeSchema,
  EventIdSchema,
  EventRefSchema,
  EvidenceEntrySchema,
  FaultActivationSchema,
  InitialEventSchema,
  JsonObjectSchema,
  OperationIdSchema,
  PackageIdSchema,
  RunIdSchema,
  RunResultSchema,
  ScheduledEventIdSchema,
  SeedSchema,
  Sha256Schema,
  StableIdSchema,
  StateSetupSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "@firedrill/contracts";
import { z } from "zod";

const RelativeSourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."), {
    message: "source path must be repository-relative",
  });

const SourceReferenceSchema = z
  .object({
    path: RelativeSourcePathSchema,
    contentHash: Sha256Schema,
  })
  .strict();

const ScenarioSetupViewSchema = z
  .object({
    virtualTimeUs: VirtualTimeSchema,
    actors: z.array(ActorDefinitionSchema),
    state: z.array(StateSetupSchema),
    faults: z.array(FaultActivationSchema),
    initialEvents: z.array(InitialEventSchema),
  })
  .strict();

const ScenarioViewSchema = ScenarioSetupViewSchema.extend({
  id: StableIdSchema,
  title: z.string().min(1).max(200).optional(),
  source: SourceReferenceSchema.optional(),
}).strict();

const OperationViewSchema = z
  .object({
    id: OperationIdSchema,
    description: z.string().min(1).max(1000).optional(),
    fidelity: z.enum(["contract", "stateful", "behavioral", "validated"]),
    idempotency: z.enum(["none", "optional", "required"]),
  })
  .strict();

const ToolViewSchema = z
  .object({
    id: PackageIdSchema,
    version: z.string().min(1).max(128),
    operations: z.array(OperationViewSchema),
    stateNamespaces: z.array(StableIdSchema),
    events: z.array(EventIdSchema),
    faults: z.array(StableIdSchema),
    httpRoutes: z.array(
      z
        .object({
          id: StableIdSchema,
          operationId: OperationIdSchema,
          method: z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]),
          path: z.string().min(1).max(512),
        })
        .strict(),
    ),
    source: SourceReferenceSchema.optional(),
  })
  .strict();

const TargetViewSchema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(["module", "command", "http", "external"]),
    bindings: z.array(z.enum(["direct", "http", "mcp", "cli"])),
    runAvailability: z.enum(["ready", "agent_callback_required"]),
    source: SourceReferenceSchema.optional(),
  })
  .strict();

const DrillViewSchema = z
  .object({
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    tags: z.array(StableIdSchema),
    targetId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    inlineScenario: z.boolean(),
    trials: z
      .object({
        count: z.number().int().positive().max(10_000),
        classification: z.enum(["contract", "safety", "quality"]),
      })
      .strict(),
    timeline: z
      .object({
        interactions: z.number().int().nonnegative(),
        workloads: z.number().int().nonnegative(),
        horizonUs: VirtualTimeSchema,
        maxToolCalls: z.number().int().positive(),
        maxEvents: z.number().int().positive(),
      })
      .strict(),
    assertions: z.number().int().positive(),
    expectations: z.array(
      z
        .object({
          id: StableIdSchema,
          kind: z.enum([
            "state.value",
            "state.count",
            "operation.count",
            "operation.order",
            "operation.arguments",
            "operation.denied",
            "event.count",
            "callback.count",
          ]),
          gate: z.boolean(),
          checkpoint: z.enum(["invariant", "final"]),
        })
        .strict(),
    ),
    source: SourceReferenceSchema.optional(),
  })
  .strict();

const SuiteViewSchema = z
  .object({
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    drills: z.array(StableIdSchema),
    tags: z.array(StableIdSchema),
    trials: z.number().int().positive().max(10_000).optional(),
    concurrency: z.number().int().positive().max(64),
    retries: z.number().int().nonnegative().max(10),
    source: SourceReferenceSchema.optional(),
  })
  .strict();

export const SimulationProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    world: z
      .object({
        id: StableIdSchema,
        title: z.string().min(1).max(200).optional(),
        seed: SeedSchema,
        buildHash: Sha256Schema,
        packageLockHash: Sha256Schema,
        baseline: ScenarioSetupViewSchema,
        source: SourceReferenceSchema.optional(),
      })
      .strict(),
    scenarios: z.array(ScenarioViewSchema),
    tools: z.array(ToolViewSchema),
    targets: z.array(TargetViewSchema),
    drills: z.array(DrillViewSchema),
    suites: z.array(SuiteViewSchema),
    diagnostics: z.array(DiagnosticSchema),
  })
  .strict();

export const SimulationRunStatusSchema = z.enum([
  "running",
  "cancelling",
  "sealed",
  "runner_failed",
  "cancelled",
]);

export const SimulationRunSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    requestId: StableIdSchema.optional(),
    worldInstanceId: WorldInstanceIdSchema,
    drillId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    targetId: StableIdSchema,
    seed: SeedSchema,
    trial: z.number().int().positive(),
    trialCount: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attemptLimit: z.number().int().positive(),
    status: SimulationRunStatusSchema,
    verdict: z.enum(["passed", "failed", "inconclusive"]).optional(),
    virtualTimeUs: VirtualTimeSchema,
    evidenceSequence: z.number().int().nonnegative().safe(),
    reportAvailable: z.boolean(),
  })
  .strict();

export const SimulationRunListSchema = z
  .object({
    schemaVersion: z.literal(1),
    runs: z.array(SimulationRunSummarySchema),
    unavailable: z.array(
      z
        .object({
          runId: RunIdSchema,
          code: z.string().min(1).max(128),
          message: z.string().min(1).max(1000),
        })
        .strict(),
    ),
  })
  .strict();

export const SimulationRunDetailSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: SimulationRunSummarySchema,
    result: RunResultSchema.optional(),
    stateNamespaces: z.array(
      z
        .object({
          packageId: PackageIdSchema,
          namespace: StableIdSchema,
          records: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
    faults: z.array(z.object({ packageId: PackageIdSchema, faultId: StableIdSchema }).strict()),
    scheduledEvents: z.array(
      z
        .object({
          id: ScheduledEventIdSchema,
          event: EventRefSchema,
          payload: JsonObjectSchema,
          dueUs: VirtualTimeSchema,
          correlationId: CorrelationIdSchema,
          actorBindingId: ActorBindingIdSchema,
          causeSequence: z.number().int().positive().safe(),
          status: z.enum(["pending", "fired", "failed", "cancelled"]),
        })
        .strict(),
    ),
    callbackDeliveries: z.array(
      z
        .object({
          id: CallbackDeliveryIdSchema,
          callback: CallbackRefSchema,
          receiverId: StableIdSchema,
          event: EventRefSchema,
          payload: JsonObjectSchema,
          eventSequence: z.number().int().positive().safe(),
          dueUs: VirtualTimeSchema,
          correlationId: CorrelationIdSchema,
          actorBindingId: ActorBindingIdSchema,
          status: z.enum(["pending", "in_flight", "delivered", "failed"]),
          attemptCount: z.number().int().nonnegative().safe(),
          retryDelaysUs: z.array(VirtualTimeSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const SimulationEvidencePageSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    fromSequence: z.number().int().positive().safe(),
    entries: z.array(EvidenceEntrySchema),
    nextSequence: z.number().int().positive().safe(),
  })
  .strict();

export const SimulationStatePageSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    packageId: PackageIdSchema,
    namespace: StableIdSchema,
    records: z.array(
      z
        .object({
          rowId: z.string().min(1).max(512),
          value: JsonObjectSchema,
        })
        .strict(),
    ),
    nextRowId: z.string().min(1).max(512).optional(),
  })
  .strict();

export const SimulationRunRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: StableIdSchema,
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("drill"), id: StableIdSchema }).strict(),
      z.object({ kind: z.literal("suite"), id: StableIdSchema }).strict(),
    ]),
    status: z.enum(["starting", "running", "cancelling", "completed", "failed", "cancelled"]),
    runIds: z.array(RunIdSchema),
    verdict: z.enum(["passed", "failed", "inconclusive"]).optional(),
    error: ErrorEnvelopeSchema.optional(),
  })
  .strict();

export const SimulationRunRequestListSchema = z
  .object({
    schemaVersion: z.literal(1),
    requests: z.array(SimulationRunRequestSchema),
  })
  .strict();

export const CompareSimulationRunsSchema = z
  .object({
    baselineRunId: RunIdSchema,
    candidateRunId: RunIdSchema,
  })
  .strict()
  .refine((value) => value.baselineRunId !== value.candidateRunId, {
    path: ["candidateRunId"],
    message: "candidateRunId must identify a different run",
  });

const ComparedSimulationRunSchema = z
  .object({
    runId: RunIdSchema,
    status: z.enum(["sealed", "runner_failed", "cancelled"]),
    verdict: z.enum(["passed", "failed", "inconclusive"]).optional(),
    drillId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    targetId: StableIdSchema,
    seed: SeedSchema,
    buildHash: Sha256Schema,
    packageLockHash: Sha256Schema,
    stateHash: Sha256Schema.optional(),
    trajectoryHash: Sha256Schema.optional(),
  })
  .strict();

const CountDeltaSchema = z
  .object({
    subject: z.string().min(1).max(1024),
    baseline: z.number().int().nonnegative().safe(),
    candidate: z.number().int().nonnegative().safe(),
    delta: z.number().int().safe(),
  })
  .strict();

export const SimulationRunComparisonSchema = z
  .object({
    schemaVersion: z.literal(1),
    compatibility: z
      .object({
        status: z.enum(["exact_inputs", "descriptive_only", "incompatible"]),
        canAttributeBehaviorChange: z.boolean(),
        differences: z.array(z.enum(["drill", "scenario", "target", "seed", "build", "package_lock"])),
        explanation: z.string().min(1).max(2000),
      })
      .strict(),
    outcome: z.enum(["unchanged", "changed", "not_comparable"]),
    baseline: ComparedSimulationRunSchema,
    candidate: ComparedSimulationRunSchema,
    changes: z
      .object({
        verdictChanged: z.boolean(),
        stateChanged: z.boolean().optional(),
        trajectoryChanged: z.boolean().optional(),
        operationCounts: z.array(
          CountDeltaSchema.extend({
            baselineErrors: z.number().int().nonnegative().safe(),
            candidateErrors: z.number().int().nonnegative().safe(),
          }).strict(),
        ),
        stateChangeCounts: z.array(CountDeltaSchema),
        eventCounts: z.array(CountDeltaSchema),
        assertions: z.array(
          z
            .object({
              checkpointId: z.string().min(1).max(512),
              assertionId: z.string().min(1).max(512),
              baseline: AssertionStatusSchema.optional(),
              candidate: AssertionStatusSchema.optional(),
              actualChanged: z.boolean(),
            })
            .strict(),
        ),
        interactions: z.array(
          z
            .object({
              interactionId: z.string().min(1).max(512),
              baseline: z.string().min(1).max(128).optional(),
              candidate: z.string().min(1).max(128).optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const StartSimulationRunSchema = z.union([
  z
    .object({
      drillId: StableIdSchema,
      seed: SeedSchema.optional(),
      trials: z.number().int().positive().max(10_000).optional(),
      retries: z.number().int().nonnegative().max(10).optional(),
      concurrency: z.number().int().positive().max(64).optional(),
    })
    .strict(),
  z
    .object({
      suiteId: StableIdSchema,
      seed: SeedSchema.optional(),
      trials: z.number().int().positive().max(10_000).optional(),
      retries: z.number().int().nonnegative().max(10).optional(),
      concurrency: z.number().int().positive().max(64).optional(),
    })
    .strict(),
]);

export const SimulationApiErrorSchema = z
  .object({
    schemaVersion: z.literal(1),
    error: ErrorEnvelopeSchema,
  })
  .strict();

export type SimulationProject = z.infer<typeof SimulationProjectSchema>;
export type SimulationRunSummary = z.infer<typeof SimulationRunSummarySchema>;
export type SimulationRunList = z.infer<typeof SimulationRunListSchema>;
export type SimulationRunDetail = z.infer<typeof SimulationRunDetailSchema>;
export type SimulationEvidencePage = z.infer<typeof SimulationEvidencePageSchema>;
export type SimulationStatePage = z.infer<typeof SimulationStatePageSchema>;
export type SimulationRunRequest = z.infer<typeof SimulationRunRequestSchema>;
export type SimulationRunRequestList = z.infer<typeof SimulationRunRequestListSchema>;
export type CompareSimulationRuns = z.infer<typeof CompareSimulationRunsSchema>;
export type SimulationRunComparison = z.infer<typeof SimulationRunComparisonSchema>;
export type StartSimulationRun = z.infer<typeof StartSimulationRunSchema>;
export type SimulationApiError = z.infer<typeof SimulationApiErrorSchema>;
