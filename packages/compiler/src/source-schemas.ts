import {
  ActorIdSchema,
  AssertionDefinitionSchema,
  ActorDefinitionSchema,
  DrillTaskSchema,
  DrillTimelineSchema,
  FaultActivationSchema,
  InlineScenarioDefinitionSchema,
  InitialEventSchema,
  NodePackageNameSchema,
  SeedSchema,
  SourcePathSchema,
  StableIdSchema,
  StateSetupSchema,
  TargetDescriptorSchema,
  ToolPackageManifestSchema,
  VirtualTimeSchema,
  TrialPolicySchema,
} from "@firedrill/contracts";
import { z } from "zod";

export const ProjectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRoot: SourcePathSchema.default("firedrill"),
    world: SourcePathSchema.default("world.yaml"),
    toolPackages: z.array(NodePackageNameSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [index, packageName] of config.toolPackages.entries()) {
      if (config.toolPackages.indexOf(packageName) !== index) {
        context.addIssue({
          code: "custom",
          path: ["toolPackages", index],
          message: `duplicate Tool package ${packageName}`,
        });
      }
    }
  });

export const WorldSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    seed: SeedSchema.default("1"),
    virtualTimeUs: VirtualTimeSchema.default(0),
    actors: z.array(ActorDefinitionSchema).default([]),
    state: z.array(StateSetupSchema).default([]),
    faults: z.array(FaultActivationSchema).default([]),
    initialEvents: z.array(InitialEventSchema).default([]),
  })
  .strict();

export const ScenarioSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    virtualTimeUs: VirtualTimeSchema.optional(),
    actors: z.array(ActorDefinitionSchema).default([]),
    state: z.array(StateSetupSchema).default([]),
    faults: z.array(FaultActivationSchema).default([]),
    initialEvents: z.array(InitialEventSchema).default([]),
  })
  .strict();

export const ToolSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    module: SourcePathSchema,
    exportName: z
      .string()
      .regex(/^(?:default|[$A-Z_a-z][$\w]*)$/)
      .default("default"),
    manifest: ToolPackageManifestSchema,
  })
  .strict();

export const TargetSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    target: TargetDescriptorSchema,
  })
  .strict();

const DrillSourceShape = {
  schemaVersion: z.literal(1),
  id: StableIdSchema,
  title: z.string().min(1).max(200).optional(),
  tags: z.array(StableIdSchema).default([]),
  targetId: StableIdSchema,
  scenarioId: StableIdSchema.optional(),
  inlineScenario: InlineScenarioDefinitionSchema.optional(),
  trials: TrialPolicySchema.default({ count: 1, classification: "contract" }),
  assertions: z.array(AssertionDefinitionSchema).min(1),
};

/**
 * Authored drills keep the one-task path compact while allowing an explicit
 * timeline for longer workloads. The compiler normalizes both into one IR.
 */
export const DrillSourceSchema = z
  .object({
    ...DrillSourceShape,
    actorId: ActorIdSchema.optional(),
    task: DrillTaskSchema.optional(),
    settle: z
      .object({
        maxVirtualAdvanceUs: VirtualTimeSchema,
        maxToolCalls: z.number().int().positive().max(1_000_000).default(1_000),
        maxEvents: z.number().int().positive().max(1_000_000),
      })
      .strict()
      .optional(),
    timeline: DrillTimelineSchema.optional(),
  })
  .strict()
  .superRefine((drill, context) => {
    if ((drill.scenarioId === undefined) === (drill.inlineScenario === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["scenarioId"],
        message: "a drill requires exactly one of scenarioId or inlineScenario",
      });
    }
    const simple = drill.actorId !== undefined || drill.task !== undefined || drill.settle !== undefined;
    if (simple === (drill.timeline !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["timeline"],
        message: "use either actorId/task/settle or timeline, not both",
      });
    }
    if (simple && (drill.actorId === undefined || drill.task === undefined)) {
      context.addIssue({
        code: "custom",
        path: [drill.actorId === undefined ? "actorId" : "task"],
        message: "a simple drill requires both actorId and task",
      });
    }
  });

export const SuiteSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    drills: z.array(StableIdSchema).default([]),
    tags: z.array(StableIdSchema).default([]),
    trials: z.number().int().positive().max(10_000).optional(),
    concurrency: z.number().int().positive().max(64).default(1),
    retries: z.number().int().nonnegative().max(10).default(0),
  })
  .strict()
  .superRefine((suite, context) => {
    for (const key of ["drills", "tags"] as const) {
      const values = suite[key];
      for (const [index, value] of values.entries()) {
        if (values.indexOf(value) !== index) {
          context.addIssue({
            code: "custom",
            path: [key, index],
            message: `duplicate ${key === "drills" ? "drill" : "tag"} ${value}`,
          });
        }
      }
    }
  });

export const CompilerSourceSchemas = {
  drillSource: DrillSourceSchema,
  projectConfig: ProjectConfigSchema,
  scenarioSource: ScenarioSourceSchema,
  suiteSource: SuiteSourceSchema,
  targetSource: TargetSourceSchema,
  toolSource: ToolSourceSchema,
  worldSource: WorldSourceSchema,
} as const;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type WorldSource = z.infer<typeof WorldSourceSchema>;
export type ScenarioSource = z.infer<typeof ScenarioSourceSchema>;
export type ToolSource = z.infer<typeof ToolSourceSchema>;
export type TargetSource = z.infer<typeof TargetSourceSchema>;
export type DrillSource = z.infer<typeof DrillSourceSchema>;
export type SuiteSource = z.infer<typeof SuiteSourceSchema>;
