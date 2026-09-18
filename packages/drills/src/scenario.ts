import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  ActorBindingIdSchema,
  compareStableStrings,
  mergeToolOverrides,
  CorrelationIdSchema,
  SeedSchema,
  StableIdSchema,
  WorldInstanceIdSchema,
} from "@firedrill-run/contracts";
import type {
  ActorBindingId,
  ActorId,
  CorrelationId,
  DrillDefinition,
  InitialEvent,
  InlineScenarioDefinition,
  JsonObject,
  OperationRef,
  PackageId,
  Seed,
  StableId,
  VirtualTime,
  WorldInstanceId,
  ResolvedToolOverride,
} from "@firedrill-run/contracts";
import type { LoadedWorldBuild } from "@firedrill-run/world-build";
import { BoundWorldClient, WorldKernel } from "@firedrill-run/world-kernel";
import type { WorldKernelUsage } from "@firedrill-run/world-kernel";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import type { InitialScheduledEvent, InitialStateRecord } from "@firedrill-run/world-store-sqlite";

export type DrillSetupErrorCode =
  | "framework.DRILL_NOT_FOUND"
  | "framework.SCENARIO_NOT_FOUND"
  | "framework.ACTOR_NOT_FOUND"
  | "framework.BINDING_PROJECTION_UNAVAILABLE"
  | "framework.TARGET_NOT_FOUND";

export class DrillSetupError extends Error {
  readonly code: DrillSetupErrorCode;

  constructor(code: DrillSetupErrorCode, message: string) {
    super(message);
    this.name = "DrillSetupError";
    this.code = code;
  }
}

export interface MaterializedActor {
  readonly actorId: ActorId;
  readonly bindingId: ActorBindingId;
  readonly attributes: JsonObject;
  readonly grants: readonly OperationRef[];
}

export interface MaterializedInitialEvent {
  readonly event: InitialEvent["event"];
  readonly payload: JsonObject;
  readonly atUs: VirtualTime;
  readonly actorBindingId: ActorBindingId;
}

export interface MaterializedWorldScenario {
  readonly schemaVersion: 1;
  readonly scenarioId?: StableId;
  readonly virtualTimeUs: VirtualTime;
  readonly actors: readonly MaterializedActor[];
  readonly state: readonly InitialStateRecord[];
  readonly activeFaults: readonly { readonly packageId: PackageId; readonly faultId: StableId }[];
  readonly initialEvents: readonly MaterializedInitialEvent[];
  readonly toolOverrides?: readonly ResolvedToolOverride[];
}

export interface MaterializedDrillScenario extends MaterializedWorldScenario {
  readonly drill: DrillDefinition;
}

export interface CreateDrillWorldOptions {
  readonly build: LoadedWorldBuild;
  readonly drillId: StableId;
  readonly filePath: string;
  readonly worldInstanceId: WorldInstanceId;
  readonly correlationId: CorrelationId;
  readonly seed?: Seed;
  readonly maxToolCalls?: number;
  readonly onToolCallBudgetExceeded?: (usage: WorldKernelUsage) => void;
}

export type CreateScenarioWorldOptions = Omit<CreateDrillWorldOptions, "drillId"> & {
  /** Omit to materialize the compiled world baseline. */
  readonly scenarioId?: StableId;
};

export interface CreatedScenarioWorld {
  readonly materialized: MaterializedWorldScenario;
  readonly store: SqliteWorldStore;
  readonly kernel: WorldKernel;
  readonly clients: ReadonlyMap<ActorId, BoundWorldClient>;
}

export interface CreatedDrillWorld extends CreatedScenarioWorld {
  readonly materialized: MaterializedDrillScenario;
}

function actorBindingId(actorId: ActorId): ActorBindingId {
  const digest = createHash("sha256").update("firedrill.actor-binding.v1\0").update(actorId).digest("hex");
  return ActorBindingIdSchema.parse(`actor_${digest}`);
}

function finalState(
  setup: readonly (
    | {
        readonly action: "upsert";
        readonly packageId: PackageId;
        readonly namespace: StableId;
        readonly rowId: string;
        readonly value: JsonObject;
      }
    | {
        readonly action: "delete";
        readonly packageId: PackageId;
        readonly namespace: StableId;
        readonly rowId: string;
      }
  )[],
): readonly InitialStateRecord[] {
  const records = new Map<string, InitialStateRecord>();
  for (const item of setup) {
    const key = `${item.packageId}\u0000${item.namespace}\u0000${item.rowId}`;
    if (item.action === "delete") records.delete(key);
    else {
      records.set(key, {
        packageId: item.packageId,
        namespace: item.namespace,
        rowId: item.rowId,
        value: item.value,
      });
    }
  }
  return [...records.values()].sort((left, right) => {
    const packageOrder = compareStableStrings(left.packageId, right.packageId);
    if (packageOrder !== 0) return packageOrder;
    const namespaceOrder = compareStableStrings(left.namespace, right.namespace);
    return namespaceOrder === 0 ? compareStableStrings(left.rowId, right.rowId) : namespaceOrder;
  });
}

function scenarioForDrill(build: LoadedWorldBuild, drill: DrillDefinition) {
  if (drill.inlineScenario !== undefined) return drill.inlineScenario;
  const scenario = build.worldIr.scenarios.find((candidate) => candidate.id === drill.scenarioId);
  if (scenario === undefined) {
    throw new DrillSetupError(
      "framework.SCENARIO_NOT_FOUND",
      `drill ${drill.id} references unavailable scenario ${String(drill.scenarioId)}`,
    );
  }
  return scenario;
}

function materializeScenarioBody(scenario: InlineScenarioDefinition): MaterializedWorldScenario {
  const actors = scenario.actors.map((actor) => ({
    actorId: actor.id,
    bindingId: actorBindingId(actor.id),
    attributes: actor.attributes,
    grants: actor.grants,
  }));
  const bindings = new Map(actors.map((actor) => [actor.actorId, actor.bindingId]));
  return {
    schemaVersion: 1,
    virtualTimeUs: scenario.virtualTimeUs,
    actors,
    state: finalState(scenario.state),
    activeFaults: scenario.faults,
    ...(scenario.toolOverrides === undefined ? {} : { toolOverrides: scenario.toolOverrides }),
    initialEvents: scenario.initialEvents.map((event) => {
      const bindingId = bindings.get(event.actorId);
      if (bindingId === undefined) {
        throw new DrillSetupError(
          "framework.ACTOR_NOT_FOUND",
          `initial event references unavailable actor ${event.actorId}`,
        );
      }
      return {
        event: event.event,
        payload: event.payload,
        atUs: event.atUs,
        actorBindingId: bindingId,
      };
    }),
  };
}

export function materializeWorldScenario(
  build: LoadedWorldBuild,
  scenarioIdInput?: StableId,
): MaterializedWorldScenario {
  if (scenarioIdInput === undefined) return materializeScenarioBody(build.worldIr.baseline);
  const scenarioId = StableIdSchema.parse(scenarioIdInput);
  const scenario = build.worldIr.scenarios.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined)
    throw new DrillSetupError("framework.SCENARIO_NOT_FOUND", `build has no scenario ${scenarioId}`);
  return { ...materializeScenarioBody(scenario), scenarioId };
}

export function materializeDrillScenario(
  build: LoadedWorldBuild,
  drillIdInput: StableId,
): MaterializedDrillScenario {
  const drillId = StableIdSchema.parse(drillIdInput);
  const drill = build.worldIr.drills.find((candidate) => candidate.id === drillId);
  if (drill === undefined)
    throw new DrillSetupError("framework.DRILL_NOT_FOUND", `build has no drill ${drillId}`);
  const materialized = materializeScenarioBody(scenarioForDrill(build, drill));
  const actors = new Set(materialized.actors.map((actor) => actor.actorId));
  for (const interaction of drill.timeline.interactions) {
    if (actors.has(interaction.actorId)) continue;
    throw new DrillSetupError(
      "framework.ACTOR_NOT_FOUND",
      `drill ${drill.id} interaction ${interaction.id} references unavailable actor ${interaction.actorId}`,
    );
  }
  return {
    ...materialized,
    drill,
    ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
    ...(materialized.toolOverrides === undefined && drill.toolOverrides === undefined
      ? {}
      : { toolOverrides: mergeToolOverrides(materialized.toolOverrides, drill.toolOverrides) }),
  };
}

function removeCreatedDatabase(filePath: string): void {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}-wal`, { force: true });
  rmSync(`${filePath}-shm`, { force: true });
}

export function createDrillWorld(input: CreateDrillWorldOptions): CreatedDrillWorld {
  return createMaterializedWorld(input, materializeDrillScenario(input.build, input.drillId));
}

/** Creates a baseline or named-scenario world without manufacturing a drill or target. */
export function createScenarioWorld(input: CreateScenarioWorldOptions): CreatedScenarioWorld {
  return createMaterializedWorld(input, materializeWorldScenario(input.build, input.scenarioId));
}

function createMaterializedWorld<Scenario extends MaterializedWorldScenario>(
  input: Omit<CreateDrillWorldOptions, "drillId">,
  materialized: Scenario,
): Omit<CreatedScenarioWorld, "materialized"> & { readonly materialized: Scenario } {
  const filePath = input.filePath;
  const store = SqliteWorldStore.create({
    filePath,
    worldInstanceId: WorldInstanceIdSchema.parse(input.worldInstanceId),
    buildHash: input.build.manifest.buildHash,
    packageLockHash: input.build.manifest.packageLockHash,
    seed: SeedSchema.parse(input.seed ?? input.build.worldIr.world.seed),
    virtualTimeUs: materialized.virtualTimeUs,
    correlationId: CorrelationIdSchema.parse(input.correlationId),
    actors: materialized.actors.map((actor) => ({
      bindingId: actor.bindingId,
      actorId: actor.actorId,
      attributes: actor.attributes,
      grants: actor.grants,
    })),
    state: materialized.state,
    activeFaults: materialized.activeFaults,
    scheduledEvents: materialized.initialEvents.map(
      (event): InitialScheduledEvent => ({
        event: event.event,
        payload: event.payload,
        dueUs: event.atUs,
        actorBindingId: event.actorBindingId,
      }),
    ),
  });
  try {
    const kernel = new WorldKernel({
      store,
      packageLockHash: input.build.manifest.packageLockHash,
      tools: input.build.tools,
      ...(materialized.toolOverrides === undefined ? {} : { toolOverrides: materialized.toolOverrides }),
      ...(input.maxToolCalls === undefined ? {} : { budgets: { maxToolCalls: input.maxToolCalls } }),
      ...(input.onToolCallBudgetExceeded === undefined
        ? {}
        : { onToolCallBudgetExceeded: input.onToolCallBudgetExceeded }),
    });
    const clients = new Map(
      materialized.actors.map((actor) => [
        actor.actorId,
        new BoundWorldClient({
          kernel,
          actorBindingId: actor.bindingId,
          namespace: `${input.worldInstanceId}:${actor.actorId}`,
        }),
      ]),
    );
    return { materialized, store, kernel, clients };
  } catch (error) {
    store.close();
    removeCreatedDatabase(filePath);
    throw error;
  }
}
