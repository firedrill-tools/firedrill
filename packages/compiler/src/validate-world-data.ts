import type { CanonicalWorldIr } from "@firedrill/world-ir";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import formatsModule from "ajv-formats";

export interface WorldDataIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function pointerPath(pointer: string): Array<string | number> {
  if (pointer.length === 0) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
  path: readonly (string | number)[],
  label: string,
): WorldDataIssue[] {
  return (errors ?? []).map((error) => ({
    path: [...path, ...pointerPath(error.instancePath)],
    message: `${label} ${error.message ?? `failed ${error.keyword} validation`}`,
  }));
}

export function validateWorldData(world: CanonicalWorldIr): readonly WorldDataIssue[] {
  const issues: WorldDataIssue[] = [];
  const ajv = new Ajv({ allErrors: true, strict: true });
  formatsModule.default(ajv);
  const stateValidators = new Map<string, ValidateFunction<unknown>>();
  const eventValidators = new Map<string, ValidateFunction<unknown>>();

  for (const [toolIndex, tool] of world.tools.entries()) {
    for (const [stateIndex, state] of tool.state.entries()) {
      try {
        stateValidators.set(`${tool.id}\u0000${state.namespace}`, ajv.compile(state.schema));
      } catch (error) {
        issues.push({
          path: ["tools", toolIndex, "state", stateIndex, "schema"],
          message: `invalid state JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    for (const [operationIndex, operation] of tool.operations.entries()) {
      for (const [field, schema] of [
        ["inputSchema", operation.inputSchema],
        ["outputSchema", operation.outputSchema],
      ] as const) {
        try {
          ajv.compile(schema);
        } catch (error) {
          issues.push({
            path: ["tools", toolIndex, "operations", operationIndex, field],
            message: `invalid operation JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    for (const [eventIndex, event] of tool.events.entries()) {
      try {
        eventValidators.set(`${tool.id}\u0000${event.id}`, ajv.compile(event.payloadSchema));
      } catch (error) {
        issues.push({
          path: ["tools", toolIndex, "events", eventIndex, "payloadSchema"],
          message: `invalid event JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const validateScenario = (
    scenario: CanonicalWorldIr["baseline"] | CanonicalWorldIr["scenarios"][number],
    path: readonly (string | number)[],
    stateStart: number,
    eventStart: number,
  ) => {
    for (let index = stateStart; index < scenario.state.length; index += 1) {
      const state = scenario.state[index];
      if (state?.action !== "upsert") continue;
      const validate = stateValidators.get(`${state.packageId}\u0000${state.namespace}`);
      if (validate !== undefined && !validate(state.value)) {
        issues.push(
          ...validationIssues(
            validate.errors,
            [...path, "state", index, "value"],
            `state ${state.packageId}.${state.namespace}/${state.rowId}`,
          ),
        );
      }
    }
    for (let index = eventStart; index < scenario.initialEvents.length; index += 1) {
      const event = scenario.initialEvents[index];
      if (event === undefined) continue;
      const validate = eventValidators.get(`${event.event.packageId}\u0000${event.event.eventId}`);
      if (validate !== undefined && !validate(event.payload)) {
        issues.push(
          ...validationIssues(
            validate.errors,
            [...path, "initialEvents", index, "payload"],
            `event ${event.event.packageId}.${event.event.eventId}`,
          ),
        );
      }
      if (event.atUs < scenario.virtualTimeUs) {
        issues.push({
          path: [...path, "initialEvents", index, "atUs"],
          message: `initial event is scheduled at ${event.atUs}, before scenario time ${scenario.virtualTimeUs}`,
        });
      }
    }
  };

  validateScenario(world.baseline, ["baseline"], 0, 0);
  for (const [index, scenario] of world.scenarios.entries()) {
    validateScenario(
      scenario,
      ["scenarios", index],
      world.baseline.state.length,
      world.baseline.initialEvents.length,
    );
    for (let eventIndex = 0; eventIndex < world.baseline.initialEvents.length; eventIndex += 1) {
      const inherited = scenario.initialEvents[eventIndex];
      if (inherited !== undefined && inherited.atUs < scenario.virtualTimeUs) {
        issues.push({
          path: ["scenarios", index, "virtualTimeUs"],
          message: `scenario time ${scenario.virtualTimeUs} is after inherited event at ${inherited.atUs}`,
        });
      }
    }
  }
  return issues;
}
