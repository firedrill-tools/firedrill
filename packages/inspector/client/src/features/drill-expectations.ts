import type { SimulationDrill } from "../types.js";

type Definition = NonNullable<SimulationDrill["expectations"][number]["definition"]>;
type Comparison = Extract<Definition, { kind: "state.value" }>["comparison"];
type Operation = Extract<Definition, { kind: "operation.count" }>["operation"];
type OperationFilters = Pick<
  Extract<Definition, { kind: "operation.count" }>,
  "actorId" | "outcomes" | "idempotency"
>;

export interface ExpectationDescription {
  readonly subject: string;
  readonly expectation: string;
  /** Restrictions needed to interpret the expectation without opening its details. */
  readonly scope: readonly string[];
  readonly filters: readonly string[];
}

function value(input: unknown): string {
  return JSON.stringify(input);
}

function comparison(input: Comparison): string {
  switch (input.operator) {
    case "equals":
      return `equal ${value(input.value)} exactly`;
    case "not_equals":
      return `differ from ${value(input.value)}`;
    case "greater_than_or_equal":
      return `be a number greater than or equal to ${value(input.value)}`;
    case "less_than_or_equal":
      return `be a number less than or equal to ${value(input.value)}`;
    case "one_of":
      return `equal one of ${value(input.value)} exactly`;
  }
}

function operation(input: Operation): string {
  return `${input.packageId} / ${input.operationId}`;
}

function operationFilters(input: OperationFilters): string[] {
  return [
    ...(input.actorId === undefined ? [] : [`Actor: ${input.actorId}`]),
    input.outcomes === undefined
      ? "All outcomes count, including unsuccessful calls."
      : `Outcome: ${input.outcomes.join(" or ")}`,
    input.idempotency === undefined
      ? "All idempotency dispositions count, including replayed calls."
      : `Idempotency disposition: ${input.idempotency.join(" or ")}`,
  ];
}

function operationScope(input: OperationFilters, includeOutcomes = true): string[] {
  return [
    ...(input.actorId === undefined ? [] : [`Actor: ${input.actorId}`]),
    ...(includeOutcomes && input.outcomes !== undefined ? [`Outcome: ${input.outcomes.join(" or ")}`] : []),
    ...(input.idempotency === undefined
      ? []
      : [`Idempotency disposition: ${input.idempotency.join(" or ")}`]),
  ];
}

const eventPhases = {
  emitted: "emitted",
  scheduled: "scheduled",
  handled: "handled",
  failed: "failed",
} as const;

const callbackPhases = {
  queued: "queued",
  attempt_started: "delivery attempt started (attempt_started)",
  delivered: "delivered",
  retry_scheduled: "retry scheduled (retry_scheduled)",
  failed: "failed",
  recovered: "recovered",
} as const;

/** Describe authored expectations, never infer an outcome from an assertion's name. */
export function describeExpectation(definition: Definition): ExpectationDescription {
  switch (definition.kind) {
    case "state.value": {
      // Brackets preserve the difference between a dotted property, an object key
      // containing a number, and an array index. Do not flatten this into dot paths.
      const path = `$${definition.path.map((part) => `[${value(part)}]`).join("")}`;
      return {
        subject: `${definition.packageId} / ${definition.namespace} / row ${value(definition.rowId)} / ${path}`,
        expectation: `The field must exist and ${comparison(definition.comparison)}.`,
        scope: [],
        filters: [],
      };
    }
    case "state.count":
      return {
        subject: `Record count in ${definition.packageId} / ${definition.namespace}`,
        expectation: `The count must ${comparison(definition.comparison)}.`,
        scope: definition.where === undefined ? [] : [`Record values include ${value(definition.where)}`],
        filters:
          definition.where === undefined
            ? []
            : [
                `Record values must include ${value(definition.where)}. Nested object fields are matched; arrays must match exactly.`,
              ],
      };
    case "operation.count":
      return {
        subject: `Recorded calls to ${operation(definition.operation)}`,
        expectation: `The matching call count must ${comparison(definition.comparison)}.`,
        scope: operationScope(definition),
        filters: operationFilters(definition),
      };
    case "operation.order":
      return {
        subject: "Order of recorded tool calls",
        expectation: `Observe ${definition.sequence
          .map((step) => {
            const alternatives = step.anyOf.map(operation).join(" or ");
            return step.anyOf.length > 1 ? `(${alternatives})` : alternatives;
          })
          .join(" then ")} in this order. Other calls may occur before, between or after these calls.`,
        scope: definition.sequence.flatMap((step, index) =>
          operationScope(step).map((restriction) => `Step ${index + 1}: ${restriction}`),
        ),
        filters: definition.sequence.flatMap((step, index) =>
          operationFilters(step).map((filter) => `Step ${index + 1}: ${filter}`),
        ),
      };
    case "operation.arguments":
      return {
        subject: `Arguments of matching call ${definition.occurrence} to ${operation(definition.operation)}`,
        expectation: `That call must exist and its arguments must include ${value(definition.contains)}. Extra object fields are allowed; arrays must match exactly.`,
        scope: operationScope(definition),
        filters: operationFilters(definition),
      };
    case "operation.denied": {
      const outcomes =
        definition.outcomes ??
        (definition.errorCode?.startsWith("tool.") === true ? ["tool_error"] : ["denied"]);
      return {
        subject: `Attempts to ${operation(definition.operation)}`,
        expectation: `Every matching attempt must have outcome ${outcomes.join(" or ")}${definition.errorCode === undefined ? "" : ` and error code ${definition.errorCode}`}. ${definition.attemptRequired ? "At least one matching attempt is required." : "No attempt is required; zero matching attempts also passes."}`,
        scope: operationScope(definition, false),
        // Unlike count/order/arguments, denial outcomes are requirements for ALL
        // selected attempts. Filtering them here would hide a successful call.
        filters: [
          ...(definition.actorId === undefined ? [] : [`Actor: ${definition.actorId}`]),
          definition.idempotency === undefined
            ? "All idempotency dispositions are checked, including replayed calls."
            : `Idempotency disposition: ${definition.idempotency.join(" or ")}`,
        ],
      };
    }
    case "event.count":
      return {
        subject: `Recorded events for ${definition.event.packageId} / ${definition.event.eventId}`,
        expectation: `The number of ${eventPhases[definition.phase]} event entries must ${comparison(definition.comparison)}.`,
        scope: [],
        filters: [],
      };
    case "callback.count":
      return {
        subject: `Recorded callbacks for ${definition.callback.packageId} / ${definition.callback.callbackId}`,
        expectation: `The number of callback entries in phase ${callbackPhases[definition.phase]} must ${comparison(definition.comparison)}.`,
        scope: [],
        filters: [],
      };
  }
}
