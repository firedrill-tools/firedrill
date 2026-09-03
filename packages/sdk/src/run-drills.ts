import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ActorId,
  Diagnostic,
  DrillShard,
  EvidenceEntry,
  JsonValue,
  RunId,
  RunResult,
  RunSetupRecord,
  RunWorldSetup,
  RunWorldSetupInput,
  Seed,
  Sha256,
  StableId,
  TargetFileAttachment,
  TargetInvocation,
} from "@firedrill/contracts";
import {
  DrillShardSchema,
  RunWorldSetupSchema,
  SeedSchema,
  StableIdSchema,
  TargetFileAttachmentSchema,
  compareStableStrings,
} from "@firedrill/contracts";
import type {
  CallbackReceiver,
  DrillAttemptHookContext,
  DrillExecution,
  DrillTrialHookContext,
  TargetAttachmentSink,
  TargetExecutionContext,
} from "@firedrill/drills";
import { runDrill, TargetAttachmentError } from "@firedrill/drills";
import type { LocalReportAttachmentSource, WrittenLocalReport } from "@firedrill/reporters";
import { verifyLocalReport, writeLocalReport } from "@firedrill/reporters";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { prepareExecutableBuild } from "./project-build.js";
import { FiredrillProjectError } from "./project-error.js";

export interface AgentBinding {
  /** Environment variables understood by subprocesses and standard protocol clients. */
  readonly environment: Readonly<Record<string, string>>;
  /** Present only when the selected target explicitly declares a direct binding. */
  readonly world?: BoundWorldClient;
}

export interface AgentFileAttachmentInput {
  /** Repository-relative path to an existing regular file. */
  readonly path: string;
  /** Portable report file name. Defaults to the source basename. */
  readonly name?: string;
  readonly mediaType: string;
  /** Firedrill copies bytes verbatim. Redaction, when needed, is caller-owned. */
  readonly redaction?: {
    readonly status: "not_applied" | "applied_by_caller";
    readonly note?: string;
  };
}
export type AgentFileAttachment = TargetFileAttachment;

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
  /** Copies a repository-local file into this attempt's portable report bundle. */
  readonly attach: (input: AgentFileAttachmentInput) => AgentFileAttachment;
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
  /** Serializable, test-local data, Tool, and binding overrides for one selected drill. */
  readonly setup?: RunWorldSetupInput;
  /** Defaults to <root>/.firedrill/runs. */
  readonly runDirectory?: string;
  /** Defaults to <root>/.firedrill/reports. */
  readonly reportDirectory?: string;
  /** Explicit opt-in for a target URL outside loopback. */
  readonly allowRemoteHttp?: boolean;
  /** Runtime-local application endpoints for callbacks emitted by the synthetic world. */
  readonly callbackReceivers?: Readonly<Record<string, CallbackReceiver>>;
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
  readonly setup?: RunSetupRecord;
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
  /** Observe a live attempt once its queryable world exists and before the target acts. */
  readonly attemptStarted?: (context: RunDrillContext & DrillAttemptHookContext) => void | Promise<void>;
  readonly attemptFinished?: (
    context: RunDrillContext &
      DrillAttemptHookContext & { readonly execution: DrillExecution["trials"][number]["attempts"][number] },
  ) => void | Promise<void>;
}

interface ValidatedRunOptions {
  readonly seed?: Seed;
  readonly tags: readonly StableId[];
  readonly filter?: string;
  readonly shard?: DrillShard;
  readonly callbackReceivers?: Readonly<Record<string, CallbackReceiver>>;
  readonly setup?: RunWorldSetup;
}

const MAX_ATTACHMENTS_PER_RUN = 32;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_PER_RUN = 128 * 1024 * 1024;
const ATTACHMENT_MEDIA_TYPES = new Set([
  "application/json",
  "application/zip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/html",
  "text/plain",
  "video/webm",
]);

function contained(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

interface StagedAttachment {
  readonly attachment: TargetFileAttachment;
  readonly path: string;
}

class LocalAttachmentStager {
  readonly root: string;
  readonly byRun = new Map<RunId, StagedAttachment[]>();
  #stageRoot: string | undefined;

  constructor(repositoryRoot: string) {
    this.root = realpathSync(repositoryRoot);
  }

  readonly sink: TargetAttachmentSink = ({ invocation, attachment }) => {
    if (
      typeof attachment.path !== "string" ||
      attachment.path.length === 0 ||
      attachment.path.length > 4096
    ) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_INVALID",
        "attachment path must contain from 1 through 4096 characters",
      );
    }
    if (!ATTACHMENT_MEDIA_TYPES.has(attachment.mediaType)) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_MEDIA_TYPE_UNSUPPORTED",
        `attachment media type ${attachment.mediaType} is not supported`,
        { supported: [...ATTACHMENT_MEDIA_TYPES].sort(compareStableStrings) },
      );
    }
    const name = attachment.name ?? basename(attachment.path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) || name === "." || name === "..") {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_NAME_INVALID",
        "attachment name must be a portable file name using letters, numbers, dots, dashes, or underscores",
      );
    }
    const redaction = attachment.redaction ?? { status: "not_applied" as const };
    if (
      !["not_applied", "applied_by_caller"].includes(redaction.status) ||
      (redaction.note !== undefined && (redaction.note.length === 0 || redaction.note.length > 500))
    ) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_REDACTION_INVALID",
        "attachment redaction status or note is invalid",
      );
    }

    const unresolved = resolve(this.root, attachment.path);
    if (!contained(this.root, unresolved)) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_PATH_OUTSIDE_REPOSITORY",
        "attachment path resolves outside the consumer repository",
      );
    }
    const relativePath = relative(this.root, unresolved);
    let current = this.root;
    try {
      for (const segment of relativePath.split(sep).filter((part) => part.length > 0)) {
        current = join(current, segment);
        if (lstatSync(current).isSymbolicLink()) {
          throw new TargetAttachmentError(
            "target.ATTACHMENT_SYMLINK_FORBIDDEN",
            "attachment path cannot contain a symbolic link",
          );
        }
      }
    } catch (error) {
      if (error instanceof TargetAttachmentError) throw error;
      const filesystemCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "UNKNOWN";
      throw new TargetAttachmentError(
        filesystemCode === "ENOENT" ? "target.ATTACHMENT_NOT_FOUND" : "target.ATTACHMENT_UNAVAILABLE",
        filesystemCode === "ENOENT" ? "attachment file does not exist" : "attachment file cannot be accessed",
        { filesystemCode },
      );
    }
    const source = realpathSync(unresolved);
    if (!contained(this.root, source)) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_PATH_OUTSIDE_REPOSITORY",
        "attachment path resolves outside the consumer repository",
      );
    }
    const metadata = lstatSync(source);
    if (!metadata.isFile()) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_NOT_FILE",
        "attachment source must be a regular file",
      );
    }
    if (metadata.size > MAX_ATTACHMENT_BYTES) {
      throw new TargetAttachmentError("target.ATTACHMENT_TOO_LARGE", "one attachment cannot exceed 64 MiB", {
        bytes: metadata.size,
        limit: MAX_ATTACHMENT_BYTES,
      });
    }
    const existing = this.byRun.get(invocation.runId) ?? [];
    if (existing.length >= MAX_ATTACHMENTS_PER_RUN) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_LIMIT_EXCEEDED",
        `one run supports at most ${MAX_ATTACHMENTS_PER_RUN} file attachments`,
      );
    }
    const body = readFileSync(source);
    if (body.byteLength !== metadata.size || body.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_CHANGED",
        "attachment changed while Firedrill was reading it",
      );
    }
    const totalBytes = existing.reduce((total, item) => total + item.attachment.bytes, 0) + body.byteLength;
    if (totalBytes > MAX_ATTACHMENT_BYTES_PER_RUN) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_LIMIT_EXCEEDED",
        "file attachments for one run cannot exceed 128 MiB",
        { bytes: totalBytes, limit: MAX_ATTACHMENT_BYTES_PER_RUN },
      );
    }

    this.#stageRoot ??= mkdtempSync(join(tmpdir(), "firedrill-attachment-stage-"));
    const id = StableIdSchema.parse(`attachment-${randomUUID().replaceAll("-", "")}`);
    const runRoot = join(this.#stageRoot, invocation.runId);
    mkdirSync(runRoot, { recursive: true });
    const stagedPath = join(runRoot, id);
    writeFileSync(stagedPath, body, { flag: "wx" });
    const descriptor = TargetFileAttachmentSchema.parse({
      schemaVersion: 1,
      kind: "file",
      id,
      name,
      mediaType: attachment.mediaType,
      bytes: body.byteLength,
      hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      redaction,
    });
    existing.push({ attachment: descriptor, path: stagedPath });
    this.byRun.set(invocation.runId, existing);
    return descriptor;
  };

  sources(runId: RunId): readonly LocalReportAttachmentSource[] {
    return (this.byRun.get(runId) ?? []).map((attachment) => ({
      attachmentId: attachment.attachment.id,
      path: attachment.path,
    }));
  }

  dispose(): void {
    if (this.#stageRoot !== undefined) {
      rmSync(this.#stageRoot, { force: true, recursive: true });
      this.#stageRoot = undefined;
    }
    this.byRun.clear();
  }
}

function drillShardIndex(drillId: string, total: number): number {
  const digest = createHash("sha256").update("firedrill.drill-shard.v1\0").update(drillId).digest();
  return digest.readUInt32BE(0) % total;
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
    drills = drills.filter((drill) => drillShardIndex(drill.id, shard.total) === shard.index);
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

function validatedCallbackReceivers(
  value: RunDrillsOptions["callbackReceivers"],
): Readonly<Record<string, CallbackReceiver>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "callbackReceivers must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "callbackReceivers supports at most 64 local receivers",
    );
  }
  const receivers: Record<string, CallbackReceiver> = {};
  for (const [receiverId, candidate] of entries) {
    if (!StableIdSchema.safeParse(receiverId).success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} is not a valid Firedrill id`,
      );
    }
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} must contain a loopback baseUrl`,
      );
    }
    const record = candidate as unknown as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "baseUrl" && key !== "secret")) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} contains an unsupported option`,
      );
    }
    if (typeof record.baseUrl !== "string") {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} must contain a loopback baseUrl`,
      );
    }
    let url: URL;
    try {
      url = new URL(record.baseUrl);
    } catch {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} has an invalid origin`,
      );
    }
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} must be a credential-free loopback HTTP origin`,
      );
    }
    if (
      record.secret !== undefined &&
      (typeof record.secret !== "string" || record.secret.length === 0 || record.secret.length > 65_536)
    ) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `callback receiver ${receiverId} secret must contain from 1 through 65536 characters`,
      );
    }
    receivers[receiverId] = {
      baseUrl: url.origin,
      ...(typeof record.secret === "string" ? { secret: record.secret } : {}),
    };
  }
  return Object.freeze(receivers);
}

function validateOptions(options: RunDrillsOptions): ValidatedRunOptions {
  const callbackReceivers = validatedCallbackReceivers(options.callbackReceivers);
  let setup: RunWorldSetup | undefined;
  if (options.setup !== undefined) {
    if (options.drill === undefined) {
      throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "setup requires one explicit drill");
    }
    if (options.buildHash !== undefined) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "setup cannot be combined with buildHash; reproduce the derived setup by buildHash alone",
      );
    }
    if (!StableIdSchema.safeParse(options.drill).success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "drill must be a valid Firedrill id before applying setup",
      );
    }
    const parsedSetup = RunWorldSetupSchema.safeParse(options.setup);
    if (!parsedSetup.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `setup is invalid: ${parsedSetup.error.issues[0]?.message ?? "invalid setup"}`,
        {
          details: {
            issues: parsedSetup.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      );
    }
    setup = parsedSetup.data;
  }
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
  tags.sort(compareStableStrings);
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
      ...(callbackReceivers === undefined ? {} : { callbackReceivers }),
      ...(setup === undefined ? {} : { setup }),
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
    ...(callbackReceivers === undefined ? {} : { callbackReceivers }),
    ...(setup === undefined ? {} : { setup }),
  };
}

function agentHandler(input: {
  readonly callback: AgentCallback;
  readonly drillId: StableId;
  readonly targetId: StableId;
}) {
  return (invocation: TargetInvocation, context: TargetExecutionContext) => {
    if (context.attach === undefined) {
      throw new TargetAttachmentError(
        "target.ATTACHMENT_UNAVAILABLE",
        "the local runner did not provide its report attachment sink",
      );
    }
    return input.callback({
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
      attach: context.attach,
    });
  };
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
  const preparedBuild = await prepareExecutableBuild(
    root,
    options.buildHash,
    validated.setup === undefined
      ? undefined
      : { drillId: StableIdSchema.parse(options.drill), setup: validated.setup },
  );
  const build = preparedBuild.build;
  const attachmentStager = new LocalAttachmentStager(root);
  try {
    if (validated.callbackReceivers !== undefined) {
      const declaredReceivers = new Set(
        build.worldIr.tools.flatMap((tool) => tool.callbacks.map((callback) => callback.receiverId)),
      );
      const unknown = Object.keys(validated.callbackReceivers).filter(
        (receiverId) => !declaredReceivers.has(receiverId),
      );
      if (unknown.length > 0) {
        throw new FiredrillProjectError(
          "framework.INVALID_ARGUMENT",
          `callback receiver ${unknown[0]} is not declared by a selected Tool`,
          { details: { available: [...declaredReceivers].sort(compareStableStrings) } },
        );
      }
    }
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
        attachmentSink: attachmentStager.sink,
        ...(validated.callbackReceivers === undefined
          ? {}
          : { callbackReceivers: validated.callbackReceivers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.hooks?.attemptStarted === undefined
          ? {}
          : {
              attemptStarted: (context: DrillAttemptHookContext) =>
                options.hooks?.attemptStarted?.({ ...drillContext, ...context }),
            }),
        ...(options.hooks?.attemptFinished === undefined
          ? {}
          : {
              attemptFinished: (
                context: DrillAttemptHookContext & {
                  readonly execution: DrillExecution["trials"][number]["attempts"][number];
                },
              ) => options.hooks?.attemptFinished?.({ ...drillContext, ...context }),
            }),
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
            {
              result: attempt.result,
              evidence: attempt.evidence,
              tools: build.worldIr.tools,
              attachmentSources: attachmentStager.sources(attempt.result.identity.runId),
            },
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
      ...(build.setup === undefined ? {} : { setup: build.setup }),
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
  } finally {
    attachmentStager.dispose();
  }
}
