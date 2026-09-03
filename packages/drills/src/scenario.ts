import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  ActorBindingIdSchema,
  compareStableStrings,
  CorrelationIdSchema,
  SeedSchema,
  StableIdSchema,
  WorldInstanceIdSchema,
} from "@firedrill/contracts";
import type {
  ActorBindingId,
  ActorId,
  CorrelationId,
  DrillDefinition,
  InitialEvent,
  JsonObject,
  OperationRef,
  PackageId,
  Seed,
  StableId,
  VirtualTime,
  WorldInstanceId,
} from "@firedrill/contracts";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import type { WorldKernelUsage } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import type { InitialScheduledEvent, InitialStateRecord } from "@firedrill/world-store-sqlite";

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

export interface MaterializedDrillScenario {
  readonly schemaVersion: 1;
  readonly drill: DrillDefinition;
  readonly scenarioId?: StableId;
  readonly virtualTimeUs: VirtualTime;
  readonly actors: readonly MaterializedActor[];
  readonly state: readonly InitialStateRecord[];
  readonly activeFaults: readonly { readonly packageId: PackageId; readonly faultId: StableId }[];
  readonly initialEvents: readonly MaterializedInitialEvent[];
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

export interface CreatedDrillWorld {
  readonly materialized: MaterializedDrillScenario;
  readonly store: SqliteWorldStore;
  readonly kernel: WorldKernel;
  readonly clients: ReadonlyMap<ActorId, BoundWorldClient>;
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

export function materializeDrillScenario(
  build: LoadedWorldBuild,
  drillIdInput: StableId,
): MaterializedDrillScenario {
  const drillId = StableIdSchema.parse(drillIdInput);
  const drill = build.worldIr.drills.find((candidate) => candidate.id === drillId);
  if (drill === undefined) {
    throw new DrillSetupError("framework.DRILL_NOT_FOUND", `build has no drill ${drillId}`);
  }
  const scenario = scenarioForDrill(build, drill);
  const actors = scenario.actors.map((actor) => ({
    actorId: actor.id,
    bindingId: actorBindingId(actor.id),
    attributes: actor.attributes,
    grants: actor.grants,
  }));
  const bindings = new Map(actors.map((actor) => [actor.actorId, actor.bindingId]));
  for (const interaction of drill.timeline.interactions) {
    if (bindings.has(interaction.actorId)) continue;
    throw new DrillSetupError(
      "framework.ACTOR_NOT_FOUND",
      `drill ${drill.id} interaction ${interaction.id} references unavailable actor ${interaction.actorId}`,
    );
  }
  return {
    schemaVersion: 1,
    drill,
    ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
    virtualTimeUs: scenario.virtualTimeUs,
    actors,
    state: finalState(scenario.state),
    activeFaults: scenario.faults,
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

function removeCreatedDatabase(filePath: string): void {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}-wal`, { force: true });
  rmSync(`${filePath}-shm`, { force: true });
}

export function createDrillWorld(input: CreateDrillWorldOptions): CreatedDrillWorld {
  const materialized = materializeDrillScenario(input.build, input.drillId);
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
