import { z } from "zod";
import { AssertionDefinitionSchema } from "./assertions.js";
import { ActorIdSchema, StableIdSchema, VirtualTimeSchema } from "./identifiers.js";
import { compareStableStrings, JsonValueSchema } from "./json.js";
import { InlineScenarioDefinitionSchema } from "./scenario.js";

export const TrialPolicySchema = z
  .object({
    count: z.number().int().positive().max(10_000).default(1),
    classification: z.enum(["contract", "safety", "quality"]).default("contract"),
  })
  .strict();

export const DrillTaskSchema = z
  .object({
    instruction: z.string().min(1).max(20_000),
    input: JsonValueSchema.optional(),
  })
  .strict();

export const DrillInteractionSchema = z
  .object({
    id: StableIdSchema,
    /** Offset from the scenario's starting virtual time. */
    afterStartUs: VirtualTimeSchema,
    actorId: ActorIdSchema,
    task: DrillTaskSchema,
  })
  .strict();

export const DrillWorkloadSchema = z
  .object({
    id: StableIdSchema.refine((value) => value.length <= 80, "workload id must be at most 80 characters"),
    actorIds: z.array(ActorIdSchema).min(1).max(10_000),
    task: DrillTaskSchema,
    startAfterUs: VirtualTimeSchema.default(0),
    everyUs: z.number().int().positive().safe(),
    occurrences: z.number().int().positive().max(10_000),
  })
  .strict()
  .superRefine((workload, context) => {
    for (const [index, actorId] of workload.actorIds.entries()) {
      if (workload.actorIds.indexOf(actorId) !== index) {
        context.addIssue({
          code: "custom",
          path: ["actorIds", index],
          message: `duplicate workload actor ${actorId}`,
        });
      }
    }
  });

export const DrillTimelineSchema = z
  .object({
    /** Virtual duration measured from the scenario's starting clock. */
    horizonUs: VirtualTimeSchema.default(0),
    /** One cumulative agent Tool-call budget for the complete trial. */
    maxToolCalls: z.number().int().positive().max(1_000_000).default(1_000),
    /** One cumulative scheduled-event budget for the complete trial. */
    maxEvents: z.number().int().positive().max(1_000_000).default(10_000),
    /** Stop before later interactions when a gating invariant fails. */
    stopOnInvariantFailure: z.boolean().default(true),
    /** Stop before later interactions after a target failure. */
    stopOnTargetFailure: z.boolean().default(true),
    interactions: z.array(DrillInteractionSchema).max(10_000).default([]),
    /** Repeated actor tasks expanded deterministically by the runner. */
    workloads: z.array(DrillWorkloadSchema).max(1_000).default([]),
    /** Assertions checked after every interaction, scheduled event, and at the horizon. */
    invariants: z.array(AssertionDefinitionSchema).default([]),
  })
  .strict()
  .superRefine((timeline, context) => {
    if (timeline.interactions.length === 0 && timeline.workloads.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["interactions"],
        message: "timeline requires at least one interaction or workload",
      });
    }
    const ids = new Set<string>();
    let previousOffset = -1;
    for (const [index, interaction] of timeline.interactions.entries()) {
      if (ids.has(interaction.id)) {
        context.addIssue({
          code: "custom",
          path: ["interactions", index, "id"],
          message: `duplicate interaction id ${interaction.id}`,
        });
      }
      ids.add(interaction.id);
      if (interaction.afterStartUs < previousOffset) {
        context.addIssue({
          code: "custom",
          path: ["interactions", index, "afterStartUs"],
          message: "interactions must be ordered by afterStartUs",
        });
      }
      if (interaction.afterStartUs > timeline.horizonUs) {
        context.addIssue({
          code: "custom",
          path: ["interactions", index, "afterStartUs"],
          message: "interaction occurs after the timeline horizon",
        });
      }
      previousOffset = interaction.afterStartUs;
    }
    const workloadIds = new Set<string>();
    let generatedCount = timeline.interactions.length;
    for (const [workloadIndex, workload] of timeline.workloads.entries()) {
      if (workloadIds.has(workload.id)) {
        context.addIssue({
          code: "custom",
          path: ["workloads", workloadIndex, "id"],
          message: `duplicate workload id ${workload.id}`,
        });
      }
      workloadIds.add(workload.id);
      generatedCount += workload.actorIds.length * workload.occurrences;
      for (let occurrence = 1; occurrence <= workload.occurrences; occurrence += 1) {
        for (let actor = 1; actor <= workload.actorIds.length; actor += 1) {
          const generatedId = `${workload.id}-${occurrence}-${actor}`;
          if (ids.has(generatedId)) {
            context.addIssue({
              code: "custom",
              path: ["workloads", workloadIndex, "id"],
              message: `generated interaction id ${generatedId} is already in use`,
            });
          }
          ids.add(generatedId);
        }
      }
      const finalOffset = workload.startAfterUs + (workload.occurrences - 1) * workload.everyUs;
      if (!Number.isSafeInteger(finalOffset) || finalOffset > timeline.horizonUs) {
        context.addIssue({
          code: "custom",
          path: ["workloads", workloadIndex],
          message: "workload exceeds the timeline horizon",
        });
      }
    }
    if (generatedCount > 10_000) {
      context.addIssue({
        code: "custom",
        path: ["workloads"],
        message: "timeline expands beyond the 10000-interaction budget",
      });
    }
  });

export const DrillDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    title: z.string().min(1).max(200).optional(),
    tags: z.array(StableIdSchema).default([]),
    targetId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    inlineScenario: InlineScenarioDefinitionSchema.optional(),
    timeline: DrillTimelineSchema,
    trials: TrialPolicySchema.default({ count: 1, classification: "contract" }),
    assertions: z.array(AssertionDefinitionSchema).min(1),
  })
  .strict()
  .superRefine((drill, context) => {
    for (const [index, tag] of drill.tags.entries()) {
      if (drill.tags.indexOf(tag) !== index) {
        context.addIssue({ code: "custom", path: ["tags", index], message: `duplicate tag ${tag}` });
      }
      if (index > 0 && compareStableStrings(drill.tags[index - 1] ?? "", tag) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["tags", index],
          message: "tags must be sorted by stable identity",
        });
      }
    }
    if ((drill.scenarioId === undefined) === (drill.inlineScenario === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["scenarioId"],
        message: "a drill requires exactly one of scenarioId or inlineScenario",
      });
    }
    if (
      drill.inlineScenario !== undefined &&
      drill.timeline.interactions.some(
        (interaction) => !drill.inlineScenario?.actors.some((actor) => actor.id === interaction.actorId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["timeline", "interactions"],
        message: "drill timeline references an unknown inline-scenario actor",
      });
    }
    if (drill.inlineScenario !== undefined) {
      const actorIds = new Set(drill.inlineScenario.actors.map((actor) => actor.id));
      for (const [workloadIndex, workload] of drill.timeline.workloads.entries()) {
        for (const [actorIndex, actorId] of workload.actorIds.entries()) {
          if (actorIds.has(actorId)) continue;
          context.addIssue({
            code: "custom",
            path: ["timeline", "workloads", workloadIndex, "actorIds", actorIndex],
            message: `drill workload references unknown inline-scenario actor ${actorId}`,
          });
        }
      }
    }
    const assertionIds = [...drill.timeline.invariants, ...drill.assertions].map((assertion) => assertion.id);
    if (new Set(assertionIds).size !== assertionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "invariant and final assertion ids must be unique within a drill",
      });
    }
  });

export type DrillDefinition = z.infer<typeof DrillDefinitionSchema>;
export type DrillInteraction = z.infer<typeof DrillInteractionSchema>;
export type DrillTimeline = z.infer<typeof DrillTimelineSchema>;
export type DrillWorkload = z.infer<typeof DrillWorkloadSchema>;

/** Materializes authored and repeated workload tasks in deterministic execution order. */
export function expandDrillInteractions(timeline: DrillTimeline): readonly DrillInteraction[] {
  const ordered: Array<DrillInteraction & { readonly sourceOrder: number }> = [];
  let sourceOrder = 0;
  for (const interaction of timeline.interactions) {
    ordered.push({ ...interaction, sourceOrder });
    sourceOrder += 1;
  }
  for (const workload of timeline.workloads) {
    for (let occurrence = 1; occurrence <= workload.occurrences; occurrence += 1) {
      for (const [actorIndex, actorId] of workload.actorIds.entries()) {
        ordered.push({
          id: StableIdSchema.parse(`${workload.id}-${occurrence}-${actorIndex + 1}`),
          afterStartUs: workload.startAfterUs + (occurrence - 1) * workload.everyUs,
          actorId,
          task: workload.task,
          sourceOrder,
        });
        sourceOrder += 1;
      }
    }
  }
  return ordered
    .sort((left, right) => left.afterStartUs - right.afterStartUs || left.sourceOrder - right.sourceOrder)
    .map(({ sourceOrder: _sourceOrder, ...interaction }) => interaction);
}
