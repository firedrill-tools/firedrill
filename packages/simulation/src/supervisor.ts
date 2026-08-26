import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ErrorEnvelope, RunId, RunResult, StableId } from "@firedrill/contracts";
import { PackageIdSchema, RunIdSchema, StableIdSchema } from "@firedrill/contracts";
import { verifyLocalReport } from "@firedrill/reporters";
import type { AgentCallback, CallbackReceiver, RunDrillsResult } from "@firedrill/sdk";
import { FiredrillProjectError, runDrills } from "@firedrill/sdk";
import type { WorldReader } from "@firedrill/world-store";
import { SqliteWorldReader } from "@firedrill/world-store-sqlite";
import type {
  SimulationEvidencePage,
  SimulationProject,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunSummary,
  SimulationStatePage,
  StartSimulationRun,
} from "./contracts.js";
import {
  SimulationEvidencePageSchema,
  SimulationRunDetailSchema,
  SimulationRunListSchema,
  SimulationRunRequestSchema,
  SimulationRunSummarySchema,
  SimulationStatePageSchema,
  StartSimulationRunSchema,
} from "./contracts.js";
import { loadSimulationProject } from "./project.js";

const MAX_REPORTS = 500;
const MAX_REQUEST_HISTORY = 1_000;

function bounded(value: unknown, maximum: number, fallback: string): string {
  const text = typeof value === "string" ? value : value === undefined ? fallback : String(value);
  return text.length <= maximum ? text : text.slice(0, maximum);
}

export class LocalSimulationError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope;

  constructor(status: number, code: string, message: string, details?: ErrorEnvelope["details"]) {
    super(message);
    this.name = "LocalSimulationError";
    this.status = status;
    this.envelope = {
      schemaVersion: 1,
      code,
      source: "framework",
      message,
      retryable: false,
      issues: [],
      ...(details === undefined ? {} : { details }),
    };
  }
}

interface ActiveAttempt {
  readonly requestId: StableId;
  readonly runId: RunId;
  readonly reader: WorldReader;
  readonly drillId: StableId;
  readonly worldInstanceId: string;
  readonly seed: string;
  readonly trial: number;
  readonly trialCount: number;
  readonly attempt: number;
  readonly attemptLimit: number;
  status: "running" | "cancelling" | "sealed" | "runner_failed" | "cancelled";
  result?: RunResult;
}

interface MutableRunRequest {
  readonly requestId: StableId;
  readonly drillId: StableId;
  readonly concurrency: number;
  readonly controller: AbortController;
  readonly runIds: RunId[];
  status: SimulationRunRequest["status"];
  verdict?: SimulationRunRequest["verdict"];
  error?: ErrorEnvelope;
  task?: Promise<void>;
}

export interface LocalSimulationSupervisorOptions {
  readonly root?: string;
  readonly agent?: AgentCallback;
  readonly callbackReceivers?: Readonly<Record<string, CallbackReceiver>>;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly allowRemoteHttp?: boolean;
  /** Aggregate limit for active run requests and requested trial concurrency. */
  readonly maxConcurrency?: number;
}

function publicRequest(request: MutableRunRequest): SimulationRunRequest {
  return SimulationRunRequestSchema.parse({
    schemaVersion: 1,
    requestId: request.requestId,
    drillId: request.drillId,
    status: request.status,
    runIds: request.runIds,
    ...(request.verdict === undefined ? {} : { verdict: request.verdict }),
    ...(request.error === undefined ? {} : { error: request.error }),
  });
}

function projectError(error: unknown): ErrorEnvelope {
  if (error instanceof LocalSimulationError) return error.envelope;
  if (error instanceof FiredrillProjectError) {
    return {
      schemaVersion: 1,
      code: error.code,
      source: "framework",
      message: error.message,
      retryable: false,
      issues: error.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        ...(diagnostic.suggestion === undefined ? {} : { suggestion: diagnostic.suggestion }),
      })),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
    };
  }
  return {
    schemaVersion: 1,
    code: "framework.INTERNAL_ERROR",
    source: "framework",
    message: "local simulation request failed",
    retryable: false,
    issues: [],
  };
}

function terminalSummary(
  result: RunResult,
  options: { readonly requestId?: StableId; readonly reportAvailable: boolean },
): SimulationRunSummary {
  return SimulationRunSummarySchema.parse({
    schemaVersion: 1,
    runId: result.identity.runId,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    worldInstanceId: result.identity.worldInstanceId,
    drillId: result.identity.drillId,
    ...(result.identity.scenarioId === undefined ? {} : { scenarioId: result.identity.scenarioId }),
    targetId: result.identity.targetId,
    seed: result.identity.seed,
    trial: result.identity.trial,
    trialCount: result.identity.trialCount,
    attempt: result.identity.attempt,
    attemptLimit: result.identity.attemptLimit,
    status: result.status,
    ...(result.status === "sealed" ? { verdict: result.verdict } : {}),
    virtualTimeUs: result.finishedAtVirtualUs,
    evidenceSequence: result.evidenceRange?.toSequence ?? 0,
    reportAvailable: options.reportAvailable,
  });
}

function requestId(): StableId {
  return StableIdSchema.parse(`request-${randomUUID().replaceAll("-", "")}`);
}

/** Owns local drill lifecycle while delegating every world/run semantic to the public SDK. */
export class LocalSimulationSupervisor {
  readonly repositoryRoot: string;
  readonly runDirectory: string;
  readonly reportDirectory: string;
  private readonly options: LocalSimulationSupervisorOptions;
  private readonly maxConcurrency: number;
  private readonly requests = new Map<StableId, MutableRunRequest>();
  private readonly attempts = new Map<RunId, ActiveAttempt>();
  private projectValue: SimulationProject;
  private buildHash: string;
  private closed = false;

  private constructor(
    repositoryRoot: string,
    project: SimulationProject,
    buildHash: string,
    options: LocalSimulationSupervisorOptions,
  ) {
    this.repositoryRoot = repositoryRoot;
    this.runDirectory = join(repositoryRoot, ".firedrill", "runs");
    this.reportDirectory = join(repositoryRoot, ".firedrill", "reports");
    this.projectValue = project;
    this.buildHash = buildHash;
    this.options = options;
    this.maxConcurrency = options.maxConcurrency ?? 4;
  }

  static async create(options: LocalSimulationSupervisorOptions = {}): Promise<LocalSimulationSupervisor> {
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
      throw new TypeError("maxConcurrency must be an integer from 1 through 64");
    }
    const loaded = await loadSimulationProject({
      ...(options.root === undefined ? {} : { root: options.root }),
      externalAgentAvailable: options.agent !== undefined,
    });
    return new LocalSimulationSupervisor(loaded.repositoryRoot, loaded.project, loaded.buildHash, options);
  }

  project(): SimulationProject {
    this.assertOpen();
    return this.projectValue;
  }

  async refreshProject(): Promise<SimulationProject> {
    this.assertOpen();
    if (this.activeRequestCount() > 0) {
      throw new LocalSimulationError(
        409,
        "framework.RUNS_ACTIVE",
        "wait for active drill runs to finish or cancel them before refreshing repository source",
      );
    }
    const loaded = await loadSimulationProject({
      root: this.repositoryRoot,
      externalAgentAvailable: this.options.agent !== undefined,
    });
    this.projectValue = loaded.project;
    this.buildHash = loaded.buildHash;
    return this.projectValue;
  }

  startRun(input: StartSimulationRun): SimulationRunRequest {
    this.assertOpen();
    const parsed = StartSimulationRunSchema.parse(input);
    const drill = this.projectValue.drills.find((candidate) => candidate.id === parsed.drillId);
    if (drill === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.DRILL_NOT_FOUND",
        `no drill named ${parsed.drillId} exists`,
        { available: this.projectValue.drills.map((candidate) => candidate.id) },
      );
    }
    const target = this.projectValue.targets.find((candidate) => candidate.id === drill.targetId);
    if (target === undefined) {
      throw new LocalSimulationError(
        422,
        "framework.BUILD_INVALID",
        `drill ${drill.id} references unavailable target ${drill.targetId}`,
      );
    }
    if (target.runAvailability === "agent_callback_required") {
      throw new LocalSimulationError(
        409,
        "framework.EXTERNAL_HANDLER_REQUIRED",
        `drill ${drill.id} uses external target ${target.id}; start the simulation server programmatically with the agent callback`,
      );
    }
    const concurrency = parsed.concurrency ?? 1;
    if (this.activeConcurrency() + concurrency > this.maxConcurrency) {
      throw new LocalSimulationError(
        429,
        "framework.LOCAL_CONCURRENCY_LIMIT",
        `local simulation concurrency is limited to ${this.maxConcurrency}`,
        { limit: this.maxConcurrency },
      );
    }
    const request: MutableRunRequest = {
      requestId: requestId(),
      drillId: drill.id,
      concurrency,
      controller: new AbortController(),
      runIds: [],
      status: "starting",
    };
    this.requests.set(request.requestId, request);
    this.trimRequestHistory();
    request.task = this.execute(request, parsed);
    return publicRequest(request);
  }

  runRequest(id: string): SimulationRunRequest {
    this.assertOpen();
    const parsed = StableIdSchema.safeParse(id);
    const request = parsed.success ? this.requests.get(parsed.data) : undefined;
    if (request === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.RUN_REQUEST_NOT_FOUND",
        "drill run request was not found",
      );
    }
    return publicRequest(request);
  }

  listRunRequests(): readonly SimulationRunRequest[] {
    this.assertOpen();
    return [...this.requests.values()].reverse().map(publicRequest);
  }

  cancelRunRequest(id: string): SimulationRunRequest {
    this.assertOpen();
    const parsed = StableIdSchema.safeParse(id);
    const request = parsed.success ? this.requests.get(parsed.data) : undefined;
    if (request === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.RUN_REQUEST_NOT_FOUND",
        "drill run request was not found",
      );
    }
    if (["completed", "failed", "cancelled"].includes(request.status)) {
      throw new LocalSimulationError(
        409,
        "framework.RUN_REQUEST_FINISHED",
        "the drill run request has already finished",
      );
    }
    request.status = "cancelling";
    for (const runId of request.runIds) {
      const attempt = this.attempts.get(runId);
      if (attempt !== undefined && attempt.status === "running") attempt.status = "cancelling";
    }
    request.controller.abort(new Error("drill run was cancelled from the local inspector"));
    return publicRequest(request);
  }

  listRuns(): SimulationRunList {
    this.assertOpen();
    const runs = [...this.attempts.values()].map((attempt) => this.activeSummary(attempt));
    const activeIds = new Set(runs.map((run) => run.runId));
    const unavailable: SimulationRunList["unavailable"] = [];
    if (existsSync(this.reportDirectory)) {
      const candidates = readdirSync(this.reportDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RunIdSchema.safeParse(entry.name).success)
        .map((entry) => ({
          name: entry.name,
          modified: statSync(join(this.reportDirectory, entry.name)).mtimeMs,
        }))
        .sort((left, right) => right.modified - left.modified)
        .slice(0, MAX_REPORTS);
      for (const candidate of candidates) {
        const runId = RunIdSchema.parse(candidate.name);
        if (activeIds.has(runId)) continue;
        try {
          const report = verifyLocalReport(join(this.reportDirectory, runId));
          runs.push(terminalSummary(report.result, { reportAvailable: true }));
        } catch (error) {
          unavailable.push({
            runId,
            code: bounded(
              typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
              128,
              "reporter.REPORT_INVALID",
            ),
            message: bounded(
              error instanceof Error ? error.message : undefined,
              1_000,
              "local report is invalid",
            ),
          });
        }
      }
    }
    return SimulationRunListSchema.parse({ schemaVersion: 1, runs, unavailable });
  }

  run(runId: string): SimulationRunDetail {
    this.assertOpen();
    const id = this.parseRunId(runId);
    const active = this.attempts.get(id);
    if (active !== undefined)
      return this.detailFromReader(this.activeSummary(active), active.reader, active.result);
    const report = this.report(id);
    const worldPath = join(this.runDirectory, `${id}.sqlite`);
    if (!existsSync(worldPath)) {
      return SimulationRunDetailSchema.parse({
        schemaVersion: 1,
        summary: terminalSummary(report.result, { reportAvailable: true }),
        result: report.result,
        stateNamespaces: [],
        faults: [],
        scheduledEvents: [],
        callbackDeliveries: [],
      });
    }
    const reader = SqliteWorldReader.open(worldPath);
    try {
      return this.detailFromReader(
        terminalSummary(report.result, { reportAvailable: true }),
        reader,
        report.result,
      );
    } finally {
      reader.close();
    }
  }

  evidence(runId: string, fromSequence = 1, limit = 200): SimulationEvidencePage {
    this.assertOpen();
    const id = this.parseRunId(runId);
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 1) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "fromSequence must be a positive integer",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "evidence limit must be an integer from 1 through 1000",
      );
    }
    const active = this.attempts.get(id);
    const entries =
      active === undefined
        ? this.report(id)
            .evidence.filter((entry) => entry.sequence >= fromSequence)
            .slice(0, limit)
        : active.reader.readEvidence(fromSequence, limit);
    const nextSequence = (entries.at(-1)?.sequence ?? fromSequence - 1) + 1;
    return SimulationEvidencePageSchema.parse({
      schemaVersion: 1,
      runId: id,
      fromSequence,
      entries,
      nextSequence,
    });
  }

  reportHtml(runId: string): string {
    this.assertOpen();
    const id = this.parseRunId(runId);
    this.report(id);
    return readFileSync(join(this.reportDirectory, id, "index.html"), "utf8");
  }

  state(
    runId: string,
    packageId: string,
    namespace: string,
    options: { readonly afterRowId?: string; readonly limit?: number } = {},
  ): SimulationStatePage {
    this.assertOpen();
    const id = this.parseRunId(runId);
    const owner = PackageIdSchema.safeParse(packageId);
    const stateNamespace = StableIdSchema.safeParse(namespace);
    if (!owner.success || !stateNamespace.success) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "packageId and namespace must be valid Firedrill ids",
      );
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "state limit must be an integer from 1 through 1000",
      );
    }
    if (
      options.afterRowId !== undefined &&
      (options.afterRowId.length < 1 || options.afterRowId.length > 512)
    ) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "afterRowId must contain from 1 through 512 characters",
      );
    }
    const active = this.attempts.get(id);
    const reader = active?.reader ?? this.completedReader(id);
    try {
      const materialized = reader
        .listStateNamespaces()
        .some((item) => item.packageId === owner.data && item.namespace === stateNamespace.data);
      const declaredByCurrentBuild = this.projectValue.tools.some(
        (tool) => tool.id === owner.data && tool.stateNamespaces.includes(stateNamespace.data),
      );
      if (!materialized && !declaredByCurrentBuild) {
        throw new LocalSimulationError(
          404,
          "framework.STATE_NAMESPACE_NOT_FOUND",
          `state namespace ${owner.data}.${stateNamespace.data} is not available in this world`,
        );
      }
      const records = reader.scanState(owner.data, stateNamespace.data, {
        ...(options.afterRowId === undefined ? {} : { afterRowId: options.afterRowId }),
        limit,
      });
      return SimulationStatePageSchema.parse({
        schemaVersion: 1,
        runId: id,
        packageId: owner.data,
        namespace: stateNamespace.data,
        records: records.map((record) => ({ rowId: record.rowId, value: record.value })),
        ...(records.length < limit ? {} : { nextRowId: records.at(-1)?.rowId }),
      });
    } finally {
      if (active === undefined) reader.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tasks: Promise<void>[] = [];
    for (const request of this.requests.values()) {
      if (!["completed", "failed", "cancelled"].includes(request.status)) {
        request.controller.abort(new Error("local simulation supervisor closed"));
      }
      if (request.task !== undefined) tasks.push(request.task);
    }
    await Promise.allSettled(tasks);
    for (const attempt of this.attempts.values()) attempt.reader.close();
    this.attempts.clear();
  }

  private async execute(request: MutableRunRequest, input: StartSimulationRun): Promise<void> {
    request.status = "running";
    try {
      const drill = this.projectValue.drills.find((candidate) => candidate.id === request.drillId);
      const target = this.projectValue.targets.find((candidate) => candidate.id === drill?.targetId);
      if (drill === undefined || target === undefined) {
        throw new LocalSimulationError(
          422,
          "framework.BUILD_INVALID",
          "the selected drill or target is unavailable in the pinned build",
        );
      }
      const result = await runDrills({
        root: this.repositoryRoot,
        drill: input.drillId,
        buildHash: this.buildHash,
        runDirectory: this.runDirectory,
        reportDirectory: this.reportDirectory,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.trials === undefined ? {} : { trials: input.trials }),
        ...(input.retries === undefined ? {} : { retries: input.retries }),
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(target.kind !== "external" || this.options.agent === undefined
          ? {}
          : { agent: this.options.agent }),
        ...(this.options.callbackReceivers === undefined
          ? {}
          : { callbackReceivers: this.options.callbackReceivers }),
        ...(this.options.hostEnvironment === undefined
          ? {}
          : { hostEnvironment: this.options.hostEnvironment }),
        ...(this.options.allowRemoteHttp === undefined
          ? {}
          : { allowRemoteHttp: this.options.allowRemoteHttp }),
        signal: request.controller.signal,
        hooks: {
          attemptStarted: (context) => {
            const reader = SqliteWorldReader.open(context.worldFilePath);
            const attempt: ActiveAttempt = {
              requestId: request.requestId,
              runId: context.runId,
              reader,
              drillId: context.drillId,
              worldInstanceId: context.worldInstanceId,
              seed: context.seed,
              trial: context.trial,
              trialCount: context.trialCount,
              attempt: context.attempt,
              attemptLimit: context.attemptLimit,
              status: request.status === "cancelling" ? "cancelling" : "running",
            };
            this.attempts.set(context.runId, attempt);
            request.runIds.push(context.runId);
          },
          attemptFinished: ({ runId, execution }) => {
            const attempt = this.attempts.get(runId);
            if (attempt === undefined) return;
            attempt.result = execution.result;
            attempt.status = execution.result.status;
          },
        },
      });
      this.finishRequest(request, result);
    } catch (error) {
      request.error = projectError(error);
      request.status = request.controller.signal.aborted ? "cancelled" : "failed";
    } finally {
      for (const runId of request.runIds) {
        const attempt = this.attempts.get(runId);
        attempt?.reader.close();
        this.attempts.delete(runId);
      }
    }
  }

  private finishRequest(request: MutableRunRequest, result: RunDrillsResult): void {
    request.verdict = result.verdict;
    const terminal = result.drills.flatMap((drill) => drill.trials).map((trial) => trial.result.status);
    request.status = terminal.some((status) => status === "cancelled") ? "cancelled" : "completed";
  }

  private activeSummary(attempt: ActiveAttempt): SimulationRunSummary {
    if (attempt.result !== undefined) {
      return terminalSummary(attempt.result, {
        requestId: attempt.requestId,
        reportAvailable: false,
      });
    }
    const drill = this.projectValue.drills.find((candidate) => candidate.id === attempt.drillId);
    if (drill === undefined) {
      throw new LocalSimulationError(422, "framework.BUILD_INVALID", "active drill is unavailable");
    }
    return SimulationRunSummarySchema.parse({
      schemaVersion: 1,
      runId: attempt.runId,
      requestId: attempt.requestId,
      worldInstanceId: attempt.worldInstanceId,
      drillId: attempt.drillId,
      ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
      targetId: drill.targetId,
      seed: attempt.seed,
      trial: attempt.trial,
      trialCount: attempt.trialCount,
      attempt: attempt.attempt,
      attemptLimit: attempt.attemptLimit,
      status: attempt.status,
      virtualTimeUs: attempt.reader.metadata().virtualTimeUs,
      evidenceSequence: attempt.reader.latestEvidenceSequence(),
      reportAvailable: false,
    });
  }

  private detailFromReader(
    summary: SimulationRunSummary,
    reader: WorldReader,
    result?: RunResult,
  ): SimulationRunDetail {
    return SimulationRunDetailSchema.parse({
      schemaVersion: 1,
      summary,
      ...(result === undefined ? {} : { result }),
      stateNamespaces: reader.listStateNamespaces(),
      faults: reader.listActiveFaults(),
      scheduledEvents: reader.listScheduledEvents(),
      callbackDeliveries: reader.listCallbackDeliveries(),
    });
  }

  private completedReader(runId: RunId): WorldReader {
    this.report(runId);
    const worldPath = join(this.runDirectory, `${runId}.sqlite`);
    if (!existsSync(worldPath)) {
      throw new LocalSimulationError(
        404,
        "framework.WORLD_ARTIFACT_NOT_FOUND",
        `the retained world for ${runId} is unavailable; the portable report can still be inspected`,
      );
    }
    return SqliteWorldReader.open(worldPath);
  }

  private report(runId: RunId) {
    const directory = join(this.reportDirectory, runId);
    if (!existsSync(directory)) {
      throw new LocalSimulationError(
        404,
        "framework.RUN_NOT_FOUND",
        `no local drill run named ${runId} exists`,
      );
    }
    try {
      return verifyLocalReport(directory);
    } catch (error) {
      throw new LocalSimulationError(
        422,
        "framework.REPORT_INVALID",
        bounded(error instanceof Error ? error.message : undefined, 4_000, "local report is invalid"),
      );
    }
  }

  private parseRunId(value: string): RunId {
    const parsed = RunIdSchema.safeParse(value);
    if (!parsed.success) {
      throw new LocalSimulationError(400, "framework.INVALID_ARGUMENT", "runId is invalid");
    }
    return parsed.data;
  }

  private activeRequestCount(): number {
    return [...this.requests.values()].filter(
      (request) => !["completed", "failed", "cancelled"].includes(request.status),
    ).length;
  }

  private activeConcurrency(): number {
    return [...this.requests.values()]
      .filter((request) => !["completed", "failed", "cancelled"].includes(request.status))
      .reduce((total, request) => total + request.concurrency, 0);
  }

  private trimRequestHistory(): void {
    if (this.requests.size <= MAX_REQUEST_HISTORY) return;
    for (const [id, request] of this.requests) {
      if (["completed", "failed", "cancelled"].includes(request.status)) this.requests.delete(id);
      if (this.requests.size <= MAX_REQUEST_HISTORY) return;
    }
  }

  private assertOpen(): void {
    if (this.closed)
      throw new LocalSimulationError(410, "framework.SIMULATION_CLOSED", "simulation is closed");
  }
}
