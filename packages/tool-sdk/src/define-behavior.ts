import type {
  ToolBehaviorDefinition,
  ToolHttpRouteCodec,
  ToolOperationHandler,
  ToolSubscriptionHandler,
} from "./types.js";

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

function httpCodecRecord(value: unknown): Readonly<Record<string, ToolHttpRouteCodec>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("http must be an object of route codecs");
  }
  for (const [id, codec] of Object.entries(value)) {
    if (typeof codec !== "object" || codec === null || Array.isArray(codec)) {
      throw new TypeError(`http.${id} must be an object with decode and encode functions`);
    }
    const record = codec as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "decode" && key !== "encode") ||
      typeof record.decode !== "function" ||
      typeof record.encode !== "function"
    ) {
      throw new TypeError(`http.${id} must contain only decode and encode functions`);
    }
  }
  return value as Readonly<Record<string, ToolHttpRouteCodec>>;
}

/**
 * Defines executable behavior independently of its source manifest. This is
 * the runtime-safe surface embedded into immutable Tool artifacts.
 */
export function defineToolBehavior(input: ToolBehaviorDefinition): ToolBehaviorDefinition {
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "operations" && key !== "subscriptions" && key !== "http")) {
    throw new TypeError("Tool behavior accepts only operations, subscriptions, and http");
  }
  const operations = handlerRecord(input.operations, "operations") as Readonly<
    Record<string, ToolOperationHandler>
  >;
  const subscriptions = handlerRecord(input.subscriptions ?? {}, "subscriptions") as Readonly<
    Record<string, ToolSubscriptionHandler>
  >;
  const http = httpCodecRecord(input.http ?? {});
  return Object.freeze({
    operations: Object.freeze({ ...operations }),
    subscriptions: Object.freeze({ ...subscriptions }),
    http: Object.freeze({ ...http }),
  });
}
