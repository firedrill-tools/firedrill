import { AssertionEvidenceIndex, evaluateAssertions } from "@firedrill/assertions";
import type {
  AssertionDefinition,
  AssertionResult,
  BindingEvidence,
  CheckpointResult,
  CorrelationId,
  DrillDefinition,
  DrillInteraction,
  ErrorEnvelope,
  EvidenceEntry,
  InteractionResult,
  JsonValue,
  RunId,
  RunResult,
  StableId,
  TargetResult,
} from "@firedrill/contracts";
import {
  CheckpointResultSchema,
  CorrelationIdSchema,
  canonicalJson,
  DrillInteractionSchema,
  expandDrillInteractions,
  InteractionResultSchema,
  RunIdSchema,
  RunResultSchema,
  SeedSchema,
  StableIdSchema,
  TargetResultSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "@firedrill/contracts";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { trajectoryHash } from "@firedrill/world-ir";
import type { WorldKernel } from "@firedrill/world-kernel";
import type { WorldStore } from "@firedrill/world-store";
import { z } from "zod";
import { boundedDiagnosticMessage } from "./diagnostics.js";
import { DrillSetupError } from "./scenario.js";

export interface DrillCallbackSettlement {
  /** Delivers all callback work due at the world's current virtual time. */
  flush(): Promise<void>;
  /** Returns the next callback retry/delivery time, or null when none is pending. */
  nextDueUs(): number | null;
}

export const DrillCoordinatorIdentitySchema = z
  .object({
    runId: RunIdSchema,
    worldInstanceId: WorldInstanceIdSchema,
    trial: z.number().int().positive().max(10_000),
    trialCount: z.number().int().positive().max(10_000),
    attempt: z.number().int().positive().max(11),
    attemptLimit: z.number().int().positive().max(11),
    seed: SeedSchema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.trial > identity.trialCount) {
      context.addIssue({ code: "custom", path: ["trial"], message: "trial exceeds trialCount" });
    }
    if (identity.attempt > identity.attemptLimit) {
      context.addIssue({ code: "custom", path: ["attempt"], message: "attempt exceeds attemptLimit" });
    }
  });
export type DrillCoordinatorIdentity = z.infer<typeof DrillCoordinatorIdentitySchema>;

export const PendingDrillInteractionSchema = z
  .object({
    schemaVersion: z.literal(1),
    interaction: DrillInteractionSchema,
    scheduledAtVirtualUs: VirtualTimeSchema,
    startedAtVirtualUs: VirtualTimeSchema,
  })
  .strict();
export type PendingDrillInteraction = z.infer<typeof PendingDrillInteractionSchema>;

export const DrillCoordinatorSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: DrillCoordinatorIdentitySchema,
    startedAtVirtualUs: VirtualTimeSchema,
    nextInteractionIndex: z.number().int().nonnegative().max(10_000),
    checkpointSequence: z.number().int().nonnegative().safe(),
    interactions: z.array(InteractionResultSchema).max(10_000),
    checkpoints: z.array(CheckpointResultSchema),
    processedEvents: z.number().int().nonnegative().safe(),
    eventBudgetExhausted: z.boolean(),
    stoppedByInvariant: z.boolean(),
    stoppedByTarget: z.boolean(),
    bindingsIssued: z.boolean(),
    bindingRouteVerified: z.boolean(),
    issuedToolCalls: z.number().int().nonnegative().safe(),
    toolCallsAtStart: z.number().int().nonnegative().safe(),
    pendingInteraction: PendingDrillInteractionSchema.optional(),
    result: RunResultSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.result !== undefined && snapshot.pendingInteraction !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["pendingInteraction"],
        message: "terminal coordinator state cannot retain a pending interaction",
      });
    }
  });
export type DrillCoordinatorSnapshot = z.infer<typeof DrillCoordinatorSnapshotSchema>;

export interface DrillCoordinatorOptions {
  readonly build: LoadedWorldBuild;
  readonly drillId: StableId;
  readonly store: WorldStore;
  readonly kernel: WorldKernel;
  readonly identity: DrillCoordinatorIdentity;
  readonly callbacks: DrillCallbackSettlement;
  readonly snapshot?: DrillCoordinatorSnapshot;
}

export interface CompletedInteractionInput {
  readonly interactionId: StableId;
  readonly targetResult: TargetResult;
  readonly bindingEvidence: BindingEvidence;
  /** Tool calls observed through the invocation-scoped binding. */
  readonly callsIssued: number;
}

export type DrillCoordinatorStep =
  | { readonly kind: "interaction"; readonly pending: PendingDrillInteraction }
  | { readonly kind: "continue" }
  | { readonly kind: "ready_to_seal" }
  | { readonly kind: "terminal"; readonly result: RunResult };

class RunEnvelopeError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "RunEnvelopeError";
    this.envelope = envelope;
  }
}

function frameworkError(
  runId: RunId,
  code: string,
  message: string,
  details?: ErrorEnvelope["details"],
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    source: "framework",
    message,
    retryable: false,
    issues: [],
    ...(details === undefined ? {} : { details }),
    evidence: { runId },
  };
}

function runError(runId: RunId, error: unknown): ErrorEnvelope {
  if (error instanceof RunEnvelopeError) return error.envelope;
  if (error instanceof DrillSetupError) return frameworkError(runId, error.code, error.message);
  const bounded = boundedDiagnosticMessage(error, "");
  return frameworkError(
    runId,
    "framework.RUNNER_FAILED",
    bounded.length === 0 ? "drill runner failed" : `drill runner failed: ${bounded}`,
    error instanceof Error ? { errorName: error.name } : undefined,
  );
}

function appendEvidence(store: WorldStore, index: AssertionEvidenceIndex): void {
  let fromSequence = index.lastSequence() + 1;
  for (;;) {
    const page = store.readEvidence(fromSequence, 10_000);
    index.append(page);
    if (page.length < 10_000) return;
    const last = page.at(-1);
    if (last === undefined || last.sequence < fromSequence) {
      throw new Error("evidence reader did not advance its pagination cursor");
    }
    fromSequence = last.sequence + 1;
  }
}

function evidenceRange(entries: readonly EvidenceEntry[]) {
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return { fromSequence: first.sequence, toSequence: last.sequence };
}

function checkpointVerdict(results: readonly AssertionResult[]): CheckpointResult["verdict"] {
  return results.some((result) => result.gate && result.status !== "passed") ? "failed" : "passed";
}

function recordCheckpoint(input: {
  readonly store: WorldStore;
  readonly evidence: AssertionEvidenceIndex;
  readonly checkpointId: StableId;
  readonly kind: CheckpointResult["kind"];
  readonly assertions: readonly AssertionDefinition[];
  readonly interactionId?: StableId;
  readonly correlationId: CorrelationId;
}): CheckpointResult {
  if (input.assertions.length === 0) throw new TypeError("a checkpoint requires at least one assertion");
  appendEvidence(input.store, input.evidence);
  const assertionResults = evaluateAssertions({
    assertions: input.assertions,
    state: input.store,
    evidence: input.evidence,
  });
  const causeSequence = input.evidence.lastSequence() || undefined;
  const [first, ...rest] = assertionResults;
  if (first === undefined) throw new TypeError("a checkpoint produced no assertion results");
  input.store.transact(input.correlationId, (transaction) => {
    for (const result of rest) {
      transaction.appendEvidence({
        kind: "verification",
        checkpointId: input.checkpointId,
        checkpointKind: input.kind,
        ...(input.interactionId === undefined ? {} : { interactionId: input.interactionId }),
        result,
        ...(causeSequence === undefined ? {} : { causeSequence }),
      });
    }
    return {
      value: undefined,
      primary: {
        kind: "verification",
        checkpointId: input.checkpointId,
        checkpointKind: input.kind,
        ...(input.interactionId === undefined ? {} : { interactionId: input.interactionId }),
        result: first,
        ...(causeSequence === undefined ? {} : { causeSequence }),
      },
    };
  });
  return {
    schemaVersion: 1,
    checkpointId: input.checkpointId,
    kind: input.kind,
    ...(input.interactionId === undefined ? {} : { interactionId: input.interactionId }),
    virtualTimeUs: input.store.metadata().virtualTimeUs,
    verdict: checkpointVerdict(assertionResults),
    assertionResults: [...assertionResults],
  };
}

function strongestBindingEvidence(values: readonly BindingEvidence[]): BindingEvidence {
  const rank: Readonly<Record<BindingEvidence, number>> = {
    not_checked: 0,
    issued: 1,
    route_verified: 2,
    observed: 3,
    enforced: 4,
  };
  return values.reduce<BindingEvidence>(
    (strongest, value) => (rank[value] > rank[strongest] ? value : strongest),
    "not_checked",
  );
}

function targetBudgetResult(
  runId: RunId,
  kernel: WorldKernel,
  targetResult: TargetResult,
  maxToolCalls: number,
  toolCallsAtStart: number,
): TargetResult {
  const usage = kernel.usage();
  const attempted = Math.max(0, usage.toolCalls - toolCallsAtStart);
  if (!usage.toolCallBudgetExceeded && attempted <= maxToolCalls) return targetResult;
  return TargetResultSchema.parse({
    schemaVersion: 1,
    status: "failed",
    attachments: targetResult.attachments,
    error: frameworkError(
      runId,
      "framework.TOOL_CALL_BUDGET_EXCEEDED",
      `drill exceeded its ${maxToolCalls} Tool-call budget`,
      { attempted, limit: maxToolCalls },
    ),
  });
}

function validateCounter(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

/**
 * Owns the protocol-independent lifecycle of one drill attempt around an already
 * materialized world. Local runners and hosted coordinators provide different
 * target/binding transports but share this timeline, assertion, and verdict path.
 */
export class DrillTrialCoordinator {
  readonly drill: DrillDefinition;
  readonly interactionsPlan: readonly DrillInteraction[];
  private readonly evidence: AssertionEvidenceIndex;
  private readonly horizonAt: number;
  private state: DrillCoordinatorSnapshot;

  constructor(private readonly options: DrillCoordinatorOptions) {
    const drill = options.build.worldIr.drills.find((candidate) => candidate.id === options.drillId);
    if (drill === undefined) {
      throw new DrillSetupError("framework.DRILL_NOT_FOUND", `build has no drill ${options.drillId}`);
    }
    this.drill = drill;
    this.interactionsPlan = expandDrillInteractions(drill.timeline);
    const identity = DrillCoordinatorIdentitySchema.parse(options.identity);
    validateCounter(identity.trialCount, "trial count", 10_000);
    validateCounter(identity.trial, "trial", identity.trialCount);
    validateCounter(identity.attemptLimit, "attempt limit", 11);
    validateCounter(identity.attempt, "attempt", identity.attemptLimit);
    const restored =
      options.snapshot === undefined ? undefined : DrillCoordinatorSnapshotSchema.parse(options.snapshot);
    const startedAtVirtualUs = restored?.startedAtVirtualUs ?? options.store.metadata().virtualTimeUs;
    this.horizonAt = startedAtVirtualUs + drill.timeline.horizonUs;
    if (!Number.isSafeInteger(this.horizonAt)) {
      throw new RunEnvelopeError({
        schemaVersion: 1,
        code: "framework.VIRTUAL_TIME_OVERFLOW",
        source: "framework",
        message: "drill timeline horizon exceeds the supported virtual clock range",
        retryable: false,
        issues: [],
      });
    }
    this.state = restored ?? {
      schemaVersion: 1,
      identity,
      startedAtVirtualUs,
      nextInteractionIndex: 0,
      checkpointSequence: 0,
      interactions: [],
      checkpoints: [],
      processedEvents: 0,
      eventBudgetExhausted: false,
      stoppedByInvariant: false,
      stoppedByTarget: false,
      bindingsIssued: false,
      bindingRouteVerified: false,
      issuedToolCalls: 0,
      toolCallsAtStart: options.kernel.usage().toolCalls,
    };
    if (
      canonicalJson(this.state.identity as unknown as JsonValue) !==
      canonicalJson(identity as unknown as JsonValue)
    ) {
      throw new TypeError("drill coordinator snapshot identity does not match the requested run");
    }
    if (this.state.nextInteractionIndex > this.interactionsPlan.length) {
      throw new TypeError("drill coordinator snapshot exceeds the interaction plan");
    }
    this.evidence = new AssertionEvidenceIndex();
    appendEvidence(options.store, this.evidence);
  }

  snapshot(): DrillCoordinatorSnapshot {
    return DrillCoordinatorSnapshotSchema.parse(structuredClone(this.state));
  }

  async next(): Promise<DrillCoordinatorStep> {
    if (this.state.result !== undefined) return { kind: "terminal", result: this.state.result };
    if (this.state.pendingInteraction !== undefined) {
      return { kind: "interaction", pending: this.state.pendingInteraction };
    }
    if (
      this.state.stoppedByInvariant ||
      this.state.stoppedByTarget ||
      this.state.nextInteractionIndex >= this.interactionsPlan.length
    ) {
      return { kind: "ready_to_seal" };
    }
    const interaction = this.interactionsPlan[this.state.nextInteractionIndex];
    if (interaction === undefined) return { kind: "ready_to_seal" };
    const scheduledAtVirtualUs = this.state.startedAtVirtualUs + interaction.afterStartUs;
    if (!Number.isSafeInteger(scheduledAtVirtualUs)) {
      throw new RunEnvelopeError({
        schemaVersion: 1,
        code: "framework.VIRTUAL_TIME_OVERFLOW",
        source: "framework",
        message: `interaction ${interaction.id} exceeds the supported virtual clock range`,
        retryable: false,
        issues: [],
      });
    }
    if (!(await this.advanceTo(scheduledAtVirtualUs))) return { kind: "ready_to_seal" };
    const pending: PendingDrillInteraction = {
      schemaVersion: 1,
      interaction,
      scheduledAtVirtualUs,
      startedAtVirtualUs: this.options.store.metadata().virtualTimeUs,
    };
    this.state = { ...this.state, pendingInteraction: pending };
    return { kind: "interaction", pending };
  }

  async complete(input: CompletedInteractionInput): Promise<DrillCoordinatorStep> {
    if (this.state.result !== undefined) return { kind: "terminal", result: this.state.result };
    const pending = this.state.pendingInteraction;
    if (pending === undefined) throw new TypeError("drill has no pending target interaction");
    if (pending.interaction.id !== StableIdSchema.parse(input.interactionId)) {
      throw new TypeError("target result does not match the pending interaction");
    }
    await this.options.callbacks.flush();
    const targetResult = targetBudgetResult(
      this.state.identity.runId,
      this.options.kernel,
      TargetResultSchema.parse(input.targetResult),
      this.drill.timeline.maxToolCalls,
      this.state.toolCallsAtStart,
    );
    const interactionResult: InteractionResult = {
      schemaVersion: 1,
      interactionId: pending.interaction.id,
      actorId: pending.interaction.actorId,
      task: pending.interaction.task,
      scheduledAtVirtualUs: pending.scheduledAtVirtualUs,
      startedAtVirtualUs: pending.startedAtVirtualUs,
      finishedAtVirtualUs: this.options.store.metadata().virtualTimeUs,
      bindingEvidence: input.bindingEvidence,
      targetResult,
    };
    let stoppedByInvariant = this.state.stoppedByInvariant;
    const checkpoints = [...this.state.checkpoints];
    if (this.drill.timeline.invariants.length > 0) {
      const checkpoint = this.verify("after_interaction", pending.interaction.id);
      checkpoints.push(checkpoint);
      if (this.drill.timeline.stopOnInvariantFailure && checkpoint.verdict === "failed") {
        stoppedByInvariant = true;
      }
    }
    const stoppedByTarget =
      this.state.stoppedByTarget ||
      (targetResult.status !== "completed" && this.drill.timeline.stopOnTargetFailure);
    const nextInteractionIndex = this.state.nextInteractionIndex + 1;
    const { pendingInteraction: _pendingInteraction, ...settledState } = this.state;
    this.state = {
      ...settledState,
      nextInteractionIndex,
      checkpointSequence: this.state.checkpointSequence + (this.drill.timeline.invariants.length > 0 ? 1 : 0),
      interactions: [...this.state.interactions, interactionResult],
      checkpoints,
      stoppedByInvariant,
      stoppedByTarget,
      bindingsIssued: true,
      bindingRouteVerified:
        this.state.bindingRouteVerified ||
        ["route_verified", "observed", "enforced"].includes(input.bindingEvidence),
      issuedToolCalls: this.state.issuedToolCalls + input.callsIssued,
    };
    if (targetResult.status === "cancelled") {
      const result = this.cancel(targetResult.error?.message ?? "drill run was cancelled");
      return { kind: "terminal", result };
    }
    if (stoppedByInvariant || stoppedByTarget || nextInteractionIndex >= this.interactionsPlan.length) {
      return { kind: "ready_to_seal" };
    }
    return { kind: "continue" };
  }

  async seal(): Promise<RunResult> {
    if (this.state.result !== undefined) return this.state.result;
    if (this.state.pendingInteraction !== undefined) {
      throw new TypeError("cannot seal while a target interaction is pending");
    }
    if (!this.state.stoppedByTarget && !this.state.stoppedByInvariant) {
      await this.advanceTo(this.horizonAt);
      if (this.drill.timeline.invariants.length > 0 && !this.state.stoppedByInvariant) {
        const checkpoint = this.verify("horizon");
        this.state = {
          ...this.state,
          checkpointSequence: this.state.checkpointSequence + 1,
          checkpoints: [...this.state.checkpoints, checkpoint],
          stoppedByInvariant:
            this.state.stoppedByInvariant ||
            (this.drill.timeline.stopOnInvariantFailure && checkpoint.verdict === "failed"),
        };
      }
    }
    await this.options.callbacks.flush();
    const finalCheckpoint = this.verify("final");
    const checkpoints = [...this.state.checkpoints, finalCheckpoint];
    appendEvidence(this.options.store, this.evidence);
    const evidence = this.evidence.all();
    const range = evidenceRange(evidence);
    if (range === undefined) throw new Error("created world contains no evidence");
    const checkpointFailure = checkpoints.some((checkpoint) => checkpoint.verdict === "failed");
    const targetFailure = this.state.interactions.some(
      (interaction) => interaction.targetResult.status !== "completed",
    );
    const result = RunResultSchema.parse({
      ...this.terminalBase(checkpoints),
      status: "sealed",
      verdict: targetFailure || checkpointFailure ? "failed" : "passed",
      assertionResults: finalCheckpoint.assertionResults,
      evidenceRange: range,
      stateHash: this.options.store.stateHash(),
      evidenceHash: this.options.store.evidenceHash(),
      trajectoryHash: trajectoryHash({ interactions: this.state.interactions, checkpoints, evidence }),
    });
    this.state = {
      ...this.state,
      checkpointSequence: this.state.checkpointSequence + 1,
      checkpoints,
      result,
    };
    return result;
  }

  cancel(reason: string): RunResult {
    if (this.state.result !== undefined) return this.state.result;
    appendEvidence(this.options.store, this.evidence);
    const range = evidenceRange(this.evidence.all());
    const result = RunResultSchema.parse({
      ...this.terminalBase(this.state.checkpoints),
      status: "cancelled",
      reason,
      assertionResults: [],
      ...(range === undefined ? {} : { evidenceRange: range }),
    });
    const { pendingInteraction: _pendingInteraction, ...settledState } = this.state;
    this.state = { ...settledState, result };
    return result;
  }

  fail(error: unknown): RunResult {
    if (this.state.result !== undefined) return this.state.result;
    appendEvidence(this.options.store, this.evidence);
    const range = evidenceRange(this.evidence.all());
    const result = RunResultSchema.parse({
      ...this.terminalBase(this.state.checkpoints),
      status: "runner_failed",
      error: runError(this.state.identity.runId, error),
      assertionResults: [],
      ...(range === undefined ? {} : { evidenceRange: range }),
    });
    const { pendingInteraction: _pendingInteraction, ...settledState } = this.state;
    this.state = { ...settledState, result };
    return result;
  }

  evidenceEntries(): readonly EvidenceEntry[] {
    appendEvidence(this.options.store, this.evidence);
    return this.evidence.all();
  }

  private terminalBase(checkpoints: readonly CheckpointResult[]) {
    const binding = strongestBindingEvidence([
      this.state.bindingsIssued ? "issued" : "not_checked",
      this.state.bindingRouteVerified ? "route_verified" : "not_checked",
      ...this.state.interactions.map((interaction) => interaction.bindingEvidence),
    ]);
    const usage = this.options.kernel.usage();
    const attemptedToolCalls = Math.max(0, usage.toolCalls - this.state.toolCallsAtStart);
    return {
      schemaVersion: 1 as const,
      ...(this.options.build.setup === undefined ? {} : { setup: this.options.build.setup }),
      identity: {
        ...this.state.identity,
        drillId: this.drill.id,
        ...(this.drill.scenarioId === undefined ? {} : { scenarioId: this.drill.scenarioId }),
        targetId: this.drill.targetId,
        buildHash: this.options.build.manifest.buildHash,
        packageLockHash: this.options.build.manifest.packageLockHash,
        ...(this.options.build.setup === undefined ? {} : { setupHash: this.options.build.setup.setupHash }),
      },
      startedAtVirtualUs: this.state.startedAtVirtualUs,
      finishedAtVirtualUs: this.options.store.metadata().virtualTimeUs,
      bindingEvidence: binding,
      worldConsistency: "atomic" as const,
      interactions: this.state.interactions,
      checkpoints,
      budgetUsage: {
        toolCalls: {
          limit: this.drill.timeline.maxToolCalls,
          attempted: attemptedToolCalls,
          rejected: Math.max(0, attemptedToolCalls - this.drill.timeline.maxToolCalls),
        },
        scheduledEvents: {
          limit: this.drill.timeline.maxEvents,
          processed: this.state.processedEvents,
          exhausted: this.state.eventBudgetExhausted,
        },
      },
    };
  }

  private verify(kind: CheckpointResult["kind"], interactionId?: StableId): CheckpointResult {
    const sequence = this.state.checkpointSequence + 1;
    const checkpointId =
      kind === "final"
        ? StableIdSchema.parse("final")
        : StableIdSchema.parse(`checkpoint-${String(sequence).padStart(6, "0")}`);
    return recordCheckpoint({
      store: this.options.store,
      evidence: this.evidence,
      checkpointId,
      kind,
      assertions: kind === "final" ? this.drill.assertions : this.drill.timeline.invariants,
      ...(interactionId === undefined ? {} : { interactionId }),
      correlationId: CorrelationIdSchema.parse(
        `corr_verify_${this.state.identity.runId.slice(4, 20)}_${String(sequence).padStart(6, "0")}`,
      ),
    });
  }

  private async advanceTo(toUs: number): Promise<boolean> {
    for (;;) {
      await this.options.callbacks.flush();
      if (this.state.stoppedByInvariant) return false;
      const currentUs = this.options.store.metadata().virtualTimeUs;
      if (currentUs >= toUs) return true;
      const callbackDueUs = this.options.callbacks.nextDueUs();
      const stepUs =
        callbackDueUs !== null && callbackDueUs > currentUs && callbackDueUs < toUs ? callbackDueUs : toUs;
      const before = this.state.processedEvents;
      let stoppedForCallback = false;
      let checkpointSequence = this.state.checkpointSequence;
      const checkpoints = [...this.state.checkpoints];
      let stoppedByInvariant: boolean = this.state.stoppedByInvariant;
      const advanced = this.options.kernel.advanceTime(stepUs, {
        correlationId: CorrelationIdSchema.parse(
          `corr_clock_${this.state.identity.runId.slice(4, 20)}_${String(before + 1).padStart(6, "0")}`,
        ),
        maxEvents: this.drill.timeline.maxEvents - before,
        afterScheduledEvent: (checkpoint: { readonly processed: number }) => {
          this.state = {
            ...this.state,
            processedEvents: before + checkpoint.processed,
            checkpointSequence,
          };
          if (this.drill.timeline.invariants.length > 0) {
            const verified = this.verify("after_event");
            checkpoints.push(verified);
            checkpointSequence += 1;
            this.state = { ...this.state, checkpointSequence };
            if (this.drill.timeline.stopOnInvariantFailure && verified.verdict === "failed") {
              stoppedByInvariant = true;
              return false;
            }
          }
          const dueUs = this.options.callbacks.nextDueUs();
          stoppedForCallback = dueUs !== null && dueUs <= this.options.store.metadata().virtualTimeUs;
          return !stoppedForCallback;
        },
      });
      const processedEvents = before + advanced.scheduledEventsProcessed;
      const failure = advanced.failures[0];
      this.state = {
        ...this.state,
        processedEvents,
        checkpointSequence,
        checkpoints,
        stoppedByInvariant,
        eventBudgetExhausted:
          this.state.eventBudgetExhausted || failure?.error.code === "world.EVENT_BUDGET_EXCEEDED",
      };
      if (failure !== undefined) throw new RunEnvelopeError(failure.error);
      await this.options.callbacks.flush();
      if (this.state.stoppedByInvariant) return false;
      if (advanced.reachedUs >= toUs) return true;
      if (!advanced.stoppedEarly && !stoppedForCallback) {
        throw new Error("world clock did not reach its requested time or expose pending callback work");
      }
    }
  }
}
