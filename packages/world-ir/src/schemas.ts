import {
  DrillDefinitionSchema,
  DrillSuiteDefinitionSchema,
  InlineScenarioDefinitionSchema,
  NodePackageNameSchema,
  PackageIdSchema,
  ScenarioDefinitionSchema,
  SeedSchema,
  SemverSchema,
  Sha256Schema,
  SourcePathSchema,
  StableIdSchema,
  TargetDescriptorSchema,
  ToolPackageManifestSchema,
  compareStableStrings,
  httpRoutesOverlap,
} from "@firedrill/contracts";
import type {
  AssertionDefinition,
  EventRef,
  InlineScenarioDefinition,
  OperationRef,
  ToolPackageManifest,
} from "@firedrill/contracts";
import { z } from "zod";
import { semanticHash } from "./hash.js";

export const WORLD_IR_SCHEMA_VERSION = 1 as const;
export const PACKAGE_LOCK_SCHEMA_VERSION = 1 as const;
export const BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;

function duplicateOrOrderIssues(context: z.RefinementCtx, path: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: `duplicate ${path} identity ${value}`,
      });
    }
    seen.add(value);
    if (index > 0 && compareStableStrings(values[index - 1] ?? "", value) >= 0) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: `${path} must be sorted by stable identity`,
      });
    }
  }
}

function operationKey(reference: OperationRef): string {
  return `${reference.packageId}\u0000${reference.operationId}`;
}

function eventKey(reference: EventRef): string {
  return `${reference.packageId}\u0000${reference.eventId}`;
}

interface ToolIndexes {
  readonly packages: ReadonlyMap<string, ToolPackageManifest>;
  readonly operations: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly state: ReadonlySet<string>;
  readonly faults: ReadonlySet<string>;
}

function indexTools(tools: readonly ToolPackageManifest[]): ToolIndexes {
  return {
    packages: new Map(tools.map((tool) => [tool.id, tool])),
    operations: new Set(
      tools.flatMap((tool) =>
        tool.operations.map((operation) => operationKey({ packageId: tool.id, operationId: operation.id })),
      ),
    ),
    events: new Set(
      tools.flatMap((tool) =>
        tool.events.map((event) => eventKey({ packageId: tool.id, eventId: event.id })),
      ),
    ),
    state: new Set(tools.flatMap((tool) => tool.state.map((state) => `${tool.id}\u0000${state.namespace}`))),
    faults: new Set(tools.flatMap((tool) => tool.faults.map((fault) => `${tool.id}\u0000${fault.id}`))),
  };
}

function validateAssertion(
  assertion: AssertionDefinition,
  indexes: ToolIndexes,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (assertion.kind === "state.value" || assertion.kind === "state.count") {
    if (!indexes.state.has(`${assertion.packageId}\u0000${assertion.namespace}`)) {
      context.addIssue({
        code: "custom",
        path,
        message: `assertion references unknown state namespace ${assertion.packageId}.${assertion.namespace}`,
      });
    }
    return;
  }
  if (assertion.kind === "event.count") {
    if (!indexes.events.has(eventKey(assertion.event))) {
      context.addIssue({
        code: "custom",
        path,
        message: `assertion references unknown event ${assertion.event.packageId}.${assertion.event.eventId}`,
      });
    }
    return;
  }

  const references =
    assertion.kind === "operation.order"
      ? assertion.sequence.flatMap((position) => position.anyOf)
      : [assertion.operation];
  for (const reference of references) {
    if (!indexes.operations.has(operationKey(reference))) {
      context.addIssue({
        code: "custom",
        path,
        message: `assertion references unknown operation ${reference.packageId}.${reference.operationId}`,
      });
    }
  }
}

function validateScenario(
  scenario: InlineScenarioDefinition,
  indexes: ToolIndexes,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  for (const [actorIndex, actor] of scenario.actors.entries()) {
    for (const [grantIndex, grant] of actor.grants.entries()) {
      if (!indexes.operations.has(operationKey(grant))) {
        context.addIssue({
          code: "custom",
          path: [...path, "actors", actorIndex, "grants", grantIndex],
          message: `actor grant references unknown operation ${grant.packageId}.${grant.operationId}`,
        });
      }
    }
  }
  for (const [stateIndex, state] of scenario.state.entries()) {
    if (!indexes.state.has(`${state.packageId}\u0000${state.namespace}`)) {
      context.addIssue({
        code: "custom",
        path: [...path, "state", stateIndex],
        message: `scenario references unknown state namespace ${state.packageId}.${state.namespace}`,
      });
    }
  }
  for (const [faultIndex, fault] of scenario.faults.entries()) {
    if (!indexes.faults.has(`${fault.packageId}\u0000${fault.faultId}`)) {
      context.addIssue({
        code: "custom",
        path: [...path, "faults", faultIndex],
        message: `scenario references unknown fault ${fault.packageId}.${fault.faultId}`,
      });
    }
  }
  for (const [eventIndex, event] of scenario.initialEvents.entries()) {
    if (!indexes.events.has(eventKey(event.event))) {
      context.addIssue({
        code: "custom",
        path: [...path, "initialEvents", eventIndex],
        message: `scenario references unknown event ${event.event.packageId}.${event.event.eventId}`,
      });
    }
  }
}

export const CanonicalWorldIrSchema = z
  .object({
    schemaVersion: z.literal(WORLD_IR_SCHEMA_VERSION),
    engineVersion: SemverSchema,
    world: z
      .object({
        id: StableIdSchema,
        title: z.string().min(1).max(200).optional(),
        seed: SeedSchema,
      })
      .strict(),
    tools: z.array(ToolPackageManifestSchema).min(1),
    baseline: InlineScenarioDefinitionSchema,
    scenarios: z.array(ScenarioDefinitionSchema).default([]),
    drills: z.array(DrillDefinitionSchema).default([]),
    suites: z.array(DrillSuiteDefinitionSchema).default([]),
    targets: z.array(TargetDescriptorSchema).default([]),
  })
  .strict()
  .superRefine((world, context) => {
    duplicateOrOrderIssues(
      context,
      "tools",
      world.tools.map((tool) => tool.id),
    );
    duplicateOrOrderIssues(
      context,
      "scenarios",
      world.scenarios.map((scenario) => scenario.id),
    );
    duplicateOrOrderIssues(
      context,
      "drills",
      world.drills.map((drill) => drill.id),
    );
    duplicateOrOrderIssues(
      context,
      "suites",
      world.suites.map((suite) => suite.id),
    );
    duplicateOrOrderIssues(
      context,
      "targets",
      world.targets.map((target) => target.id),
    );

    const indexes = indexTools(world.tools);
    const httpRoutes: Array<{
      readonly packageId: string;
      readonly routeId: string;
      readonly method: string;
      readonly path: string;
    }> = [];
    for (const [toolIndex, tool] of world.tools.entries()) {
      for (const [subscriptionIndex, subscription] of tool.subscriptions.entries()) {
        if (!indexes.events.has(eventKey(subscription.event))) {
          context.addIssue({
            code: "custom",
            path: ["tools", toolIndex, "subscriptions", subscriptionIndex, "event"],
            message: `subscription references unknown event ${subscription.event.packageId}.${subscription.event.eventId}`,
          });
        }
      }
      for (const [routeIndex, route] of tool.http.entries()) {
        const conflict = httpRoutes.find((candidate) => httpRoutesOverlap(route, candidate));
        if (conflict !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["tools", toolIndex, "http", routeIndex, "path"],
            message: `HTTP route overlaps ${conflict.packageId}.${conflict.routeId} at ${conflict.method} ${conflict.path}`,
          });
        }
        httpRoutes.push({
          packageId: tool.id,
          routeId: route.id,
          method: route.method,
          path: route.path,
        });
      }
    }

    validateScenario(world.baseline, indexes, ["baseline"], context);
    for (const [scenarioIndex, scenario] of world.scenarios.entries()) {
      validateScenario(scenario, indexes, ["scenarios", scenarioIndex], context);
    }

    const scenarios = new Map(world.scenarios.map((scenario) => [scenario.id, scenario]));
    const targets = new Set(world.targets.map((target) => target.id));
    for (const [drillIndex, drill] of world.drills.entries()) {
      if (drill.inlineScenario !== undefined) {
        validateScenario(drill.inlineScenario, indexes, ["drills", drillIndex, "inlineScenario"], context);
      }
      if (!targets.has(drill.targetId)) {
        context.addIssue({
          code: "custom",
          path: ["drills", drillIndex, "targetId"],
          message: `drill references unknown target ${drill.targetId}`,
        });
      }
      const scenario =
        drill.inlineScenario ??
        (drill.scenarioId === undefined ? undefined : scenarios.get(drill.scenarioId));
      if (drill.scenarioId !== undefined && scenario === undefined) {
        context.addIssue({
          code: "custom",
          path: ["drills", drillIndex, "scenarioId"],
          message: `drill references unknown scenario ${drill.scenarioId}`,
        });
      } else if (scenario !== undefined) {
        const actors = new Set(scenario.actors.map((actor) => actor.id));
        for (const [interactionIndex, interaction] of drill.timeline.interactions.entries()) {
          if (actors.has(interaction.actorId)) continue;
          context.addIssue({
            code: "custom",
            path: ["drills", drillIndex, "timeline", "interactions", interactionIndex, "actorId"],
            message: `drill interaction references actor ${interaction.actorId} outside its resolved scenario`,
          });
        }
        for (const [workloadIndex, workload] of drill.timeline.workloads.entries()) {
          for (const [actorIndex, actorId] of workload.actorIds.entries()) {
            if (actors.has(actorId)) continue;
            context.addIssue({
              code: "custom",
              path: ["drills", drillIndex, "timeline", "workloads", workloadIndex, "actorIds", actorIndex],
              message: `drill workload references actor ${actorId} outside its resolved scenario`,
            });
          }
        }
      }
      for (const [assertionIndex, assertion] of drill.timeline.invariants.entries()) {
        validateAssertion(
          assertion,
          indexes,
          ["drills", drillIndex, "timeline", "invariants", assertionIndex],
          context,
        );
      }
      for (const [assertionIndex, assertion] of drill.assertions.entries()) {
        validateAssertion(assertion, indexes, ["drills", drillIndex, "assertions", assertionIndex], context);
      }
    }

    const drills = new Map(world.drills.map((drill) => [drill.id, drill]));
    for (const [suiteIndex, suite] of world.suites.entries()) {
      for (const [drillIndex, drillId] of suite.drills.entries()) {
        if (drills.has(drillId)) continue;
        context.addIssue({
          code: "custom",
          path: ["suites", suiteIndex, "drills", drillIndex],
          message: `suite references unknown drill ${drillId}`,
        });
      }
      const selected = new Set(suite.drills);
      for (const drill of world.drills) {
        if (drill.tags.some((tag) => suite.tags.includes(tag))) selected.add(drill.id);
      }
      if (
        selected.size === 0 &&
        (suite.drills.length > 0 || suite.tags.length > 0 || world.drills.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["suites", suiteIndex],
          message: `suite ${suite.id} does not select any drills`,
        });
      }
    }
  });

export const ToolArtifactLockSchema = z
  .object({
    packageId: PackageIdSchema,
    version: SemverSchema,
    manifestHash: Sha256Schema,
    artifactHash: Sha256Schema,
    artifactPath: SourcePathSchema,
    exportName: z
      .string()
      .regex(/^(?:default|[$A-Z_a-z][$\w]*)$/)
      .default("default"),
    moduleFormat: z.literal("esm"),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("repository") }).strict(),
      z
        .object({
          kind: z.literal("npm"),
          packageName: NodePackageNameSchema,
          packageVersion: SemverSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export const PackageLockSchema = z
  .object({
    schemaVersion: z.literal(PACKAGE_LOCK_SCHEMA_VERSION),
    engineVersion: SemverSchema,
    packages: z.array(ToolArtifactLockSchema).min(1),
  })
  .strict()
  .superRefine((lock, context) => {
    duplicateOrOrderIssues(
      context,
      "packages",
      lock.packages.map((package_) => package_.packageId),
    );
  });

export const BuildIdentitySchema = z
  .object({
    schemaVersion: z.literal(BUILD_MANIFEST_SCHEMA_VERSION),
    worldIrSchemaVersion: z.literal(WORLD_IR_SCHEMA_VERSION),
    packageLockSchemaVersion: z.literal(PACKAGE_LOCK_SCHEMA_VERSION),
    compilerVersion: SemverSchema,
    engineVersion: SemverSchema,
    irHash: Sha256Schema,
    packageLockHash: Sha256Schema,
    sourceDigest: Sha256Schema,
  })
  .strict();

export const BuildProvenanceEntrySchema = z
  .object({
    kind: z.enum(["world", "tool", "scenario", "drill", "suite", "target"]),
    id: StableIdSchema,
    contentHash: Sha256Schema,
  })
  .strict();

export const BuildManifestSchema = z
  .object({
    ...BuildIdentitySchema.shape,
    buildHash: Sha256Schema,
    worldId: StableIdSchema,
    artifacts: z
      .object({
        worldIr: SourcePathSchema,
        packageLock: SourcePathSchema,
      })
      .strict(),
    provenance: z.array(BuildProvenanceEntrySchema),
    diagnostics: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expected = semanticHash(
      BuildIdentitySchema.parse({
        schemaVersion: manifest.schemaVersion,
        worldIrSchemaVersion: manifest.worldIrSchemaVersion,
        packageLockSchemaVersion: manifest.packageLockSchemaVersion,
        compilerVersion: manifest.compilerVersion,
        engineVersion: manifest.engineVersion,
        irHash: manifest.irHash,
        packageLockHash: manifest.packageLockHash,
        sourceDigest: manifest.sourceDigest,
      }),
    );
    if (manifest.buildHash !== expected) {
      context.addIssue({
        code: "custom",
        path: ["buildHash"],
        message: `build hash does not match identity; expected ${expected}`,
      });
    }
    duplicateOrOrderIssues(
      context,
      "provenance",
      manifest.provenance.map((entry) => `${entry.kind}\u0000${entry.id}`),
    );
  });

export const WorldIrSchemas = {
  buildManifest: BuildManifestSchema,
  canonicalWorldIr: CanonicalWorldIrSchema,
  packageLock: PackageLockSchema,
} as const;

export type CanonicalWorldIr = z.infer<typeof CanonicalWorldIrSchema>;
export type ToolArtifactLock = z.infer<typeof ToolArtifactLockSchema>;
export type PackageLock = z.infer<typeof PackageLockSchema>;
export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;
export type BuildProvenanceEntry = z.infer<typeof BuildProvenanceEntrySchema>;
export type BuildManifest = z.infer<typeof BuildManifestSchema>;
