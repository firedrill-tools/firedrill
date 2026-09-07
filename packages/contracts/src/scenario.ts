import { z } from "zod";
import {
  ActorIdSchema,
  EventRefSchema,
  PackageIdSchema,
  StableIdSchema,
  VirtualTimeSchema,
} from "./identifiers.js";
import { JsonObjectSchema } from "./json.js";
import { OperationRefSchema } from "./identifiers.js";

export const ActorDefinitionSchema = z
  .object({
    id: ActorIdSchema,
    description: z
      .string()
      .min(1)
      .max(500)
      .regex(/\S/, "description must not be blank")
      .describe("Plain-text actor description for authoring and inspection; not a prompt or permission.")
      .optional(),
    attributes: JsonObjectSchema.default({}),
    grants: z.array(OperationRefSchema).default([]),
  })
  .strict()
  .superRefine((actor, context) => {
    const grants = actor.grants.map((grant) => `${grant.packageId}\u0000${grant.operationId}`);
    if (new Set(grants).size !== grants.length) {
      context.addIssue({
        code: "custom",
        path: ["grants"],
        message: "actor grants must not contain duplicates",
      });
    }
  });

export const StateSetupSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upsert"),
      packageId: PackageIdSchema,
      namespace: StableIdSchema,
      rowId: z.string().min(1).max(512),
      value: JsonObjectSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      packageId: PackageIdSchema,
      namespace: StableIdSchema,
      rowId: z.string().min(1).max(512),
    })
    .strict(),
]);

export const FaultActivationSchema = z
  .object({
    packageId: PackageIdSchema,
    faultId: StableIdSchema,
  })
  .strict();

export const InitialEventSchema = z
  .object({
    event: EventRefSchema,
    payload: JsonObjectSchema,
    atUs: VirtualTimeSchema,
    actorId: ActorIdSchema,
  })
  .strict();

const ScenarioBodyShape = {
  title: z.string().min(1).max(200).optional(),
  virtualTimeUs: VirtualTimeSchema,
  actors: z.array(ActorDefinitionSchema).default([]),
  state: z.array(StateSetupSchema).default([]),
  faults: z.array(FaultActivationSchema).default([]),
  initialEvents: z.array(InitialEventSchema).default([]),
};

interface ScenarioActorContent {
  readonly actors: readonly { readonly id: string }[];
  readonly initialEvents: readonly { readonly actorId: string }[];
}

function scenarioActorIssues(scenario: ScenarioActorContent) {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  const actorIds = scenario.actors.map((actor) => actor.id);
  if (new Set(actorIds).size !== actorIds.length) {
    issues.push({ path: ["actors"], message: "actors must not contain duplicate ids" });
  }
  const knownActors = new Set(actorIds);
  for (const [index, event] of scenario.initialEvents.entries()) {
    if (!knownActors.has(event.actorId)) {
      issues.push({
        path: ["initialEvents", index, "actorId"],
        message: `initial event references unknown actor ${event.actorId}`,
      });
    }
  }
  return issues;
}

function scenarioFaultIssues(scenario: { readonly faults: readonly FaultActivation[] }) {
  const faults = scenario.faults.map((fault) => `${fault.packageId}\u0000${fault.faultId}`);
  return new Set(faults).size === faults.length
    ? []
    : [{ path: ["faults"] as Array<string | number>, message: "faults must not contain duplicates" }];
}

export const InlineScenarioDefinitionSchema = z
  .object(ScenarioBodyShape)
  .strict()
  .superRefine((scenario, context) => {
    for (const issue of scenarioActorIssues(scenario)) context.addIssue({ code: "custom", ...issue });
    for (const issue of scenarioFaultIssues(scenario)) context.addIssue({ code: "custom", ...issue });
  });

/** Fully resolved runtime scenario. Source inheritance is flattened by the compiler. */
export const ScenarioDefinitionSchema = z
  .object({ schemaVersion: z.literal(1), id: StableIdSchema, ...ScenarioBodyShape })
  .strict()
  .superRefine((scenario, context) => {
    for (const issue of scenarioActorIssues(scenario)) context.addIssue({ code: "custom", ...issue });
    for (const issue of scenarioFaultIssues(scenario)) context.addIssue({ code: "custom", ...issue });
  });

export type FaultActivation = z.infer<typeof FaultActivationSchema>;
export type InitialEvent = z.infer<typeof InitialEventSchema>;
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
export type InlineScenarioDefinition = z.infer<typeof InlineScenarioDefinitionSchema>;
