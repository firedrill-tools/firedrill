import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ErrorEnvelope, RunId, RunResult, StableId } from "@firedrill-run/contracts";
import { PackageIdSchema, RunIdSchema, StableIdSchema } from "@firedrill-run/contracts";
import { renderSavedReport, verifyLocalReport } from "@firedrill-run/reporters";
import type {
  AgentCallback,
  CallbackReceiver,
  LocalRunComparison,
  RunDrillsResult,
} from "@firedrill-run/sdk";
import { compareRuns, FiredrillProjectError, runDrills } from "@firedrill-run/sdk";
import type { WorldReader } from "@firedrill-run/world-store";
import { SqliteWorldReader } from "@firedrill-run/world-store-sqlite";
import type {
  SimulationEvidencePage,
  SimulationProject,
  SimulationReportAttachments,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunSummary,
  SimulationSourceDocument,
  SimulationSourceKind,
  SimulationStatePage,
  SimulationToolSourceDocument,
  StartSimulationRun,
} from "./contracts.js";
import {
  SimulationEvidencePageSchema,
  SimulationReportAttachmentsSchema,
  SimulationRunComparisonSchema,
  SimulationRunDetailSchema,
  SimulationRunListSchema,
  SimulationRunRequestSchema,
  SimulationRunSummarySchema,
  SimulationSourceDocumentSchema,
  SimulationSourceKindSchema,
  SimulationStatePageSchema,
  SimulationToolSourceIdSchema,
  StartSimulationRunSchema,
} from "./contracts.js";
import { loadSimulationProject } from "./project.js";

const DEFAULT_REPORT_PAGE_SIZE = 100;
const MAX_REPORT_PAGE_SIZE = 500;
const MAX_REQUEST_HISTORY = 1_000;
const MAX_SOURCE_BYTES = 1024 * 1024;

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

export interface SimulationRunListOptions {
  /** Opaque continuation returned by the preceding saved-report page. */
  readonly cursor?: string;
  /** Saved report directories per page, including invalid reports. Defaults to 100; maximum 500. */
  readonly limit?: number;
}

interface SavedRunPosition {
  readonly runId: RunId;
  readonly modified: number;
}

function compareSavedRuns(left: SavedRunPosition, right: SavedRunPosition): number {
  return (
    right.modified - left.modified || (left.runId === right.runId ? 0 : left.runId < right.runId ? 1 : -1)
  );
}

function reportDirectoryHash(reportDirectory: string): string {
  return createHash("sha256").update(reportDirectory).digest("hex");
}

function savedRunCursor(position: SavedRunPosition, reportDirectory: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, directory: reportDirectoryHash(reportDirectory), ...position }),
  ).toString("base64url");
}

function readSavedRunCursor(cursor: unknown, reportDirectory: string): SavedRunPosition {
  const invalid = () =>
    new LocalSimulationError(
      400,
      "framework.INVALID_ARGUMENT",
      "saved-run cursor is invalid for this report directory",
    );
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw invalid();
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalid();
  const value = decoded as Record<string, unknown>;
  const runId = RunIdSchema.safeParse(value.runId);
  if (
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    value.directory !== reportDirectoryHash(reportDirectory) ||
    typeof value.modified !== "number" ||
    !Number.isFinite(value.modified) ||
    !runId.success
  ) {
    throw invalid();
  }
  return { runId: runId.data, modified: value.modified };
}

function savedRunPosition(reportDirectory: string, runId: RunId): SavedRunPosition | undefined {
  try {
    const metadata = lstatSync(join(reportDirectory, runId));
    return metadata.isDirectory() ? { runId, modified: metadata.mtimeMs } : undefined;
  } catch (error) {
    // A report removed between directory enumeration and stat must not break later pages.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return undefined;
    throw error;
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
  readonly selection: SimulationRunRequest["selection"];
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
  /** Retained worlds; relative paths resolve from root. Defaults to .firedrill/runs. */
  readonly runDirectory?: string;
  /** Saved report bundles; relative paths resolve from root. Defaults to .firedrill/reports. */
  readonly reportDirectory?: string;
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
    selection: request.selection,
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

function sourceLanguage(path: string): SimulationSourceDocument["language"] {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".md":
    case ".mdx":
      return "markdown";
    default:
      return "text";
  }
}

function publicComparison(comparison: LocalRunComparison): SimulationRunComparison {
  const side = (value: LocalRunComparison["baseline"] | LocalRunComparison["candidate"]) => ({
    runId: value.runId,
    status: value.status,
    ...(value.verdict === undefined ? {} : { verdict: value.verdict }),
    drillId: value.drillId,
    ...(value.scenarioId === undefined ? {} : { scenarioId: value.scenarioId }),
    targetId: value.targetId,
    seed: value.seed,
    buildHash: value.buildHash,
    packageLockHash: value.packageLockHash,
    ...(value.stateHash === undefined ? {} : { stateHash: value.stateHash }),
    ...(value.trajectoryHash === undefined ? {} : { trajectoryHash: value.trajectoryHash }),
  });
  return SimulationRunComparisonSchema.parse({
    schemaVersion: 1,
    compatibility: comparison.compatibility,
    outcome: comparison.outcome,
    baseline: side(comparison.baseline),
    candidate: side(comparison.candidate),
    changes: comparison.changes,
  });
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
  private toolSourceDocuments: ReadonlyMap<string, ReadonlyMap<string, SimulationToolSourceDocument>>;
  private buildHash: string;
  private closed = false;

  private constructor(
    repositoryRoot: string,
    project: SimulationProject,
    buildHash: string,
    options: LocalSimulationSupervisorOptions,
    toolSourceDocuments: ReadonlyMap<string, ReadonlyMap<string, SimulationToolSourceDocument>>,
  ) {
    this.repositoryRoot = repositoryRoot;
    this.runDirectory = resolve(repositoryRoot, options.runDirectory ?? join(".firedrill", "runs"));
    this.reportDirectory = resolve(repositoryRoot, options.reportDirectory ?? join(".firedrill", "reports"));
    this.projectValue = project;
    this.toolSourceDocuments = toolSourceDocuments;
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
    return new LocalSimulationSupervisor(
      loaded.repositoryRoot,
      loaded.project,
      loaded.buildHash,
      options,
      loaded.toolSourceDocuments,
    );
  }

  project(): SimulationProject {
    this.assertOpen();
    return this.projectValue;
  }

  /** Looks up a captured compiler-selected file; callers cannot request arbitrary filesystem paths. */
  toolSource(toolId: string, fileId: string): SimulationToolSourceDocument {
    this.assertOpen();
    const tool = PackageIdSchema.safeParse(toolId);
    const file = SimulationToolSourceIdSchema.safeParse(fileId);
    if (!tool.success || !file.success) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "select a Tool implementation file from the current project",
      );
    }
    const document = this.toolSourceDocuments.get(tool.data)?.get(file.data);
    if (document === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.SOURCE_NOT_FOUND",
        "this Tool implementation source is unavailable; refresh source to check the current project",
      );
    }
    return document;
  }

  source(kind: string, id: string): SimulationSourceDocument {
    this.assertOpen();
    const sourceKind = SimulationSourceKindSchema.safeParse(kind);
    const sourceId = StableIdSchema.safeParse(id);
    if (!sourceKind.success || !sourceId.success) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "source kind and id must identify a compiled Firedrill resource",
      );
    }
    const reference = this.sourceReference(sourceKind.data, sourceId.data);
    if (reference === undefined || !reference.readable) {
      throw new LocalSimulationError(
        404,
        "framework.SOURCE_NOT_FOUND",
        `repository source is unavailable for ${sourceKind.data} ${sourceId.data}`,
      );
    }
    const absolutePath = resolve(this.repositoryRoot, reference.path);
    const repositoryPath = relative(this.repositoryRoot, absolutePath);
    if (
      repositoryPath.length === 0 ||
      isAbsolute(repositoryPath) ||
      repositoryPath === ".." ||
      repositoryPath.startsWith(`..${sep}`)
    ) {
      throw new LocalSimulationError(404, "framework.SOURCE_NOT_FOUND", "repository source is unavailable");
    }
    try {
      let sourceComponent = this.repositoryRoot;
      for (const component of reference.path.split("/")) {
        sourceComponent = join(sourceComponent, component);
        if (lstatSync(sourceComponent).isSymbolicLink()) {
          throw new LocalSimulationError(
            404,
            "framework.SOURCE_NOT_FOUND",
            "repository source cannot traverse a symbolic link",
          );
        }
      }
      const realRepositoryRoot = realpathSync(this.repositoryRoot);
      const realSourcePath = realpathSync(absolutePath);
      const realRepositoryPath = relative(realRepositoryRoot, realSourcePath);
      if (
        realRepositoryPath.length === 0 ||
        isAbsolute(realRepositoryPath) ||
        realRepositoryPath === ".." ||
        realRepositoryPath.startsWith(`..${sep}`)
      ) {
        throw new LocalSimulationError(404, "framework.SOURCE_NOT_FOUND", "repository source is unavailable");
      }
      const file = lstatSync(absolutePath);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new LocalSimulationError(
          404,
          "framework.SOURCE_NOT_FOUND",
          "repository source must be a regular file",
        );
      }
      if (file.size > MAX_SOURCE_BYTES) {
        throw new LocalSimulationError(
          413,
          "framework.SOURCE_TOO_LARGE",
          "repository source exceeds the 1 MiB inspector limit",
        );
      }
      const content = readFileSync(absolutePath, "utf8");
      if (content.includes("\u0000")) {
        throw new LocalSimulationError(
          415,
          "framework.SOURCE_NOT_TEXT",
          "repository source is not a text file",
        );
      }
      return SimulationSourceDocumentSchema.parse({
        schemaVersion: 1,
        kind: sourceKind.data,
        id: sourceId.data,
        path: reference.path,
        contentHash: reference.contentHash,
        language: sourceLanguage(reference.path),
        content,
      });
    } catch (error) {
      if (error instanceof LocalSimulationError) throw error;
      throw new LocalSimulationError(
        404,
        "framework.SOURCE_NOT_FOUND",
        `repository source is unavailable for ${sourceKind.data} ${sourceId.data}`,
      );
    }
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
    this.toolSourceDocuments = loaded.toolSourceDocuments;
    this.buildHash = loaded.buildHash;
    return this.projectValue;
  }

  startRun(input: StartSimulationRun): SimulationRunRequest {
    this.assertOpen();
    const parsed = StartSimulationRunSchema.parse(input);
    const selection =
      "drillId" in parsed
        ? ({ kind: "drill", id: parsed.drillId } as const)
        : ({ kind: "suite", id: parsed.suiteId } as const);
    const selectedDrills = this.selectedDrills(selection);
    const unavailable = selectedDrills.find((drill) => {
      const target = this.projectValue.targets.find((candidate) => candidate.id === drill.targetId);
      if (target === undefined) {
        throw new LocalSimulationError(
          422,
          "framework.BUILD_INVALID",
          `drill ${drill.id} references unavailable target ${drill.targetId}`,
        );
      }
      return target.runAvailability === "agent_callback_required";
    });
    if (unavailable !== undefined) {
      throw new LocalSimulationError(
        409,
        "framework.EXTERNAL_HANDLER_REQUIRED",
        `drill ${unavailable.id} uses an external target; start the simulation server programmatically with the agent callback`,
      );
    }
    const selectedSuite =
      selection.kind === "suite"
        ? this.projectValue.suites.find((candidate) => candidate.id === selection.id)
        : undefined;
    const concurrency = parsed.concurrency ?? selectedSuite?.concurrency ?? 1;
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
      selection,
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

  listRuns(options: SimulationRunListOptions = {}): SimulationRunList {
    this.assertOpen();
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "cursor" && key !== "limit") ||
      (options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_REPORT_PAGE_SIZE))
    ) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "saved-run limit must be an integer from 1 through 500",
      );
    }
    const limit = options.limit ?? DEFAULT_REPORT_PAGE_SIZE;
    const after =
      options.cursor === undefined ? undefined : readSavedRunCursor(options.cursor, this.reportDirectory);
    // Active attempts remain visible on every page and do not consume saved-report slots.
    const runs = [...this.attempts.values()].map((attempt) => this.activeSummary(attempt));
    const activeIds = new Set(runs.map((run) => run.runId));
    const unavailable: SimulationRunList["unavailable"] = [];
    let nextCursor: string | undefined;
    if (existsSync(this.reportDirectory)) {
      const candidates = readdirSync(this.reportDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RunIdSchema.safeParse(entry.name).success)
        .filter((entry) => !activeIds.has(entry.name))
        .flatMap((entry) => {
          const position = savedRunPosition(this.reportDirectory, RunIdSchema.parse(entry.name));
          return position === undefined ? [] : [position];
        })
        .filter((candidate) => after === undefined || compareSavedRuns(candidate, after) > 0)
        .sort(compareSavedRuns);
      const page = candidates.slice(0, limit);
      const last = page.at(-1);
      if (candidates.length > limit && last !== undefined)
        nextCursor = savedRunCursor(last, this.reportDirectory);
      for (const { runId } of page) {
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
    return SimulationRunListSchema.parse({
      schemaVersion: 1,
      runs,
      unavailable,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
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

  compare(baselineRunId: string, candidateRunId: string): SimulationRunComparison {
    this.assertOpen();
    const baseline = this.parseRunId(baselineRunId);
    const candidate = this.parseRunId(candidateRunId);
    if (baseline === candidate) {
      throw new LocalSimulationError(
        400,
        "framework.INVALID_ARGUMENT",
        "baselineRunId and candidateRunId must identify different runs",
      );
    }
    this.report(baseline);
    this.report(candidate);
    return publicComparison(
      compareRuns({
        baselineReport: join(this.reportDirectory, baseline),
        candidateReport: join(this.reportDirectory, candidate),
      }),
    );
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
    return renderSavedReport(join(this.reportDirectory, id));
  }

  reportAttachments(runId: string): SimulationReportAttachments {
    this.assertOpen();
    const id = this.parseRunId(runId);
    const report = this.report(id);
    return SimulationReportAttachmentsSchema.parse({
      schemaVersion: 1,
      runId: id,
      attachments: report.attachments.map(({ attachment }) => ({
        ...attachment,
        path: `attachments/${attachment.id}/${attachment.name}`,
      })),
    });
  }

  reportAttachment(runId: string, attachmentId: string): { readonly body: Buffer; readonly name: string } {
    this.assertOpen();
    const id = this.parseRunId(runId);
    const parsedAttachmentId = StableIdSchema.safeParse(attachmentId);
    if (!parsedAttachmentId.success) {
      throw new LocalSimulationError(400, "framework.INVALID_ARGUMENT", "attachmentId is invalid");
    }
    const report = this.report(id);
    const file = report.attachments.find((entry) => entry.attachment.id === parsedAttachmentId.data);
    if (file === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.REPORT_ATTACHMENT_NOT_FOUND",
        "this report does not contain the requested attachment",
      );
    }
    try {
      const entry = lstatSync(file.path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== file.attachment.bytes) {
        throw new Error("attachment changed");
      }
      const body = readFileSync(file.path);
      const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      if (body.byteLength !== file.attachment.bytes || hash !== file.attachment.hash) {
        throw new Error("attachment changed");
      }
      return { body, name: file.attachment.name };
    } catch {
      throw new LocalSimulationError(
        422,
        "framework.REPORT_INVALID",
        "the report attachment no longer matches its verified bytes",
      );
    }
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

  private sourceReference(kind: SimulationSourceKind, id: StableId) {
    if (kind === "world")
      return this.projectValue.world.id === id ? this.projectValue.world.source : undefined;
    const collection =
      kind === "scenario"
        ? this.projectValue.scenarios
        : kind === "tool"
          ? this.projectValue.tools
          : kind === "drill"
            ? this.projectValue.drills
            : kind === "suite"
              ? this.projectValue.suites
              : this.projectValue.targets;
    return collection.find((candidate) => candidate.id === id)?.source;
  }

  private async execute(request: MutableRunRequest, input: StartSimulationRun): Promise<void> {
    request.status = "running";
    try {
      const usesExternalTarget = this.selectedDrills(request.selection).some((drill) =>
        this.projectValue.targets.some(
          (target) => target.id === drill.targetId && target.kind === "external",
        ),
      );
      const result = await runDrills({
        root: this.repositoryRoot,
        ...(request.selection.kind === "drill"
          ? { drill: request.selection.id }
          : { suite: request.selection.id }),
        buildHash: this.buildHash,
        runDirectory: this.runDirectory,
        reportDirectory: this.reportDirectory,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.trials === undefined ? {} : { trials: input.trials }),
        ...(input.retries === undefined ? {} : { retries: input.retries }),
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(this.options.agent === undefined || !usesExternalTarget ? {} : { agent: this.options.agent }),
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

  private selectedDrills(selection: SimulationRunRequest["selection"]): SimulationProject["drills"] {
    if (selection.kind === "drill") {
      const drill = this.projectValue.drills.find((candidate) => candidate.id === selection.id);
      if (drill === undefined) {
        throw new LocalSimulationError(
          404,
          "framework.DRILL_NOT_FOUND",
          `no drill named ${selection.id} exists`,
          { available: this.projectValue.drills.map((candidate) => candidate.id) },
        );
      }
      return [drill];
    }
    const suite = this.projectValue.suites.find((candidate) => candidate.id === selection.id);
    if (suite === undefined) {
      throw new LocalSimulationError(
        404,
        "framework.SUITE_NOT_FOUND",
        `no suite named ${selection.id} exists`,
        { available: this.projectValue.suites.map((candidate) => candidate.id) },
      );
    }
    if (suite.drills.length === 0 && suite.tags.length === 0) return this.projectValue.drills;
    const explicit = new Set(suite.drills);
    const selected = this.projectValue.drills.filter(
      (drill) => explicit.has(drill.id) || drill.tags.some((tag) => suite.tags.includes(tag)),
    );
    if (selected.length === 0) {
      throw new LocalSimulationError(
        422,
        "framework.NO_DRILLS_SELECTED",
        `suite ${suite.id} selects no drills`,
      );
    }
    return selected;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new LocalSimulationError(410, "framework.SIMULATION_CLOSED", "simulation is closed");
  }
}
