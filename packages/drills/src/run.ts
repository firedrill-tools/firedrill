import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AssertionEvidenceIndex, evaluateAssertions } from "@firedrill/assertions";
import type {
  AssertionDefinition,
  AssertionResult,
  BindingEvidence,
  CheckpointResult,
  CorrelationId,
  ErrorEnvelope,
  EvidenceEntry,
  InteractionResult,
  RunId,
  RunResult,
  Seed,
  StableId,
  TargetDescriptor,
  WorldInstanceId,
} from "@firedrill/contracts";
import {
  CorrelationIdSchema,
  expandDrillInteractions,
  RunIdSchema,
  RunResultSchema,
  SeedSchema,
  StableIdSchema,
  TargetInvocationSchema,
  TargetResultSchema,
  WorldInstanceIdSchema,
} from "@firedrill/contracts";
import { startCliWorldBinding } from "@firedrill/protocol-cli";
import { CallbackDispatcher, startHttpWorldBinding } from "@firedrill/protocol-http";
import type { CallbackReceiver } from "@firedrill/protocol-http";
import { startMcpWorldBinding } from "@firedrill/protocol-mcp";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { trajectoryHash } from "@firedrill/world-ir";
import type { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import type { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { createDrillWorld, DrillSetupError } from "./scenario.js";
import { boundedDiagnosticMessage } from "./diagnostics.js";
import type { TargetHandler } from "./targets.js";
import { invokeTarget } from "./targets.js";

interface WorldBinding {
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

async function verifyWorldBinding(binding: WorldBinding): Promise<void> {
  const endpoint =
    binding.environment.FIREDRILL_HTTP_URL ??
    binding.environment.FIREDRILL_MCP_URL ??
    binding.environment.FIREDRILL_CLI_URL;
  if (endpoint === undefined) throw new Error("world binding exposed no canonical endpoint");
  const health = new URL(endpoint);
  health.pathname = "/health";
  health.search = "";
  health.hash = "";
  const response = await fetch(health, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  });
  await response.body?.cancel();
  if (response.status !== 200) {
    throw new Error(`world binding canary returned HTTP ${response.status}`);
  }
}

export interface RunDrillTrialOptions {
  readonly build: LoadedWorldBuild;
  readonly drillId: StableId;
  readonly repositoryRoot: string;
  /** The SQLite world artifact is retained here after the run. */
  readonly runDirectory: string;
  readonly trial?: number;
  /** Actual execution width. Defaults to the drill's declared trial count. */
  readonly trialCount?: number;
  /** One-based retry attempt within this logical trial. */
  readonly attempt?: number;
  /** Maximum attempts configured for this logical trial. */
  readonly attemptLimit?: number;
  readonly seed?: Seed;
  readonly runId?: RunId;
  readonly worldInstanceId?: WorldInstanceId;
  readonly externalHandler?: TargetHandler;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly allowRemoteHttp?: boolean;
  /** Local application endpoints that receive world-emitted callbacks during this trial. */
  readonly callbackReceivers?: Readonly<Record<string, CallbackReceiver>>;
  /** Cooperatively cancels target execution and prevents later trials from starting. */
  readonly signal?: AbortSignal;
  /** Called after the isolated world exists and before the target can act. */
  readonly attemptStarted?: (context: DrillAttemptHookContext) => void | Promise<void>;
}

export interface DrillAttemptExecution {
  readonly schemaVersion: 1;
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  readonly worldFilePath: string;
}

export interface DrillTrialExecution extends DrillAttemptExecution {
  readonly trial: number;
  readonly seed: Seed;
  readonly verdict: "passed" | "failed" | "inconclusive";
  /** Every retained attempt in execution order. Top-level artifacts are the last attempt. */
  readonly attempts: readonly DrillAttemptExecution[];
}

export interface DrillTrialHookContext {
  readonly drillId: StableId;
  readonly trial: number;
  readonly trialCount: number;
  readonly seed: Seed;
}

export interface DrillAttemptHookContext extends DrillTrialHookContext {
  readonly attempt: number;
  readonly attemptLimit: number;
  readonly runId: RunId;
  readonly worldInstanceId: WorldInstanceId;
  readonly worldFilePath: string;
}

export type RunDrillOptions = Omit<
  RunDrillTrialOptions,
  "attempt" | "attemptLimit" | "runId" | "trial" | "trialCount" | "worldInstanceId"
> & {
  /** Overrides the source default for this invocation without changing the drill file. */
  readonly trialCount?: number;
  /** Maximum retries after the first attempt. Defaults to zero. */
  readonly retries?: number;
  /** Maximum logical trials executing at once. Defaults to one. */
  readonly concurrency?: number;
  readonly beforeTrial?: (context: DrillTrialHookContext) => void | Promise<void>;
  readonly afterTrial?: (
    context: DrillTrialHookContext & { readonly execution: DrillTrialExecution },
  ) => void | Promise<void>;
  readonly attemptFinished?: (
    context: DrillAttemptHookContext & { readonly execution: DrillAttemptExecution },
  ) => void | Promise<void>;
};

export interface DrillExecution {
  readonly schemaVersion: 1;
  readonly drillId: StableId;
  readonly verdict: "passed" | "failed" | "inconclusive";
  readonly passed: number;
  readonly failed: number;
  readonly inconclusive: number;
  readonly trials: readonly DrillTrialExecution[];
}

class RunEnvelopeError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "RunEnvelopeError";
    this.envelope = envelope;
  }
}

function executionSuffix(): string {
  return randomUUID().replaceAll("-", "");
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

function appendEvidence(store: SqliteWorldStore, index: AssertionEvidenceIndex): void {
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

async function closeBindings(bindings: readonly WorldBinding[]): Promise<void> {
  const failures: unknown[] = [];
  for (const binding of [...bindings].reverse()) {
    try {
      await binding.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "failed to close world bindings");
}

interface CallbackPump {
  flush(): Promise<void>;
  close(): Promise<void>;
}

function startCallbackPump(dispatcher: CallbackDispatcher): CallbackPump {
  let active: Promise<void> | undefined;
  let failure: unknown;
  const tick = () => {
    if (active !== undefined || failure !== undefined) return;
    active = dispatcher
      .dispatchDue()
      .then(() => undefined)
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 5);
  timer.unref();
  tick();
  return {
    async flush() {
      await active;
      if (failure !== undefined) throw failure;
      await dispatcher.dispatchDue();
    },
    async close() {
      clearInterval(timer);
      await active;
      if (failure !== undefined) throw failure;
      await dispatcher.dispatchDue();
    },
  };
}

async function worldBindings(
  descriptor: TargetDescriptor,
  build: LoadedWorldBuild,
  client: Parameters<typeof startHttpWorldBinding>[0]["client"],
): Promise<{
  readonly bindings: readonly WorldBinding[];
  readonly environment: Record<string, string>;
  readonly routeVerified: boolean;
}> {
  const bindings: WorldBinding[] = [];
  const environment: Record<string, string> = {};
  try {
    for (const kind of descriptor.bindings) {
      if (kind === "direct") continue;
      const binding =
        kind === "http"
          ? await startHttpWorldBinding({ client, tools: build.tools })
          : kind === "mcp"
            ? await startMcpWorldBinding({ client, tools: build.worldIr.tools })
            : await startCliWorldBinding({ client, tools: build.tools });
      bindings.push(binding);
      for (const [name, value] of Object.entries(binding.environment)) {
        if (environment[name] !== undefined && environment[name] !== value) {
          throw new Error(`world bindings produced conflicting ${name} values`);
        }
        environment[name] = value;
      }
      await verifyWorldBinding(binding);
    }
    for (const [targetName, sourceName] of Object.entries(descriptor.bindingEnvironment ?? {})) {
      const value = environment[sourceName];
      if (value === undefined) {
        throw new DrillSetupError(
          "framework.BINDING_PROJECTION_UNAVAILABLE",
          `target ${descriptor.id} cannot project unavailable binding ${sourceName} to ${targetName}`,
        );
      }
      environment[targetName] = value;
    }
    return { bindings, environment, routeVerified: bindings.length > 0 };
  } catch (error) {
    await closeBindings(bindings);
    throw error;
  }
}

function targetFor(build: LoadedWorldBuild, targetId: StableId): TargetDescriptor {
  const target = build.worldIr.targets.find((candidate) => candidate.id === targetId);
  if (target === undefined) {
    throw new DrillSetupError("framework.TARGET_NOT_FOUND", `build has no target ${targetId}`);
  }
  return target;
}

function evidenceRange(entries: readonly EvidenceEntry[]) {
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return { fromSequence: first.sequence, toSequence: last.sequence };
}

function bindingEvidence(
  bindingsIssued: boolean,
  callsIssued: number,
  routeVerified: boolean,
): BindingEvidence {
  if (callsIssued > 0) return "observed";
  if (routeVerified) return "route_verified";
  return bindingsIssued ? "issued" : "not_checked";
}

function checkpointVerdict(results: readonly AssertionResult[]): CheckpointResult["verdict"] {
  return results.some((result) => result.gate && result.status !== "passed") ? "failed" : "passed";
}

function recordCheckpoint(input: {
  readonly store: SqliteWorldStore;
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

function budgetUsage(
  kernel: WorldKernel | undefined,
  maxToolCalls: number,
  maxEvents: number,
  processedEvents: number,
  eventBudgetExhausted: boolean,
) {
  const toolUsage = kernel?.usage() ?? {
    toolCalls: 0,
    maxToolCalls,
    toolCallBudgetExceeded: false,
  };
  return {
    toolCalls: {
      limit: toolUsage.maxToolCalls,
      attempted: toolUsage.toolCalls,
      rejected: Math.max(0, toolUsage.toolCalls - toolUsage.maxToolCalls),
    },
    scheduledEvents: {
      limit: maxEvents,
      processed: processedEvents,
      exhausted: eventBudgetExhausted,
    },
  };
}

/** Executes and seals one isolated trial. The retained SQLite file is the local reproduction artifact. */
export async function runDrillTrial(options: RunDrillTrialOptions): Promise<DrillAttemptExecution> {
  const drillId = StableIdSchema.parse(options.drillId);
  const drill = options.build.worldIr.drills.find((candidate) => candidate.id === drillId);
  if (drill === undefined) {
    throw new DrillSetupError("framework.DRILL_NOT_FOUND", `build has no drill ${drillId}`);
  }
  const target = targetFor(options.build, drill.targetId);
  const trialCount = options.trialCount ?? drill.trials.count;
  if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 10_000) {
    throw new RangeError("trial count must be an integer from 1 through 10000");
  }
  const trial = options.trial ?? 1;
  if (!Number.isSafeInteger(trial) || trial < 1 || trial > trialCount) {
    throw new RangeError(`trial must be between 1 and ${trialCount}`);
  }
  const attemptLimit = options.attemptLimit ?? 1;
  if (!Number.isSafeInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 11) {
    throw new RangeError("attempt limit must be an integer from 1 through 11");
  }
  const attempt = options.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > attemptLimit) {
    throw new RangeError(`attempt must be between 1 and ${attemptLimit}`);
  }
  const seed = SeedSchema.parse(options.seed ?? options.build.worldIr.world.seed);
  const suffix = executionSuffix();
  const runId = RunIdSchema.parse(options.runId ?? `run_${suffix}`);
  const worldInstanceId = WorldInstanceIdSchema.parse(options.worldInstanceId ?? `world_${suffix}`);
  const createCorrelationId = CorrelationIdSchema.parse(`corr_create_${suffix}`);
  const runDirectory = resolve(options.runDirectory);
  mkdirSync(runDirectory, { recursive: true });
  const worldFilePath = join(runDirectory, `${runId}.sqlite`);
  let store: SqliteWorldStore | undefined;
  let evidenceIndex: AssertionEvidenceIndex | undefined;
  let kernel: WorldKernel | undefined;
  let callbackPump: CallbackPump | undefined;
  let bindings: readonly WorldBinding[] = [];
  let activeClient: BoundWorldClient | undefined;
  let issuedToolCalls = 0;
  let bindingsIssued = false;
  let bindingRouteVerified = false;
  let startedAtVirtualUs = 0;
  const interactions: InteractionResult[] = [];
  const checkpoints: CheckpointResult[] = [];
  let processedEvents = 0;
  let eventBudgetExhausted = false;
  const toolBudgetController = new AbortController();
  const targetSignal =
    options.signal === undefined
      ? toolBudgetController.signal
      : AbortSignal.any([options.signal, toolBudgetController.signal]);
  const drillIdentity = {
    targetId: target.id,
    ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
    ...(options.build.setup === undefined ? {} : { setupHash: options.build.setup.setupHash }),
    trial,
    trialCount,
    attempt,
    attemptLimit,
    seed,
  };
  const releaseActiveClient = () => {
    if (activeClient === undefined) return;
    activeClient.revoke();
    issuedToolCalls += activeClient.callsIssued();
    activeClient = undefined;
  };

  try {
    const world = createDrillWorld({
      build: options.build,
      drillId,
      filePath: worldFilePath,
      worldInstanceId,
      correlationId: createCorrelationId,
      seed,
      maxToolCalls: drill.timeline.maxToolCalls,
      onToolCallBudgetExceeded: () => {
        toolBudgetController.abort(new Error("drill Tool-call budget exceeded"));
      },
    });
    store = world.store;
    await options.attemptStarted?.({
      drillId,
      trial,
      trialCount,
      seed,
      attempt,
      attemptLimit,
      runId,
      worldInstanceId,
      worldFilePath,
    });
    const runEvidence = new AssertionEvidenceIndex();
    evidenceIndex = runEvidence;
    kernel = world.kernel;
    const callbackDispatcher = new CallbackDispatcher({
      store: world.store,
      tools: options.build.tools,
      receivers: options.callbackReceivers ?? {},
    });
    callbackDispatcher.recoverInFlight();
    callbackPump = startCallbackPump(callbackDispatcher);
    startedAtVirtualUs = store.metadata().virtualTimeUs;
    const horizonAt = startedAtVirtualUs + drill.timeline.horizonUs;
    if (!Number.isSafeInteger(horizonAt)) {
      throw new RunEnvelopeError({
        schemaVersion: 1,
        code: "framework.VIRTUAL_TIME_OVERFLOW",
        source: "framework",
        message: "drill timeline horizon exceeds the supported virtual clock range",
        retryable: false,
        issues: [],
      });
    }

    let checkpointSequence = 0;
    let stoppedByInvariant = false;
    let stoppedByTarget = false;
    const verify = (kind: CheckpointResult["kind"], interactionId?: StableId) => {
      checkpointSequence += 1;
      const checkpointId =
        kind === "final"
          ? StableIdSchema.parse("final")
          : StableIdSchema.parse(`checkpoint-${String(checkpointSequence).padStart(6, "0")}`);
      const assertions = kind === "final" ? drill.assertions : drill.timeline.invariants;
      const checkpoint = recordCheckpoint({
        store: world.store,
        evidence: runEvidence,
        checkpointId,
        kind,
        assertions,
        ...(interactionId === undefined ? {} : { interactionId }),
        correlationId: CorrelationIdSchema.parse(
          `corr_verify_${suffix}_${String(checkpointSequence).padStart(6, "0")}`,
        ),
      });
      checkpoints.push(checkpoint);
      return checkpoint;
    };
    const advanceTo = async (toUs: number): Promise<boolean> => {
      for (;;) {
        await callbackPump?.flush();
        if (stoppedByInvariant) return false;
        const currentUs = world.store.metadata().virtualTimeUs;
        if (currentUs >= toUs) return true;
        const callbackDueUs = callbackDispatcher.nextDueUs();
        const stepUs =
          callbackDueUs !== null && callbackDueUs > currentUs && callbackDueUs < toUs ? callbackDueUs : toUs;
        const before = processedEvents;
        let stoppedForCallback = false;
        const advanced = world.kernel.advanceTime(stepUs, {
          correlationId: CorrelationIdSchema.parse(
            `corr_clock_${suffix}_${String(before + 1).padStart(6, "0")}`,
          ),
          maxEvents: drill.timeline.maxEvents - processedEvents,
          afterScheduledEvent: (checkpoint: { readonly processed: number }) => {
            processedEvents = before + checkpoint.processed;
            if (drill.timeline.invariants.length > 0) {
              const verified = verify("after_event");
              const shouldStop = drill.timeline.stopOnInvariantFailure && verified.verdict === "failed";
              if (shouldStop) {
                stoppedByInvariant = true;
                return false;
              }
            }
            const dueUs = callbackDispatcher.nextDueUs();
            stoppedForCallback = dueUs !== null && dueUs <= world.store.metadata().virtualTimeUs;
            return !stoppedForCallback;
          },
        });
        processedEvents = before + advanced.scheduledEventsProcessed;
        const failure = advanced.failures[0];
        if (failure !== undefined) {
          if (failure.error.code === "world.EVENT_BUDGET_EXCEEDED") eventBudgetExhausted = true;
          throw new RunEnvelopeError(failure.error);
        }
        await callbackPump?.flush();
        if (stoppedByInvariant) return false;
        if (advanced.reachedUs >= toUs) return true;
        if (!advanced.stoppedEarly && !stoppedForCallback) {
          throw new Error("world clock did not reach its requested time or expose pending callback work");
        }
      }
    };

    for (const interaction of expandDrillInteractions(drill.timeline)) {
      const scheduledAtVirtualUs = startedAtVirtualUs + interaction.afterStartUs;
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
      if (!(await advanceTo(scheduledAtVirtualUs))) break;
      const actorClient = world.clients.get(interaction.actorId);
      if (actorClient === undefined) {
        throw new DrillSetupError(
          "framework.ACTOR_NOT_FOUND",
          `interaction ${interaction.id} references unavailable actor ${interaction.actorId}`,
        );
      }
      const client = actorClient.scope(`${runId}:${interaction.id}`);
      activeClient = client;
      const callsBefore = client.callsIssued();
      const exposed = await worldBindings(target, options.build, client);
      bindings = exposed.bindings;
      bindingsIssued = true;
      bindingRouteVerified ||= exposed.routeVerified;
      const invocation = TargetInvocationSchema.parse({
        schemaVersion: 1,
        runId,
        interactionId: interaction.id,
        actorId: interaction.actorId,
        instruction: interaction.task.instruction,
        ...(interaction.task.input === undefined ? {} : { input: interaction.task.input }),
        bindingEnvironment: exposed.environment,
      });
      const interactionStartedAt = store.metadata().virtualTimeUs;
      const invokedTargetResult = await invokeTarget({
        descriptor: target,
        invocation,
        repositoryRoot: options.repositoryRoot,
        worldClient: client,
        ...(options.externalHandler === undefined ? {} : { externalHandler: options.externalHandler }),
        ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
        ...(options.allowRemoteHttp === undefined ? {} : { allowRemoteHttp: options.allowRemoteHttp }),
        signal: targetSignal,
      });
      const targetResult = world.kernel.usage().toolCallBudgetExceeded
        ? TargetResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            attachments: [],
            error: frameworkError(
              runId,
              "framework.TOOL_CALL_BUDGET_EXCEEDED",
              `drill exceeded its ${drill.timeline.maxToolCalls} Tool-call budget`,
              {
                attempted: world.kernel.usage().toolCalls,
                limit: drill.timeline.maxToolCalls,
              },
            ),
          })
        : invokedTargetResult;
      await callbackPump.flush();
      interactions.push({
        schemaVersion: 1,
        interactionId: interaction.id,
        actorId: interaction.actorId,
        task: interaction.task,
        scheduledAtVirtualUs,
        startedAtVirtualUs: interactionStartedAt,
        finishedAtVirtualUs: store.metadata().virtualTimeUs,
        bindingEvidence: bindingEvidence(true, client.callsIssued() - callsBefore, exposed.routeVerified),
        targetResult,
      });
      releaseActiveClient();
      await closeBindings(bindings);
      bindings = [];

      if (drill.timeline.invariants.length > 0) {
        const verified = verify("after_interaction", interaction.id);
        if (drill.timeline.stopOnInvariantFailure && verified.verdict === "failed") {
          stoppedByInvariant = true;
        }
      }

      if (targetResult.status === "cancelled" || options.signal?.aborted) {
        appendEvidence(store, runEvidence);
        const evidence = runEvidence.all();
        const range = evidenceRange(evidence);
        const result = RunResultSchema.parse({
          schemaVersion: 1,
          status: "cancelled",
          ...(options.build.setup === undefined ? {} : { setup: options.build.setup }),
          identity: {
            runId,
            worldInstanceId,
            drillId,
            ...(drillIdentity.scenarioId === undefined ? {} : { scenarioId: drillIdentity.scenarioId }),
            targetId: drillIdentity.targetId,
            buildHash: options.build.manifest.buildHash,
            packageLockHash: options.build.manifest.packageLockHash,
            ...(drillIdentity.setupHash === undefined ? {} : { setupHash: drillIdentity.setupHash }),
            seed,
            trial,
            trialCount,
            attempt,
            attemptLimit,
          },
          startedAtVirtualUs,
          finishedAtVirtualUs: store.metadata().virtualTimeUs,
          bindingEvidence: bindingEvidence(bindingsIssued, issuedToolCalls, bindingRouteVerified),
          worldConsistency: "atomic",
          interactions,
          checkpoints,
          budgetUsage: budgetUsage(
            world.kernel,
            drill.timeline.maxToolCalls,
            drill.timeline.maxEvents,
            processedEvents,
            eventBudgetExhausted,
          ),
          reason: targetResult.error?.message ?? "drill run was cancelled",
          assertionResults: [],
          ...(range === undefined ? {} : { evidenceRange: range }),
        });
        return { schemaVersion: 1, result, evidence, worldFilePath };
      }
      if (targetResult.status !== "completed") {
        if (drill.timeline.stopOnTargetFailure) {
          stoppedByTarget = true;
          break;
        }
      }
      if (stoppedByInvariant) break;
    }

    if (!stoppedByTarget && !stoppedByInvariant) {
      await advanceTo(horizonAt);
      if (drill.timeline.invariants.length > 0 && !stoppedByInvariant) {
        const horizon = verify("horizon");
        if (drill.timeline.stopOnInvariantFailure && horizon.verdict === "failed") {
          stoppedByInvariant = true;
        }
      }
    }

    await callbackPump.flush();
    const finalCheckpoint = verify("final");
    const assertionResults = finalCheckpoint.assertionResults;
    const checkpointFailure = checkpoints.some((checkpoint) => checkpoint.verdict === "failed");
    const targetFailure = interactions.some((interaction) => interaction.targetResult.status !== "completed");
    const verdict = targetFailure || checkpointFailure ? "failed" : "passed";
    appendEvidence(store, runEvidence);
    const evidence = runEvidence.all();
    const range = evidenceRange(evidence);
    if (range === undefined) throw new Error("created world contains no evidence");
    const result = RunResultSchema.parse({
      schemaVersion: 1,
      status: "sealed",
      ...(options.build.setup === undefined ? {} : { setup: options.build.setup }),
      identity: {
        runId,
        worldInstanceId,
        drillId,
        ...(drillIdentity.scenarioId === undefined ? {} : { scenarioId: drillIdentity.scenarioId }),
        targetId: drillIdentity.targetId,
        buildHash: options.build.manifest.buildHash,
        packageLockHash: options.build.manifest.packageLockHash,
        ...(drillIdentity.setupHash === undefined ? {} : { setupHash: drillIdentity.setupHash }),
        seed,
        trial,
        trialCount,
        attempt,
        attemptLimit,
      },
      startedAtVirtualUs,
      finishedAtVirtualUs: store.metadata().virtualTimeUs,
      bindingEvidence: bindingEvidence(bindingsIssued, issuedToolCalls, bindingRouteVerified),
      worldConsistency: "atomic",
      interactions,
      checkpoints,
      budgetUsage: budgetUsage(
        world.kernel,
        drill.timeline.maxToolCalls,
        drill.timeline.maxEvents,
        processedEvents,
        eventBudgetExhausted,
      ),
      verdict,
      assertionResults,
      evidenceRange: range,
      stateHash: store.stateHash(),
      evidenceHash: store.evidenceHash(),
      trajectoryHash: trajectoryHash({ interactions, checkpoints, evidence }),
    });
    return { schemaVersion: 1, result, evidence, worldFilePath };
  } catch (error) {
    releaseActiveClient();
    if (store !== undefined && evidenceIndex !== undefined) appendEvidence(store, evidenceIndex);
    const evidence = evidenceIndex?.all() ?? [];
    const range = evidenceRange(evidence);
    const finishedAtVirtualUs = store?.metadata().virtualTimeUs ?? startedAtVirtualUs;
    const result = RunResultSchema.parse({
      schemaVersion: 1,
      status: "runner_failed",
      ...(options.build.setup === undefined ? {} : { setup: options.build.setup }),
      identity: {
        runId,
        worldInstanceId,
        drillId,
        ...(drillIdentity.scenarioId === undefined ? {} : { scenarioId: drillIdentity.scenarioId }),
        targetId: drillIdentity.targetId,
        buildHash: options.build.manifest.buildHash,
        packageLockHash: options.build.manifest.packageLockHash,
        ...(drillIdentity.setupHash === undefined ? {} : { setupHash: drillIdentity.setupHash }),
        seed: drillIdentity.seed,
        trial: drillIdentity.trial,
        trialCount: drillIdentity.trialCount,
        attempt: drillIdentity.attempt,
        attemptLimit: drillIdentity.attemptLimit,
      },
      startedAtVirtualUs,
      finishedAtVirtualUs,
      bindingEvidence: bindingEvidence(bindingsIssued, issuedToolCalls, bindingRouteVerified),
      worldConsistency: "atomic",
      interactions,
      checkpoints,
      budgetUsage: budgetUsage(
        kernel,
        drill.timeline.maxToolCalls,
        drill.timeline.maxEvents,
        processedEvents,
        eventBudgetExhausted,
      ),
      error: runError(runId, error),
      assertionResults: [],
      ...(range === undefined ? {} : { evidenceRange: range }),
    });
    return { schemaVersion: 1, result, evidence, worldFilePath };
  } finally {
    releaseActiveClient();
    try {
      await closeBindings(bindings);
    } catch {
      // A primary runner result already exists. Binding close failures are handled
      // before sealing on the success path and must not turn the API into a rejection.
    } finally {
      try {
        await callbackPump?.close();
      } catch {
        // Any dispatch failure reached the main result path through flush().
      } finally {
        store?.close();
      }
    }
  }
}

function trialSeed(baseSeed: Seed, trial: number): Seed {
  const maximum = 0xffff_ffff_ffff_ffffn;
  return SeedSchema.parse(((BigInt(baseSeed) + BigInt(trial - 1)) & maximum).toString());
}

function attemptVerdict(attempt: DrillAttemptExecution): DrillTrialExecution["verdict"] {
  if (attempt.result.status !== "sealed") return "inconclusive";
  return attempt.result.verdict;
}

async function runLogicalTrial(input: {
  readonly options: RunDrillOptions;
  readonly drillId: StableId;
  readonly trial: number;
  readonly trialCount: number;
  readonly seed: Seed;
  readonly attemptLimit: number;
}): Promise<DrillTrialExecution> {
  const attempts: DrillAttemptExecution[] = [];
  for (let attempt = 1; attempt <= input.attemptLimit; attempt += 1) {
    const execution = await runDrillTrial({
      ...input.options,
      drillId: input.drillId,
      trial: input.trial,
      trialCount: input.trialCount,
      seed: input.seed,
      attempt,
      attemptLimit: input.attemptLimit,
    });
    attempts.push(execution);
    await input.options.attemptFinished?.({
      drillId: input.drillId,
      trial: input.trial,
      trialCount: input.trialCount,
      seed: input.seed,
      attempt,
      attemptLimit: input.attemptLimit,
      runId: execution.result.identity.runId,
      worldInstanceId: execution.result.identity.worldInstanceId,
      worldFilePath: execution.worldFilePath,
      execution,
    });
    if (attemptVerdict(execution) === "passed" || execution.result.status === "cancelled") break;
  }
  const final = attempts.at(-1);
  if (final === undefined) throw new Error("logical trial produced no attempts");
  const verdicts = new Set(attempts.map(attemptVerdict));
  const verdict = verdicts.size > 1 ? "inconclusive" : (verdicts.values().next().value ?? "inconclusive");
  return {
    ...final,
    trial: input.trial,
    seed: input.seed,
    verdict,
    attempts,
  };
}

/** Executes configured logical trials with deterministic seeds and bounded concurrency. */
export async function runDrill(options: RunDrillOptions): Promise<DrillExecution> {
  const drillId = StableIdSchema.parse(options.drillId);
  const drill = options.build.worldIr.drills.find((candidate) => candidate.id === drillId);
  if (drill === undefined) {
    throw new DrillSetupError("framework.DRILL_NOT_FOUND", `build has no drill ${drillId}`);
  }
  const trialCount = options.trialCount ?? drill.trials.count;
  if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 10_000) {
    throw new RangeError("trial count must be an integer from 1 through 10000");
  }
  const retries = options.retries ?? 0;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError("retries must be an integer from 0 through 10");
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RangeError("concurrency must be an integer from 1 through 64");
  }
  const baseSeed = SeedSchema.parse(options.seed ?? options.build.worldIr.world.seed);
  const ordered: Array<DrillTrialExecution | undefined> = Array.from({ length: trialCount });
  let nextTrial = 1;
  let stopScheduling = false;
  const worker = async () => {
    for (;;) {
      if (stopScheduling) return;
      const trial = nextTrial;
      if (trial > trialCount) return;
      nextTrial += 1;
      const seed = trialSeed(baseSeed, trial);
      const context = { drillId, trial, trialCount, seed };
      await options.beforeTrial?.(context);
      const execution = await runLogicalTrial({
        options,
        drillId,
        trial,
        trialCount,
        seed,
        attemptLimit: retries + 1,
      });
      ordered[trial - 1] = execution;
      await options.afterTrial?.({ ...context, execution });
      if (execution.result.status === "cancelled" || options.signal?.aborted) stopScheduling = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, trialCount) }, () => worker()));
  const trials = ordered.filter((trial): trial is DrillTrialExecution => trial !== undefined);
  const passed = trials.filter((trial) => trial.verdict === "passed").length;
  const failed = trials.filter((trial) => trial.verdict === "failed").length;
  const inconclusive = trials.length - passed - failed;
  const verdict = failed > 0 ? "failed" : inconclusive > 0 ? "inconclusive" : "passed";
  return { schemaVersion: 1, drillId, verdict, passed, failed, inconclusive, trials };
}
