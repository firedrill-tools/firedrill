import type { ToolBehaviorDefinition, ToolOperationHandler, ToolSubscriptionHandler } from "./types.js";

function handlerRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, ToolOperationHandler | ToolSubscriptionHandler>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object of handler functions`);
  }
  for (const [id, handler] of Object.entries(value)) {
    if (typeof handler !== "function") throw new TypeError(`${name}.${id} must be a function`);
  }
  return value as Readonly<Record<string, ToolOperationHandler | ToolSubscriptionHandler>>;
}

/**
 * Defines executable behavior independently of its source manifest. This is
 * the runtime-safe surface embedded into immutable Tool artifacts.
 */
export function defineToolBehavior(input: ToolBehaviorDefinition): ToolBehaviorDefinition {
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "operations" && key !== "subscriptions")) {
    throw new TypeError("Tool behavior accepts only operations and subscriptions");
  }
  const operations = handlerRecord(input.operations, "operations") as Readonly<
    Record<string, ToolOperationHandler>
  >;
  const subscriptions = handlerRecord(input.subscriptions ?? {}, "subscriptions") as Readonly<
    Record<string, ToolSubscriptionHandler>
  >;
  return Object.freeze({
    operations: Object.freeze({ ...operations }),
    subscriptions: Object.freeze({ ...subscriptions }),
  });
}
