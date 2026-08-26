import {
  DrillDefinitionSchema,
  DrillSuiteDefinitionSchema,
  InlineScenarioDefinitionSchema,
  ScenarioDefinitionSchema,
  ToolPackageManifestSchema,
  compareStableStrings,
} from "@firedrill/contracts";
import type {
  ActorDefinitionSchema,
  DrillDefinition,
  DrillSuiteDefinition,
  InlineScenarioDefinition,
  ScenarioDefinition,
  ToolPackageManifest,
} from "@firedrill/contracts";
import type { z } from "zod";
import type { DrillSource, ScenarioSource, SuiteSource, WorldSource } from "./source-schemas.js";

type ActorDefinition = z.infer<typeof ActorDefinitionSchema>;

function operationReferenceKey(reference: { packageId: string; operationId: string }): string {
  return `${reference.packageId}\u0000${reference.operationId}`;
}

function normalizeActor(actor: ActorDefinition): ActorDefinition {
  return {
    ...actor,
    grants: [...actor.grants].sort((left, right) =>
      compareStableStrings(operationReferenceKey(left), operationReferenceKey(right)),
    ),
  };
}

function normalizeScenarioBody(body: InlineScenarioDefinition): InlineScenarioDefinition {
  const faults = new Map(body.faults.map((fault) => [`${fault.packageId}\u0000${fault.faultId}`, fault]));
  return InlineScenarioDefinitionSchema.parse({
    ...body,
    actors: body.actors.map(normalizeActor).sort((left, right) => compareStableStrings(left.id, right.id)),
    faults: [...faults.values()].sort((left, right) => {
      const packageOrder = compareStableStrings(left.packageId, right.packageId);
      return packageOrder === 0 ? compareStableStrings(left.faultId, right.faultId) : packageOrder;
    }),
  });
}

export function normalizeManifest(input: ToolPackageManifest): ToolPackageManifest {
  return ToolPackageManifestSchema.parse({
    ...input,
    capabilities: [...input.capabilities].sort(),
    state: [...input.state].sort((left, right) => compareStableStrings(left.namespace, right.namespace)),
    operations: input.operations
      .map((operation) => ({ ...operation, declaredErrors: [...operation.declaredErrors].sort() }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
    events: [...input.events].sort((left, right) => compareStableStrings(left.id, right.id)),
    faults: input.faults
      .map((fault) => ({ ...fault, appliesTo: [...fault.appliesTo].sort() }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
    subscriptions: [...input.subscriptions].sort((left, right) => compareStableStrings(left.id, right.id)),
    http: input.http
      .map((route) => ({
        ...route,
        auth:
          route.auth.kind === "header" ? { ...route.auth, name: route.auth.name.toLowerCase() } : route.auth,
        response: {
          ...route.response,
          errors: [...route.response.errors].sort((left, right) =>
            compareStableStrings(left.code, right.code),
          ),
        },
      }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
    callbacks: input.callbacks
      .map((callback) => ({
        ...callback,
        idempotencyHeader: callback.idempotencyHeader.toLowerCase(),
        signature:
          callback.signature.kind === "hmac-sha256"
            ? { ...callback.signature, header: callback.signature.header.toLowerCase() }
            : callback.signature,
      }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
  });
}

export function baselineFromWorld(world: WorldSource): InlineScenarioDefinition {
  return normalizeScenarioBody({
    virtualTimeUs: world.virtualTimeUs,
    actors: world.actors,
    state: world.state,
    faults: world.faults,
    initialEvents: world.initialEvents,
  });
}

export function resolveScenario(
  baseline: InlineScenarioDefinition,
  overlay: ScenarioSource,
): ScenarioDefinition {
  const actors = new Map(baseline.actors.map((actor) => [actor.id, actor]));
  for (const actor of overlay.actors) actors.set(actor.id, actor);
  const normalized = normalizeScenarioBody({
    virtualTimeUs: overlay.virtualTimeUs ?? baseline.virtualTimeUs,
    actors: [...actors.values()],
    state: [...baseline.state, ...overlay.state],
    faults: [...baseline.faults, ...overlay.faults],
    initialEvents: [...baseline.initialEvents, ...overlay.initialEvents],
  });
  return ScenarioDefinitionSchema.parse({
    schemaVersion: 1,
    id: overlay.id,
    ...(overlay.title === undefined ? {} : { title: overlay.title }),
    ...normalized,
  });
}

export function normalizeDrill(drill: DrillSource): DrillDefinition {
  if (drill.timeline === undefined && (drill.actorId === undefined || drill.task === undefined)) {
    throw new TypeError("a validated simple drill requires both actorId and task");
  }
  const timeline =
    drill.timeline ??
    ({
      horizonUs: drill.settle?.maxVirtualAdvanceUs ?? 0,
      maxToolCalls: drill.settle?.maxToolCalls ?? 1_000,
      maxEvents: drill.settle?.maxEvents ?? 10_000,
      stopOnInvariantFailure: true,
      interactions: [
        {
          id: "task",
          afterStartUs: 0,
          actorId: drill.actorId,
          task: drill.task,
        },
      ],
      invariants: [],
    } as const);
  return DrillDefinitionSchema.parse({
    schemaVersion: 1,
    id: drill.id,
    ...(drill.title === undefined ? {} : { title: drill.title }),
    tags: [...drill.tags].sort(),
    targetId: drill.targetId,
    ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
    ...(drill.inlineScenario === undefined ? {} : { inlineScenario: drill.inlineScenario }),
    timeline,
    trials: drill.trials,
    assertions: drill.assertions,
  });
}

export function normalizeSuite(suite: SuiteSource): DrillSuiteDefinition {
  return DrillSuiteDefinitionSchema.parse({
    schemaVersion: 1,
    id: suite.id,
    ...(suite.title === undefined ? {} : { title: suite.title }),
    drills: [...suite.drills].sort(),
    tags: [...suite.tags].sort(),
    ...(suite.trials === undefined ? {} : { trials: suite.trials }),
    concurrency: suite.concurrency,
    retries: suite.retries,
  });
}
