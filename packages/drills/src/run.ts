import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  BindingEvidence,
  EvidenceEntry,
  RunCaptureHandle,
  RunId,
  RunResult,
  Seed,
  StableId,
  TargetDescriptor,
  TargetInvocation,
  WorldInstanceId,
} from "@firedrill-tools/contracts";
import {
  RunIdSchema,
  SeedSchema,
  StableIdSchema,
  TargetInvocationSchema,
  WorldInstanceIdSchema,
} from "@firedrill-tools/contracts";
import { startCliWorldBinding } from "@firedrill-tools/protocol-cli";
import type { CallbackReceiver, ToolUiRevision } from "@firedrill-tools/protocol-http";
import {
  CallbackDispatcher,
  startHttpWorldBinding,
  startToolUiBinding,
} from "@firedrill-tools/protocol-http";
import { startMcpWorldBinding } from "@firedrill-tools/protocol-mcp";
import type { LoadedWorldBuild } from "@firedrill-tools/world-build";
import type { BoundWorldClient } from "@firedrill-tools/world-kernel";
import type { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import {
  type DrillCallbackSettlement,
  type DrillCoordinatorStep,
  DrillTrialCoordinator,
} from "./coordinator.js";
import { createDrillWorld, DrillSetupError } from "./scenario.js";
import type { DrillExecutionBinding, DrillToolApp, TargetAttachmentSink, TargetHandler } from "./targets.js";
import { invokeTarget } from "./targets.js";

interface WorldBinding {
  close(): Promise<void>;
}

async function verifyWorldBinding(binding: {
  readonly environment: Readonly<Record<string, string>>;
}): Promise<void> {
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
  /** Stages files explicitly attached by an in-process target handler. */
  readonly attachmentSink?: TargetAttachmentSink;
  /** Optional supporting capture supplied by the embedding runner; never an actor capability. */
  readonly captureFactory?: (invocation: TargetInvocation, signal: AbortSignal) => RunCaptureHandle;
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

interface CallbackPump extends DrillCallbackSettlement {
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
    nextDueUs: () => dispatcher.nextDueUs(),
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
  identity: {
    readonly worldInstanceId: WorldInstanceId;
    readonly actorId: string;
    readonly getRevision: () => ToolUiRevision;
  },
): Promise<{
  readonly bindings: readonly WorldBinding[];
  readonly executionBinding: DrillExecutionBinding;
  readonly environment: Record<string, string>;
  readonly routeVerified: boolean;
}> {
  const bindings: WorldBinding[] = [];
  const apps: DrillToolApp[] = [];
  const environment: Record<string, string> = {};
  let routeVerified = false;
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
      routeVerified = true;
    }
    for (const ui of build.toolUis) {
      const tool = build.tools.find((candidate) => candidate.manifest.id === ui.packageId);
      if (tool === undefined) throw new Error("A Tool app requires its loaded Tool");
      const binding = await startToolUiBinding({ client, tool, ui, ...identity });
      bindings.push(binding);
      apps.push(Object.freeze({ packageId: binding.packageId, title: binding.title, url: binding.url }));
    }
    const executionBinding = Object.freeze({ apps: Object.freeze(apps) });
    environment.FIREDRILL_TOOL_APPS = JSON.stringify(apps);
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
    return { bindings, executionBinding, environment, routeVerified };
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

function invocationBindingEvidence(callsIssued: number, routeVerified: boolean): BindingEvidence {
  if (callsIssued > 0) return "observed";
  return routeVerified ? "route_verified" : "issued";
}

function executionSuffix(): string {
  return randomUUID().replaceAll("-", "");
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
  const trial = options.trial ?? 1;
  const attemptLimit = options.attemptLimit ?? 1;
  const attempt = options.attempt ?? 1;
  const seed = SeedSchema.parse(options.seed ?? options.build.worldIr.world.seed);
  const suffix = executionSuffix();
  const runId = RunIdSchema.parse(options.runId ?? `run_${suffix}`);
  const worldInstanceId = WorldInstanceIdSchema.parse(options.worldInstanceId ?? `world_${suffix}`);
  const runDirectory = resolve(options.runDirectory);
  mkdirSync(runDirectory, { recursive: true });
  const worldFilePath = join(runDirectory, `${runId}.sqlite`);
  let store: SqliteWorldStore | undefined;
  let callbackPump: CallbackPump | undefined;
  let coordinator: DrillTrialCoordinator | undefined;
  let bindings: readonly WorldBinding[] = [];
  let activeClient: BoundWorldClient | undefined;
  const toolBudgetController = new AbortController();
  const targetSignal =
    options.signal === undefined
      ? toolBudgetController.signal
      : AbortSignal.any([options.signal, toolBudgetController.signal]);
  const releaseActiveClient = () => {
    activeClient?.revoke();
    activeClient = undefined;
  };

  try {
    const world = createDrillWorld({
      build: options.build,
      drillId,
      filePath: worldFilePath,
      worldInstanceId,
      correlationId: `corr_create_${suffix}`,
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
    const callbackDispatcher = new CallbackDispatcher({
      store,
      tools: options.build.tools,
      receivers: options.callbackReceivers ?? {},
    });
    callbackDispatcher.recoverInFlight();
    callbackPump = startCallbackPump(callbackDispatcher);
    coordinator = new DrillTrialCoordinator({
      build: options.build,
      drillId,
      store,
      kernel: world.kernel,
      callbacks: callbackPump,
      identity: { runId, worldInstanceId, trial, trialCount, attempt, attemptLimit, seed },
    });

    let step: DrillCoordinatorStep = await coordinator.next();
    for (;;) {
      if (step.kind === "terminal") {
        return {
          schemaVersion: 1,
          result: step.result,
          evidence: coordinator.evidenceEntries(),
          worldFilePath,
        };
      }
      if (step.kind === "ready_to_seal") {
        const result = options.signal?.aborted
          ? coordinator.cancel("drill run was cancelled")
          : await coordinator.seal();
        return {
          schemaVersion: 1,
          result,
          evidence: coordinator.evidenceEntries(),
          worldFilePath,
        };
      }
      if (step.kind === "continue") {
        step = await coordinator.next();
        continue;
      }

      const { pending } = step;
      const actorClient = world.clients.get(pending.interaction.actorId);
      if (actorClient === undefined) {
        throw new DrillSetupError(
          "framework.ACTOR_NOT_FOUND",
          `interaction ${pending.interaction.id} references unavailable actor ${pending.interaction.actorId}`,
        );
      }
      const client = actorClient.scope(`${runId}:${pending.interaction.id}`);
      activeClient = client;
      const exposed = await worldBindings(target, options.build, client, {
        worldInstanceId,
        actorId: pending.interaction.actorId,
        getRevision: () => ({
          generation: 0,
          evidenceSequence: world.store.latestEvidenceSequence([
            "state_change",
            "clock",
            "fault_control",
            "lifecycle",
            "event",
          ]),
        }),
      });
      bindings = exposed.bindings;
      const invocation = TargetInvocationSchema.parse({
        schemaVersion: 1,
        runId,
        interactionId: pending.interaction.id,
        actorId: pending.interaction.actorId,
        instruction: pending.interaction.task.instruction,
        ...(pending.interaction.task.input === undefined ? {} : { input: pending.interaction.task.input }),
        bindingEnvironment: exposed.environment,
      });
      const targetResult = await invokeTarget({
        descriptor: target,
        invocation,
        repositoryRoot: options.repositoryRoot,
        worldClient: client,
        binding: exposed.executionBinding,
        ...(options.externalHandler === undefined ? {} : { externalHandler: options.externalHandler }),
        ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
        ...(options.allowRemoteHttp === undefined ? {} : { allowRemoteHttp: options.allowRemoteHttp }),
        ...(options.attachmentSink === undefined ? {} : { attachmentSink: options.attachmentSink }),
        ...(options.captureFactory === undefined ? {} : { captureFactory: options.captureFactory }),
        signal: targetSignal,
      });
      const callsIssued = client.callsIssued();
      releaseActiveClient();
      await closeBindings(bindings);
      bindings = [];
      step = await coordinator.complete({
        interactionId: pending.interaction.id,
        targetResult,
        bindingEvidence: invocationBindingEvidence(callsIssued, exposed.routeVerified),
        callsIssued,
      });
    }
  } catch (error) {
    releaseActiveClient();
    if (coordinator === undefined) throw error;
    return {
      schemaVersion: 1,
      result: coordinator.fail(error),
      evidence: coordinator.evidenceEntries(),
      worldFilePath,
    };
  } finally {
    releaseActiveClient();
    try {
      await closeBindings(bindings);
    } catch {
      // The primary runner result owns classification; teardown cannot rewrite it.
    } finally {
      try {
        await callbackPump?.close();
      } catch {
        // Any dispatch failure reached the primary result path through flush().
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
