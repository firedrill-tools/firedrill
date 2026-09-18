import {
  ActorBindingIdSchema,
  ActorDefinitionSchema,
  AssertionDefinitionSchema,
  AssertionStatusSchema,
  CallbackDeliveryIdSchema,
  CallbackRefSchema,
  CorrelationIdSchema,
  DiagnosticSchema,
  DrillTimelineSchema,
  ErrorEnvelopeSchema,
  EventIdSchema,
  EventRefSchema,
  EvidenceEntrySchema,
  FaultActivationSchema,
  InitialEventSchema,
  JsonObjectSchema,
  NodePackageNameSchema,
  OperationIdSchema,
  PackageIdSchema,
  ResolvedToolOverridesSchema,
  RunIdSchema,
  RunResultSchema,
  ScheduledEventIdSchema,
  SeedSchema,
  SemverSchema,
  Sha256Schema,
  StableIdSchema,
  StateSetupSchema,
  TargetFileAttachmentSchema,
  ToolPackageManifestSchema,
  ToolStateContractSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "@firedrill-run/contracts";
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
    readable: z.boolean(),
  })
  .strict();

export const SimulationSourceKindSchema = z.enum(["world", "scenario", "tool", "drill", "suite", "target"]);

export const SimulationSourceDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: SimulationSourceKindSchema,
    id: StableIdSchema,
    path: RelativeSourcePathSchema,
    contentHash: Sha256Schema,
    language: z.enum(["json", "yaml", "javascript", "typescript", "markdown", "text"]),
    content: z.string().max(1024 * 1024),
  })
  .strict();

export const SimulationToolSourceIdSchema = z.string().regex(/^file-[a-f0-9]{64}$/);

const ToolSourceLanguageSchema = z.enum(["javascript", "typescript"]);
const BaseToolSourceOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository") }).strict(),
  z
    .object({
      kind: z.literal("npm"),
      packageName: NodePackageNameSchema,
      packageVersion: SemverSchema,
    })
    .strict(),
]);
const ToolSourceOriginSchema = z.discriminatedUnion("kind", [
  ...BaseToolSourceOriginSchema.options,
  z
    .object({
      kind: z.literal("repository_override"),
      module: RelativeSourcePathSchema,
      base: BaseToolSourceOriginSchema,
    })
    .strict(),
]);

export const SimulationToolSourceUnavailableReasonSchema = z.enum([
  "unsupported_file",
  "restricted_path",
  "missing_source",
  "unsafe_path",
  "too_large",
  "invalid_text",
  "package_changed",
  "snapshot_limit",
]);

const ToolSourceReferenceSchema = z
  .object({
    id: SimulationToolSourceIdSchema,
    path: RelativeSourcePathSchema,
    language: ToolSourceLanguageSchema.optional(),
    role: z.enum(["entry", "helper"]).optional(),
    readable: z.boolean(),
    contentHash: Sha256Schema.optional(),
    unavailableReason: SimulationToolSourceUnavailableReasonSchema.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.readable
        ? source.language === undefined ||
          source.contentHash === undefined ||
          source.unavailableReason !== undefined
        : source.contentHash !== undefined || source.unavailableReason === undefined
    ) {
      context.addIssue({ code: "custom", message: "source availability metadata is inconsistent" });
    }
  });

/** Source captured after compilation during the last refresh, not archived original-source proof. */
export const SimulationToolImplementationSchema = z
  .object({
    snapshot: z.literal("compiled_refresh"),
    buildHash: Sha256Schema,
    artifactHash: Sha256Schema,
    exportName: z.string().min(1).max(1024),
    origin: ToolSourceOriginSchema,
    files: z.array(ToolSourceReferenceSchema),
  })
  .strict();

export const SimulationToolSourceDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolId: PackageIdSchema,
    fileId: SimulationToolSourceIdSchema,
    snapshot: z.literal("compiled_refresh"),
    buildHash: Sha256Schema,
    artifactHash: Sha256Schema,
    path: RelativeSourcePathSchema,
    language: ToolSourceLanguageSchema,
    contentHash: Sha256Schema,
    content: z.string().max(1024 * 1024),
  })
  .strict();

const ScenarioSetupViewSchema = z
  .object({
    virtualTimeUs: VirtualTimeSchema,
    actors: z.array(ActorDefinitionSchema),
    state: z.array(StateSetupSchema),
    faults: z.array(FaultActivationSchema),
    initialEvents: z.array(InitialEventSchema),
    toolOverrides: ResolvedToolOverridesSchema.optional(),
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
    inputSchema: JsonObjectSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    declaredErrors: z.array(z.string()).optional(),
    fidelity: z.enum(["contract", "stateful", "behavioral", "validated"]),
    idempotency: z.enum(["none", "optional", "required"]),
  })
  .strict();

const ToolViewSchema = z
  .object({
    id: PackageIdSchema,
    version: z.string().min(1).max(128),
    definition: ToolPackageManifestSchema.optional(),
    implementation: SimulationToolImplementationSchema.optional(),
    operations: z.array(OperationViewSchema),
    stateNamespaces: z.array(StableIdSchema),
    stateDefinitions: z.array(ToolStateContractSchema).optional(),
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
    execution: DrillTimelineSchema.optional(),
    toolOverrides: ResolvedToolOverridesSchema.optional(),
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
          definition: AssertionDefinitionSchema.optional(),
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
    /** Continue through older saved report directories, including unreadable reports. */
    nextCursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
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

export const SimulationReportAttachmentsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    attachments: z.array(TargetFileAttachmentSchema.extend({ path: RelativeSourcePathSchema }).strict()),
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
        differences: z.array(
          z.enum(["drill", "scenario", "target", "seed", "build", "package_lock", "runtime_controls"]),
        ),
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
export type SimulationSourceKind = z.infer<typeof SimulationSourceKindSchema>;
export type SimulationSourceDocument = z.infer<typeof SimulationSourceDocumentSchema>;
export type SimulationToolImplementation = z.infer<typeof SimulationToolImplementationSchema>;
export type SimulationToolSourceDocument = z.infer<typeof SimulationToolSourceDocumentSchema>;
export type SimulationToolSourceUnavailableReason = z.infer<
  typeof SimulationToolSourceUnavailableReasonSchema
>;
export type SimulationRunSummary = z.infer<typeof SimulationRunSummarySchema>;
export type SimulationRunList = z.infer<typeof SimulationRunListSchema>;
export type SimulationReportAttachments = z.infer<typeof SimulationReportAttachmentsSchema>;
export type SimulationRunDetail = z.infer<typeof SimulationRunDetailSchema>;
export type SimulationEvidencePage = z.infer<typeof SimulationEvidencePageSchema>;
export type SimulationStatePage = z.infer<typeof SimulationStatePageSchema>;
export type SimulationRunRequest = z.infer<typeof SimulationRunRequestSchema>;
export type SimulationRunRequestList = z.infer<typeof SimulationRunRequestListSchema>;
export type CompareSimulationRuns = z.infer<typeof CompareSimulationRunsSchema>;
export type SimulationRunComparison = z.infer<typeof SimulationRunComparisonSchema>;
export type StartSimulationRun = z.infer<typeof StartSimulationRunSchema>;
export type SimulationApiError = z.infer<typeof SimulationApiErrorSchema>;
