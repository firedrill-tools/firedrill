import { join, resolve } from "node:path";
import { compileWorld } from "@firedrill/compiler";
import type {
  ActorId,
  Diagnostic,
  DrillShard,
  EvidenceEntry,
  JsonObject,
  JsonValue,
  RunId,
  RunResult,
  Seed,
  Sha256,
  StableId,
  TargetInvocation,
} from "@firedrill/contracts";
import { DrillShardSchema, SeedSchema, Sha256Schema, StableIdSchema } from "@firedrill/contracts";
import type { DrillExecution, DrillTrialHookContext, TargetExecutionContext } from "@firedrill/drills";
import { runDrill } from "@firedrill/drills";
import type { WrittenLocalReport } from "@firedrill/reporters";
import { verifyLocalReport, writeLocalReport } from "@firedrill/reporters";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { loadWorldBuild } from "@firedrill/world-build";
import type { BoundWorldClient } from "@firedrill/world-kernel";

export type FiredrillProjectErrorCode =
  | "framework.AGENT_CALLBACK_UNUSED"
  | "framework.BUILD_HASH_MISMATCH"
  | "framework.BUILD_INVALID"
  | "framework.DRILL_NOT_FOUND"
  | "framework.INTERNAL_ERROR"
  | "framework.INVALID_ARGUMENT"
  | "framework.NO_DRILLS"
  | "framework.NO_DRILLS_SELECTED"
  | "framework.REPORT_INVALID"
  | "framework.SUITE_NOT_FOUND"
  | "framework.SOURCE_INVALID"
  | "framework.TOOL_CONFORMANCE_FAILED"
  | "framework.TOOL_CONFORMANCE_SUITE_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_EXISTS"
  | "framework.TOOL_CONTRIBUTION_SOURCE_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_UNSAFE"
  | "framework.TOOL_NOT_FOUND";

export class FiredrillProjectError extends Error {
  readonly code: FiredrillProjectErrorCode;
  readonly diagnostics: readonly Diagnostic[];
  readonly details: JsonObject;

  constructor(
    code: FiredrillProjectErrorCode,
    message: string,
    options: { readonly diagnostics?: readonly Diagnostic[]; readonly details?: JsonObject } = {},
  ) {
    super(message);
    this.name = "FiredrillProjectError";
    this.code = code;
    this.diagnostics = options.diagnostics ?? [];
    this.details = options.details ?? {};
  }
}

export interface AgentBinding {
  /** Environment variables understood by subprocesses and standard protocol clients. */
  readonly environment: Readonly<Record<string, string>>;
  /** Present only when the selected target explicitly declares a direct binding. */
  readonly world?: BoundWorldClient;
}

export interface AgentInvocation {
  readonly runId: RunId;
  readonly drillId: StableId;
  readonly targetId: StableId;
  readonly interactionId: StableId;
  readonly actorId: ActorId;
  readonly task: {
    readonly instruction: string;
    readonly input?: JsonValue;
  };
  readonly binding: AgentBinding;
  readonly signal: AbortSignal;
}

export type AgentCallback = (invocation: AgentInvocation) => unknown | Promise<unknown>;

export interface RunDrillsOptions {
  /** Consumer repository containing firedrill.json. Defaults to process.cwd(). */
  readonly root?: string;
  /** Omit to run every repository drill. */
  readonly drill?: string;
  /** Select a repository-owned *.suite.yaml or *.suite.json definition. */
  readonly suite?: string;
  /** Further select drills carrying at least one tag. */
  readonly tags?: readonly string[];
  /** Case-insensitive substring match over drill id and title. */
  readonly filter?: string;
  /** Deterministically select one zero-based shard after other filters. */
  readonly shard?: DrillShard;
  /** Used only by source targets with kind: external. */
  readonly agent?: AgentCallback;
  /** Override the drill's declared trial count. */
  readonly trials?: number;
  /** Retry a non-passing logical trial, retaining every attempt. */
  readonly retries?: number;
  /** Maximum local trial concurrency. */
  readonly concurrency?: number;
  /** First trial seed. Later trials increment it deterministically. */
  readonly seed?: string;
  /** Load this existing immutable build instead of compiling current source. */
  readonly buildHash?: string;
  /** Defaults to <root>/.firedrill/runs. */
  readonly runDirectory?: string;
  /** Defaults to <root>/.firedrill/reports. */
  readonly reportDirectory?: string;
  /** Explicit opt-in for a target URL outside loopback. */
  readonly allowRemoteHttp?: boolean;
  /** Only target-declared names are copied from this environment. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly hooks?: RunDrillsHooks;
}

export interface ReportedAttempt {
  readonly result: RunResult;
  /** Ordered, redacted only when written to the report bundle. Treat as sensitive test data. */
  readonly evidence: readonly EvidenceEntry[];
  readonly worldFilePath: string;
  readonly report: WrittenLocalReport;
}

export interface ReportedTrial extends ReportedAttempt {
  readonly trial: number;
  readonly seed: Seed;
  readonly verdict: DrillExecution["verdict"];
  readonly attempts: readonly ReportedAttempt[];
}

export interface ReportedDrill {
  readonly drillId: StableId;
  readonly verdict: DrillExecution["verdict"];
  readonly passed: number;
  readonly failed: number;
  readonly inconclusive: number;
  readonly statistics: DrillStatistics;
  readonly trials: readonly ReportedTrial[];
}

export interface DrillStatistics {
  readonly classification: "contract" | "safety" | "quality";
  readonly interpretation: "fixed_contract_trials" | "all_trials_safety_gate" | "sampled_estimate";
  readonly requested: number;
  readonly observed: number;
  readonly excluded: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate?: number;
  /** Wilson score interval; present only for sampled quality estimates with observations. */
  readonly interval95?: { readonly lower: number; readonly upper: number };
}

export interface RunDrillsResult {
  readonly schemaVersion: 1;
  readonly repositoryRoot: string;
  /** Non-error compiler diagnostics for a source build. Empty when loading an exact existing build. */
  readonly diagnostics: readonly Diagnostic[];
  readonly buildHash: Sha256;
  readonly packageLockHash: Sha256;
  readonly verdict: DrillExecution["verdict"];
  readonly selection: {
    readonly drillIds: readonly StableId[];
    readonly suite?: StableId;
    readonly tags: readonly StableId[];
    readonly filter?: string;
    readonly shard?: DrillShard;
  };
  readonly drills: readonly ReportedDrill[];
}

export interface RunDrillsContext {
  readonly repositoryRoot: string;
  readonly buildHash: Sha256;
  readonly drillIds: readonly StableId[];
}

export interface RunDrillContext extends RunDrillsContext {
  readonly drillId: StableId;
}

export interface RunDrillsHooks {
  readonly beforeAll?: (context: RunDrillsContext) => void | Promise<void>;
  readonly afterAll?: (
    context: RunDrillsContext & { readonly result: RunDrillsResult },
  ) => void | Promise<void>;
  readonly beforeDrill?: (context: RunDrillContext) => void | Promise<void>;
  readonly afterDrill?: (
    context: RunDrillContext & { readonly result: ReportedDrill },
  ) => void | Promise<void>;
  readonly beforeTrial?: (context: RunDrillContext & DrillTrialHookContext) => void | Promise<void>;
  readonly afterTrial?: (
    context: RunDrillContext &
      DrillTrialHookContext & { readonly execution: DrillExecution["trials"][number] },
  ) => void | Promise<void>;
}

async function executableBuild(
  root: string,
  buildHash?: string,
): Promise<{ readonly build: LoadedWorldBuild; readonly diagnostics: readonly Diagnostic[] }> {
  if (buildHash !== undefined) {
    const parsed = Sha256Schema.safeParse(buildHash);
    if (!parsed.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "buildHash must be a sha256:<64 lowercase hex> value",
      );
    }
    const directory = join(root, ".firedrill", "builds", parsed.data.slice("sha256:".length));
    const loaded = await loadWorldBuild(directory);
    if (loaded.status === "failed") {
      throw new FiredrillProjectError("framework.BUILD_INVALID", "the requested build is unavailable", {
        diagnostics: loaded.diagnostics,
        details: { buildHash: parsed.data },
      });
    }
    if (loaded.build.manifest.buildHash !== parsed.data) {
      throw new FiredrillProjectError(
        "framework.BUILD_HASH_MISMATCH",
        "the loaded build does not match buildHash",
        { details: { expected: parsed.data, actual: loaded.build.manifest.buildHash } },
      );
    }
    return { build: loaded.build, diagnostics: [] };
  }

  const compiled = await compileWorld({ repositoryRoot: root, materialize: true });
  if (compiled.status === "failed") {
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "Firedrill source is invalid", {
      diagnostics: compiled.diagnostics,
    });
  }
  const directory = compiled.build.buildDirectory;
  if (directory === undefined) {
    throw new FiredrillProjectError("framework.BUILD_INVALID", "the compiler produced no executable build");
  }
  const loaded = await loadWorldBuild(directory);
  if (loaded.status === "failed") {
    throw new FiredrillProjectError("framework.BUILD_INVALID", "the compiled build failed verification", {
      diagnostics: loaded.diagnostics,
    });
  }
  return { build: loaded.build, diagnostics: compiled.diagnostics };
}

interface ValidatedRunOptions {
  readonly seed?: Seed;
  readonly tags: readonly StableId[];
  readonly filter?: string;
  readonly shard?: DrillShard;
}

function selectedDrills(build: LoadedWorldBuild, options: RunDrillsOptions, validated: ValidatedRunOptions) {
  if (build.worldIr.drills.length === 0) {
    throw new FiredrillProjectError(
      "framework.NO_DRILLS",
      "no drills were found; add a *.drill.yaml file and try again",
    );
  }
  let suite = undefined as LoadedWorldBuild["worldIr"]["suites"][number] | undefined;
  let drills = [...build.worldIr.drills];
  if (options.drill !== undefined) {
    const parsed = StableIdSchema.safeParse(options.drill);
    if (!parsed.success) {
      throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "drill must be a valid Firedrill id");
    }
    const selected = drills.find((drill) => drill.id === parsed.data);
    if (selected === undefined) {
      throw new FiredrillProjectError("framework.DRILL_NOT_FOUND", `no drill named ${parsed.data} exists`, {
        details: { requested: parsed.data, available: drills.map((drill) => drill.id) },
      });
    }
    drills = [selected];
  } else if (options.suite !== undefined) {
    const parsed = StableIdSchema.safeParse(options.suite);
    if (!parsed.success) {
      throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "suite must be a valid Firedrill id");
    }
    suite = build.worldIr.suites.find((candidate) => candidate.id === parsed.data);
    if (suite === undefined) {
      throw new FiredrillProjectError("framework.SUITE_NOT_FOUND", `no suite named ${parsed.data} exists`, {
        details: { requested: parsed.data, available: build.worldIr.suites.map((item) => item.id) },
      });
    }
    if (suite.drills.length > 0 || suite.tags.length > 0) {
      const ids = new Set(suite.drills);
      drills = drills.filter(
        (drill) => ids.has(drill.id) || drill.tags.some((tag) => suite?.tags.includes(tag)),
      );
    }
  }
  if (validated.tags.length > 0) {
    drills = drills.filter((drill) => drill.tags.some((tag) => validated.tags.includes(tag)));
  }
  if (validated.filter !== undefined) {
    const query = validated.filter.toLowerCase();
    drills = drills.filter(
      (drill) => drill.id.toLowerCase().includes(query) || drill.title?.toLowerCase().includes(query),
    );
  }
  if (validated.shard !== undefined) {
    const shard = validated.shard;
    drills = drills.filter((_, index) => index % shard.total === shard.index);
  }
  if (drills.length === 0) {
    throw new FiredrillProjectError(
      "framework.NO_DRILLS_SELECTED",
      "the requested suite, tags, filter, and shard selected no drills",
      {
        details: {
          available: build.worldIr.drills.map((drill) => drill.id),
          ...(options.suite === undefined ? {} : { suite: options.suite }),
          tags: [...validated.tags],
          ...(validated.filter === undefined ? {} : { filter: validated.filter }),
          ...(validated.shard === undefined ? {} : { shard: validated.shard }),
        },
      },
    );
  }
  return { drills, suite };
}

function validateOptions(options: RunDrillsOptions): ValidatedRunOptions {
  if (
    options.drill !== undefined &&
    (options.suite !== undefined ||
      (options.tags?.length ?? 0) > 0 ||
      options.filter !== undefined ||
      options.shard !== undefined)
  ) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "drill cannot be combined with suite, tags, filter, or shard",
    );
  }
  if (
    options.trials !== undefined &&
    (!Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 10_000)
  ) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "trials must be an integer from 1 through 10000",
    );
  }
  if (
    options.retries !== undefined &&
    (!Number.isSafeInteger(options.retries) || options.retries < 0 || options.retries > 10)
  ) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "retries must be an integer from 0 through 10",
    );
  }
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64)
  ) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "concurrency must be an integer from 1 through 64",
    );
  }
  const tags = [...new Set(options.tags ?? [])].map((tag) => {
    const parsed = StableIdSchema.safeParse(tag);
    if (!parsed.success) {
      throw new FiredrillProjectError("framework.INVALID_ARGUMENT", `tag ${tag} is not a valid Firedrill id`);
    }
    return parsed.data;
  });
  tags.sort((left, right) => left.localeCompare(right));
  const filter = options.filter?.trim();
  if (filter !== undefined && (filter.length === 0 || filter.length > 200)) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "filter must contain from 1 through 200 characters",
    );
  }
  const parsedShard = options.shard === undefined ? undefined : DrillShardSchema.safeParse(options.shard);
  if (parsedShard !== undefined && !parsedShard.success) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "shard must use a zero-based index smaller than total",
    );
  }
  if (options.seed === undefined) {
    return {
      tags,
      ...(filter === undefined ? {} : { filter }),
      ...(parsedShard?.success ? { shard: parsedShard.data } : {}),
    };
  }
  const parsedSeed = SeedSchema.safeParse(options.seed);
  if (!parsedSeed.success) {
    throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "seed must be an unsigned 64-bit integer");
  }
  return {
    seed: parsedSeed.data,
    tags,
    ...(filter === undefined ? {} : { filter }),
    ...(parsedShard?.success ? { shard: parsedShard.data } : {}),
  };
}

function agentHandler(input: {
  readonly callback: AgentCallback;
  readonly drillId: StableId;
  readonly targetId: StableId;
}) {
  return (invocation: TargetInvocation, context: TargetExecutionContext) =>
    input.callback({
      runId: invocation.runId,
      drillId: input.drillId,
      targetId: input.targetId,
      interactionId: invocation.interactionId,
      actorId: invocation.actorId,
      task: {
        instruction: invocation.instruction,
        ...(invocation.input === undefined ? {} : { input: invocation.input }),
      },
      binding: {
        environment: invocation.bindingEnvironment,
        ...(context.world === undefined ? {} : { world: context.world }),
      },
      signal: context.signal,
    });
}

function drillStatistics(
  classification: DrillStatistics["classification"],
  execution: DrillExecution,
  requested: number,
): DrillStatistics {
  const observed = execution.passed + execution.failed;
  const base = {
    classification,
    interpretation:
      classification === "quality"
        ? ("sampled_estimate" as const)
        : classification === "safety"
          ? ("all_trials_safety_gate" as const)
          : ("fixed_contract_trials" as const),
    requested,
    observed,
    excluded: execution.inconclusive,
    passed: execution.passed,
    failed: execution.failed,
  };
  if (observed === 0) return base;
  const passRate = execution.passed / observed;
  if (classification !== "quality") return { ...base, passRate };
  const z = 1.959_963_984_540_054;
  const zSquared = z * z;
  const denominator = 1 + zSquared / observed;
  const center = (passRate + zSquared / (2 * observed)) / denominator;
  const margin =
    (z * Math.sqrt((passRate * (1 - passRate)) / observed + zSquared / (4 * observed * observed))) /
    denominator;
  return {
    ...base,
    passRate,
    interval95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) },
  };
}

/**
 * Runs one or every repository drill locally and writes a verified report per trial.
 * The customer's agent remains caller-owned; external targets use the optional agent callback.
 */
export async function runDrills(options: RunDrillsOptions = {}): Promise<RunDrillsResult> {
  const root = resolve(options.root ?? process.cwd());
  const validated = validateOptions(options);
  const preparedBuild = await executableBuild(root, options.buildHash);
  const build = preparedBuild.build;
  const selected = selectedDrills(build, options, validated);
  const drills = selected.drills;
  if (options.agent !== undefined) {
    const externalTargets = new Set(
      build.worldIr.targets.filter((target) => target.kind === "external").map((target) => target.id),
    );
    if (!drills.some((drill) => externalTargets.has(drill.targetId))) {
      throw new FiredrillProjectError(
        "framework.AGENT_CALLBACK_UNUSED",
        "agent was supplied, but the selected drill does not use an external target",
      );
    }
  }

  const runDirectory = resolve(root, options.runDirectory ?? join(".firedrill", "runs"));
  const reportDirectory = resolve(root, options.reportDirectory ?? join(".firedrill", "reports"));
  const suiteId = selected.suite?.id;
  const selectedTrials = options.trials ?? selected.suite?.trials;
  const selectedRetries = options.retries ?? selected.suite?.retries ?? 0;
  const selectedConcurrency = options.concurrency ?? selected.suite?.concurrency ?? 1;
  const allContext: RunDrillsContext = {
    repositoryRoot: root,
    buildHash: build.manifest.buildHash,
    drillIds: drills.map((drill) => drill.id),
  };
  await options.hooks?.beforeAll?.(allContext);
  const reported: ReportedDrill[] = [];
  for (const drill of drills) {
    const target = build.worldIr.targets.find((candidate) => candidate.id === drill.targetId);
    if (target === undefined) {
      throw new FiredrillProjectError(
        "framework.BUILD_INVALID",
        `drill ${drill.id} references unavailable target ${drill.targetId}`,
      );
    }
    const drillContext: RunDrillContext = { ...allContext, drillId: drill.id };
    await options.hooks?.beforeDrill?.(drillContext);
    const execution = await runDrill({
      build,
      drillId: drill.id,
      repositoryRoot: root,
      runDirectory,
      ...(selectedTrials === undefined ? {} : { trialCount: selectedTrials }),
      retries: selectedRetries,
      concurrency: selectedConcurrency,
      ...(validated.seed === undefined ? {} : { seed: validated.seed }),
      ...(options.agent === undefined || target.kind !== "external"
        ? {}
        : {
            externalHandler: agentHandler({
              callback: options.agent,
              drillId: drill.id,
              targetId: target.id,
            }),
          }),
      ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
      ...(options.allowRemoteHttp === undefined ? {} : { allowRemoteHttp: options.allowRemoteHttp }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.hooks?.beforeTrial === undefined
        ? {}
        : {
            beforeTrial: (context: DrillTrialHookContext) =>
              options.hooks?.beforeTrial?.({ ...drillContext, ...context }),
          }),
      ...(options.hooks?.afterTrial === undefined
        ? {}
        : {
            afterTrial: (
              context: DrillTrialHookContext & {
                readonly execution: DrillExecution["trials"][number];
              },
            ) => options.hooks?.afterTrial?.({ ...drillContext, ...context }),
          }),
    });
    const trials = execution.trials.map((trial): ReportedTrial => {
      const attempts = trial.attempts.map((attempt): ReportedAttempt => {
        const report = writeLocalReport(
          { result: attempt.result, evidence: attempt.evidence, tools: build.worldIr.tools },
          join(reportDirectory, attempt.result.identity.runId),
        );
        verifyLocalReport(report.directory);
        return {
          result: attempt.result,
          evidence: attempt.evidence,
          worldFilePath: attempt.worldFilePath,
          report,
        };
      });
      const final = attempts.at(-1);
      if (final === undefined) throw new Error("reported logical trial has no attempts");
      return {
        ...final,
        trial: trial.trial,
        seed: trial.seed,
        verdict: trial.verdict,
        attempts,
      };
    });
    const reportedDrill: ReportedDrill = {
      drillId: execution.drillId,
      verdict: execution.verdict,
      passed: execution.passed,
      failed: execution.failed,
      inconclusive: execution.inconclusive,
      statistics: drillStatistics(
        drill.trials.classification,
        execution,
        selectedTrials ?? drill.trials.count,
      ),
      trials,
    };
    reported.push(reportedDrill);
    await options.hooks?.afterDrill?.({ ...drillContext, result: reportedDrill });
    if (options.signal?.aborted) break;
  }
  const verdict = reported.some((drill) => drill.verdict === "failed")
    ? "failed"
    : reported.some((drill) => drill.verdict === "inconclusive")
      ? "inconclusive"
      : "passed";
  const result: RunDrillsResult = {
    schemaVersion: 1,
    repositoryRoot: root,
    diagnostics: preparedBuild.diagnostics,
    buildHash: build.manifest.buildHash,
    packageLockHash: build.manifest.packageLockHash,
    verdict,
    selection: {
      drillIds: drills.map((drill) => drill.id),
      ...(suiteId === undefined ? {} : { suite: suiteId }),
      tags: [...validated.tags],
      ...(validated.filter === undefined ? {} : { filter: validated.filter }),
      ...(validated.shard === undefined ? {} : { shard: validated.shard }),
    },
    drills: reported,
  };
  await options.hooks?.afterAll?.({ ...allContext, result });
  return result;
}
