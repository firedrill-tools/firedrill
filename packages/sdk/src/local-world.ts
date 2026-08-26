import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ActorId,
  CorrelationId,
  Diagnostic,
  EvidenceEntry,
  EventId,
  JsonObject,
  OperationId,
  PackageId,
  Seed,
  Sha256,
  StableId,
  WorldInstanceId,
} from "@firedrill/contracts";
import {
  CorrelationIdSchema,
  JsonObjectSchema,
  OperationIdSchema,
  PackageIdSchema,
  SeedSchema,
  StableIdSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
  compareStableStrings,
} from "@firedrill/contracts";
import { createDrillWorld, DrillSetupError } from "@firedrill/drills";
import type { MaterializedDrillScenario } from "@firedrill/drills";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import type { ClockAdvanceResult, KernelInvocationResult } from "@firedrill/world-kernel";
import type {
  ActiveFault,
  CallbackDelivery,
  PackageResetSummary,
  ScheduledEvent,
  StateScanOptions,
  StoredStateRecord,
  WorldMetadata,
} from "@firedrill/world-store";
import type { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { prepareExecutableBuild } from "./project-build.js";
import { FiredrillProjectError } from "./project-error.js";

export interface CreateLocalWorldOptions {
  /** Consumer repository containing firedrill.json. Defaults to process.cwd(). */
  readonly root?: string;
  /** Repository drill whose scenario supplies initial state, actors, faults, events, and clock. */
  readonly drill: string;
  /** Override the repository seed for this world. */
  readonly seed?: string;
  /** Load an existing immutable build instead of compiling current source. */
  readonly buildHash?: string;
  /** New directory for retained SQLite artifacts. Defaults beneath <root>/.firedrill/worlds. */
  readonly directory?: string;
}

export interface LocalWorldActor {
  readonly actorId: ActorId;
  readonly attributes: Readonly<JsonObject>;
  readonly grants: readonly { readonly packageId: PackageId; readonly operationId: OperationId }[];
}

export interface LocalWorldTool {
  readonly packageId: PackageId;
  readonly version: string;
  readonly operations: readonly OperationId[];
  readonly stateNamespaces: readonly StableId[];
  readonly events: readonly EventId[];
  readonly faults: readonly StableId[];
}

export interface LocalWorldDescription {
  readonly schemaVersion: 1;
  readonly drillId: StableId;
  readonly scenarioId?: StableId;
  readonly buildHash: Sha256;
  readonly packageLockHash: Sha256;
  readonly actors: readonly LocalWorldActor[];
  readonly tools: readonly LocalWorldTool[];
}

export interface LocalWorldCall {
  readonly actorId: string;
  readonly packageId: string;
  readonly operationId: string;
  readonly arguments?: JsonObject;
  readonly idempotencyKey?: string;
}

export interface LocalWorldStateQuery extends StateScanOptions {
  readonly packageId: string;
  readonly namespace: string;
}

export interface LocalWorldEvidenceQuery {
  readonly fromSequence?: number;
  readonly limit?: number;
}

export interface LocalWorldAdvanceOptions {
  readonly maxEvents?: number;
}

export type LocalWorldResetOptions =
  | { readonly packages?: undefined }
  | { readonly packages: readonly string[] };

export type LocalWorldResetResult =
  | {
      readonly scope: "world";
      readonly metadata: WorldMetadata;
    }
  | ({
      readonly scope: "packages";
      readonly metadata: WorldMetadata;
    } & PackageResetSummary);

export interface LocalWorld {
  readonly repositoryRoot: string;
  readonly directoryPath: string;
  readonly worldFilePath: string;
  readonly baselineFilePath: string;
  readonly diagnostics: readonly Diagnostic[];
  describe(): LocalWorldDescription;
  metadata(): WorldMetadata;
  call(input: LocalWorldCall): KernelInvocationResult;
  state(query: LocalWorldStateQuery): readonly StoredStateRecord[];
  evidence(query?: LocalWorldEvidenceQuery): readonly EvidenceEntry[];
  scheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[];
  callbacks(status?: CallbackDelivery["status"]): readonly CallbackDelivery[];
  faults(packageId?: string): readonly ActiveFault[];
  advanceTime(toUs: number, options?: LocalWorldAdvanceOptions): ClockAdvanceResult;
  reset(options?: LocalWorldResetOptions): LocalWorldResetResult;
  close(): void;
}

interface LocalWorldControllerOptions {
  readonly repositoryRoot: string;
  readonly directoryPath: string;
  readonly worldFilePath: string;
  readonly baselineFilePath: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly build: LoadedWorldBuild;
  readonly materialized: MaterializedDrillScenario;
  readonly store: SqliteWorldStore;
  readonly kernel: WorldKernel;
  readonly clients: ReadonlyMap<ActorId, BoundWorldClient>;
}

function executionSuffix(): string {
  return randomUUID().replaceAll("-", "");
}

function positiveInteger(value: number | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      `${name} must be an integer from 1 through ${maximum}`,
    );
  }
  return value;
}

class LocalWorldController implements LocalWorld {
  readonly repositoryRoot: string;
  readonly directoryPath: string;
  readonly worldFilePath: string;
  readonly baselineFilePath: string;
  readonly diagnostics: readonly Diagnostic[];
  private readonly build: LoadedWorldBuild;
  private readonly materialized: MaterializedDrillScenario;
  private readonly store: SqliteWorldStore;
  private kernel: WorldKernel;
  private clients: ReadonlyMap<ActorId, BoundWorldClient>;
  private generation = 0;
  private controlSequence = 0;
  private closed = false;

  constructor(options: LocalWorldControllerOptions) {
    this.repositoryRoot = options.repositoryRoot;
    this.directoryPath = options.directoryPath;
    this.worldFilePath = options.worldFilePath;
    this.baselineFilePath = options.baselineFilePath;
    this.diagnostics = options.diagnostics;
    this.build = options.build;
    this.materialized = options.materialized;
    this.store = options.store;
    this.kernel = options.kernel;
    this.clients = options.clients;
  }

  describe(): LocalWorldDescription {
    this.assertOpen();
    return {
      schemaVersion: 1,
      drillId: this.materialized.drill.id,
      ...(this.materialized.scenarioId === undefined ? {} : { scenarioId: this.materialized.scenarioId }),
      buildHash: this.build.manifest.buildHash,
      packageLockHash: this.build.manifest.packageLockHash,
      actors: this.materialized.actors.map((actor) => ({
        actorId: actor.actorId,
        attributes: actor.attributes,
        grants: actor.grants,
      })),
      tools: this.build.tools
        .map((tool) => ({
          packageId: tool.manifest.id,
          version: tool.manifest.version,
          operations: tool.manifest.operations.map((operation) => operation.id).sort(compareStableStrings),
          stateNamespaces: tool.manifest.state.map((state) => state.namespace).sort(compareStableStrings),
          events: tool.manifest.events.map((event) => event.id).sort(compareStableStrings),
          faults: tool.manifest.faults.map((fault) => fault.id).sort(compareStableStrings),
        }))
        .sort((left, right) => compareStableStrings(left.packageId, right.packageId)),
    };
  }

  metadata(): WorldMetadata {
    this.assertOpen();
    return this.store.metadata();
  }

  call(input: LocalWorldCall): KernelInvocationResult {
    this.assertOpen();
    const actorId = StableIdSchema.safeParse(input.actorId);
    if (!actorId.success) {
      throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "actorId must be a valid Firedrill id");
    }
    const client = this.clients.get(actorId.data);
    if (client === undefined) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `actor ${actorId.data} is not present in this drill scenario`,
        { details: { available: this.materialized.actors.map((actor) => actor.actorId) } },
      );
    }
    const packageId = PackageIdSchema.safeParse(input.packageId);
    const operationId = OperationIdSchema.safeParse(input.operationId);
    const arguments_ = JsonObjectSchema.safeParse(input.arguments ?? {});
    const idempotencyKeyValid =
      input.idempotencyKey === undefined ||
      (typeof input.idempotencyKey === "string" &&
        input.idempotencyKey.length >= 1 &&
        input.idempotencyKey.length <= 255);
    if (!packageId.success || !operationId.success || !arguments_.success || !idempotencyKeyValid) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "packageId, operationId, arguments, and idempotencyKey must form a valid Tool call",
      );
    }
    return client.invoke(
      { packageId: packageId.data, operationId: operationId.data },
      arguments_.data,
      input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey },
    );
  }

  state(query: LocalWorldStateQuery): readonly StoredStateRecord[] {
    this.assertOpen();
    const packageId = PackageIdSchema.safeParse(query.packageId);
    const namespace = StableIdSchema.safeParse(query.namespace);
    if (!packageId.success || !namespace.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "state query packageId and namespace must be valid Firedrill ids",
      );
    }
    positiveInteger(query.limit, "state query limit", 10_000);
    return this.store.scanState(packageId.data, namespace.data, {
      ...(query.afterRowId === undefined ? {} : { afterRowId: query.afterRowId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  evidence(query: LocalWorldEvidenceQuery = {}): readonly EvidenceEntry[] {
    this.assertOpen();
    positiveInteger(query.fromSequence, "evidence fromSequence", Number.MAX_SAFE_INTEGER);
    positiveInteger(query.limit, "evidence limit", 10_000);
    return this.store.readEvidence(query.fromSequence, query.limit);
  }

  scheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[] {
    this.assertOpen();
    return this.store.listScheduledEvents(status);
  }

  callbacks(status?: CallbackDelivery["status"]): readonly CallbackDelivery[] {
    this.assertOpen();
    return this.store.listCallbackDeliveries(status);
  }

  faults(packageId?: string): readonly ActiveFault[] {
    this.assertOpen();
    if (packageId === undefined) return this.store.listActiveFaults();
    const parsed = PackageIdSchema.safeParse(packageId);
    if (!parsed.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "fault query packageId must be a valid Tool package id",
      );
    }
    return this.store.listActiveFaults(parsed.data);
  }

  advanceTime(toUs: number, options: LocalWorldAdvanceOptions = {}): ClockAdvanceResult {
    this.assertOpen();
    const parsedTime = VirtualTimeSchema.safeParse(toUs);
    const maxEvents = positiveInteger(options.maxEvents, "maxEvents", 100_000);
    if (!parsedTime.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "toUs must be a non-negative safe integer",
      );
    }
    if (parsedTime.data < this.store.metadata().virtualTimeUs) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "virtual clock cannot move backward; reset the world to restore an earlier time",
      );
    }
    return this.kernel.advanceTime(parsedTime.data, {
      correlationId: this.nextCorrelation("clock"),
      ...(maxEvents === undefined ? {} : { maxEvents }),
    });
  }

  reset(options: LocalWorldResetOptions = {}): LocalWorldResetResult {
    this.assertOpen();
    const requested = options.packages;
    let packages: readonly PackageId[] | undefined;
    if (requested !== undefined) {
      const parsed = requested.map((packageId) => PackageIdSchema.safeParse(packageId));
      if (parsed.some((item) => !item.success)) {
        throw new FiredrillProjectError(
          "framework.INVALID_ARGUMENT",
          "reset packages must contain valid Tool package ids",
        );
      }
      packages = [...new Set(parsed.map((item) => item.data as PackageId))].sort(compareStableStrings);
      if (packages.length === 0) {
        throw new FiredrillProjectError(
          "framework.INVALID_ARGUMENT",
          "scoped reset requires at least one Tool package",
        );
      }
      const available = new Set(this.build.tools.map((tool) => tool.manifest.id));
      const unknown = packages.filter((packageId) => !available.has(packageId));
      if (unknown.length > 0) {
        throw new FiredrillProjectError(
          "framework.TOOL_NOT_FOUND",
          `no Tool named ${unknown[0]} exists in this world`,
          { details: { available: [...available].sort(compareStableStrings) } },
        );
      }
    }

    this.revokeClients();
    try {
      if (packages === undefined) {
        this.store.resetFromSnapshot(this.baselineFilePath, this.nextCorrelation("reset"));
        this.generation += 1;
        this.kernel = this.createKernel();
        this.clients = this.createClients();
        return { scope: "world", metadata: this.store.metadata() };
      }
      const summary = this.store.resetPackagesFromSnapshot(
        this.baselineFilePath,
        packages,
        this.nextCorrelation("reset"),
      );
      this.generation += 1;
      this.clients = this.createClients();
      return { scope: "packages", metadata: this.store.metadata(), ...summary };
    } catch (error) {
      this.clients = this.createClients();
      if (error instanceof FiredrillProjectError) throw error;
      throw new FiredrillProjectError(
        "framework.WORLD_RESET_FAILED",
        error instanceof Error ? error.message : "world reset failed",
        {
          details: {
            scope: packages === undefined ? "world" : "packages",
            packages: [...(packages ?? [])],
          },
        },
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.revokeClients();
    this.store.close();
    this.closed = true;
  }

  private createKernel(): WorldKernel {
    return new WorldKernel({
      store: this.store,
      packageLockHash: this.build.manifest.packageLockHash,
      tools: this.build.tools,
      budgets: { maxToolCalls: this.materialized.drill.timeline.maxToolCalls },
    });
  }

  private createClients(): ReadonlyMap<ActorId, BoundWorldClient> {
    const worldId = this.store.metadata().worldInstanceId;
    return new Map(
      this.materialized.actors.map((actor) => [
        actor.actorId,
        new BoundWorldClient({
          kernel: this.kernel,
          actorBindingId: actor.bindingId,
          namespace: `${worldId}:${actor.actorId}:generation-${this.generation}`,
        }),
      ]),
    );
  }

  private revokeClients(): void {
    for (const client of this.clients.values()) client.revoke();
  }

  private nextCorrelation(action: string): CorrelationId {
    this.controlSequence += 1;
    return CorrelationIdSchema.parse(`corr_local_${action}_${String(this.controlSequence).padStart(8, "0")}`);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new FiredrillProjectError("framework.WORLD_CLOSED", "the local world is closed");
    }
  }
}

/**
 * Creates one retained local world from repository source and a drill scenario.
 * The caller owns the agent; this control handle owns only the synthetic world.
 */
export async function createLocalWorld(options: CreateLocalWorldOptions): Promise<LocalWorld> {
  const root = resolve(options.root ?? process.cwd());
  const drillId = StableIdSchema.safeParse(options.drill);
  if (!drillId.success) {
    throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "drill must be a valid Firedrill id");
  }
  const seed = options.seed === undefined ? undefined : SeedSchema.safeParse(options.seed);
  if (seed !== undefined && !seed.success) {
    throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "seed must be an unsigned 64-bit integer");
  }
  const prepared = await prepareExecutableBuild(root, options.buildHash);
  const drill = prepared.build.worldIr.drills.find((candidate) => candidate.id === drillId.data);
  if (drill === undefined) {
    throw new FiredrillProjectError("framework.DRILL_NOT_FOUND", `no drill named ${drillId.data} exists`, {
      details: { available: prepared.build.worldIr.drills.map((candidate) => candidate.id) },
    });
  }

  const suffix = executionSuffix();
  const directoryPath = resolve(root, options.directory ?? join(".firedrill", "worlds", `world_${suffix}`));
  if (existsSync(directoryPath)) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      `local world directory already exists: ${directoryPath}`,
    );
  }
  mkdirSync(dirname(directoryPath), { recursive: true });
  mkdirSync(directoryPath);
  const worldFilePath = join(directoryPath, "world.sqlite");
  const baselineFilePath = join(directoryPath, "baseline.sqlite");
  const worldInstanceId: WorldInstanceId = WorldInstanceIdSchema.parse(`world_${suffix}`);

  try {
    const created = createDrillWorld({
      build: prepared.build,
      drillId: drillId.data,
      filePath: worldFilePath,
      worldInstanceId,
      correlationId: CorrelationIdSchema.parse(`corr_create_${suffix}`),
      ...(seed?.success ? { seed: seed.data as Seed } : {}),
      maxToolCalls: drill.timeline.maxToolCalls,
    });
    try {
      created.store.createSnapshot(baselineFilePath, CorrelationIdSchema.parse(`corr_baseline_${suffix}`));
      return new LocalWorldController({
        repositoryRoot: root,
        directoryPath,
        worldFilePath,
        baselineFilePath,
        diagnostics: prepared.diagnostics,
        build: prepared.build,
        materialized: created.materialized,
        store: created.store,
        kernel: created.kernel,
        clients: created.clients,
      });
    } catch (error) {
      created.store.close();
      throw error;
    }
  } catch (error) {
    rmSync(directoryPath, { recursive: true, force: true });
    if (error instanceof FiredrillProjectError) throw error;
    if (error instanceof DrillSetupError) {
      throw new FiredrillProjectError("framework.BUILD_INVALID", error.message);
    }
    throw error;
  }
}
