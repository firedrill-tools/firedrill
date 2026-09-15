import { z } from "zod";
import { SourcePathSchema } from "./diagnostics.js";
import {
  NodePackageNameSchema,
  PackageIdSchema,
  Sha256Schema,
  StableIdSchema,
  VirtualTimeSchema,
} from "./identifiers.js";
import {
  ActorDefinitionSchema,
  FaultActivationSchema,
  InitialEventSchema,
  StateSetupSchema,
} from "./scenario.js";
import { BindingEnvironmentProjectionSchema } from "./target.js";
import { ToolOverridesSchema } from "./tool-overrides.js";

const ToolExportNameSchema = z
  .string()
  .regex(/^(?:default|[$A-Z_a-z][$\w]*)$/)
  .default("default");

/** A serializable behavior replacement for one already-declared Tool contract. */
export const ToolBehaviorOverrideSchema = z
  .object({
    packageId: PackageIdSchema,
    module: SourcePathSchema,
    exportName: ToolExportNameSchema,
  })
  .strict();

/**
 * Additive scenario setup applied after the drill's repository-owned scenario.
 * State actions remain ordered; actors with the same id replace their base actor.
 */
export const RunScenarioOverlaySchema = z
  .object({
    virtualTimeUs: VirtualTimeSchema.optional(),
    actors: z.array(ActorDefinitionSchema).default([]),
    state: z.array(StateSetupSchema).default([]),
    faults: z.array(FaultActivationSchema).default([]),
    initialEvents: z.array(InitialEventSchema).default([]),
    toolOverrides: ToolOverridesSchema.optional(),
  })
  .strict()
  .superRefine((overlay, context) => {
    const actorIds = overlay.actors.map((actor) => actor.id);
    if (new Set(actorIds).size !== actorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["actors"],
        message: "actors must not contain duplicate ids",
      });
    }
    const faults = overlay.faults.map((fault) => `${fault.packageId}\u0000${fault.faultId}`);
    if (new Set(faults).size !== faults.length) {
      context.addIssue({ code: "custom", path: ["faults"], message: "faults must not contain duplicates" });
    }
  });

const RunToolSelectionSchema = z
  .object({
    packages: z.array(NodePackageNameSchema).default([]),
    behaviorOverrides: z.array(ToolBehaviorOverrideSchema).default([]),
  })
  .strict()
  .superRefine((tools, context) => {
    for (const [index, packageName] of tools.packages.entries()) {
      if (tools.packages.indexOf(packageName) !== index) {
        context.addIssue({
          code: "custom",
          path: ["packages", index],
          message: `duplicate Tool package ${packageName}`,
        });
      }
    }
    for (const [index, override] of tools.behaviorOverrides.entries()) {
      if (
        tools.behaviorOverrides.findIndex((candidate) => candidate.packageId === override.packageId) !== index
      ) {
        context.addIssue({
          code: "custom",
          path: ["behaviorOverrides", index, "packageId"],
          message: `duplicate Tool behavior override ${override.packageId}`,
        });
      }
    }
  });

const RunBindingSetupSchema = z
  .object({
    environment: BindingEnvironmentProjectionSchema.default({}),
  })
  .strict();

/**
 * Test-local setup accepted by the high-level runner. It contains data and
 * traceable Tool/configuration choices only—never executable callbacks.
 */
export const RunWorldSetupSchema = z
  .object({
    scenario: RunScenarioOverlaySchema.optional(),
    tools: RunToolSelectionSchema.default({ packages: [], behaviorOverrides: [] }),
    bindings: RunBindingSetupSchema.default({ environment: {} }),
  })
  .strict()
  .superRefine((setup, context) => {
    const scenario = setup.scenario;
    const scenarioChanges =
      scenario !== undefined &&
      (scenario.virtualTimeUs !== undefined ||
        scenario.actors.length > 0 ||
        scenario.state.length > 0 ||
        scenario.faults.length > 0 ||
        scenario.initialEvents.length > 0 ||
        (scenario.toolOverrides?.length ?? 0) > 0);
    if (
      !scenarioChanges &&
      setup.tools.packages.length === 0 &&
      setup.tools.behaviorOverrides.length === 0 &&
      Object.keys(setup.bindings.environment).length === 0
    ) {
      context.addIssue({ code: "custom", message: "run setup must contain at least one override" });
    }
  });

/** Canonical setup record copied into a derived build and each run report. */
export const RunSetupRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    drillId: StableIdSchema,
    setup: RunWorldSetupSchema,
    setupHash: Sha256Schema,
  })
  .strict();

export type ToolBehaviorOverride = z.infer<typeof ToolBehaviorOverrideSchema>;
export type RunScenarioOverlay = z.infer<typeof RunScenarioOverlaySchema>;
export type RunWorldSetup = z.infer<typeof RunWorldSetupSchema>;
export type RunWorldSetupInput = z.input<typeof RunWorldSetupSchema>;
export type RunSetupRecord = z.infer<typeof RunSetupRecordSchema>;
