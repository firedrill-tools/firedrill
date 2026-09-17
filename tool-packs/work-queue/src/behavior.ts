import { ToolFailure, defineToolBehavior } from "@firedrill-tools/tool-sdk";

function itemId(input: Readonly<Record<string, unknown>>): string {
  return String(input.id);
}

function only(values: readonly string[] | undefined, name: string): string | undefined {
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new TypeError(`${name} must be supplied at most once`);
  return values[0];
}

function requiredIdempotencyKey(headers: Readonly<Record<string, readonly string[]>>): string {
  const key = only(headers["idempotency-key"], "idempotency-key");
  if (key === undefined || key.length === 0) throw new TypeError("idempotency-key is required");
  return key;
}

export default defineToolBehavior({
  operations: {
    "items.list": (input, context) => {
      const requestedLimit = typeof input.limit === "number" ? input.limit : 100;
      const status = typeof input.status === "string" ? input.status : undefined;
      const items = context.state
        .scan("items", { limit: Math.min(100, Math.max(1, requestedLimit)) })
        .filter((record) => status === undefined || record.value.status === status)
        .map((record) => ({ id: record.rowId, ...record.value }));
      return { items };
    },
    "items.claim": (input, context) => {
      const id = itemId(input);
      const item = context.state.get("items", id);
      if (item === null) {
        throw new ToolFailure({ code: "NOT_FOUND", message: `work item ${id} does not exist` });
      }
      context.state.put("items", id, { ...item, status: "claimed", claimedBy: context.actor.id });
      return { id, status: "claimed", claimedBy: context.actor.id };
    },
    "items.complete": (input, context) => {
      const id = itemId(input);
      const item = context.state.get("items", id);
      if (item === null) {
        throw new ToolFailure({ code: "NOT_FOUND", message: `work item ${id} does not exist` });
      }
      const result = typeof input.result === "string" ? input.result : undefined;
      context.state.put("items", id, {
        ...item,
        status: "completed",
        ...(result === undefined ? {} : { result }),
      });
      context.events.emit("item.completed", { id });
      return { id, status: "completed" };
    },
  },
  http: {
    "list-items": {
      decode: (request) => {
        const status = only(request.query.status, "status");
        const limitText = only(request.query.limit, "limit");
        const limit = limitText === undefined ? undefined : Number(limitText);
        if (limit !== undefined && !Number.isSafeInteger(limit)) {
          throw new TypeError("limit must be an integer");
        }
        return {
          arguments: {
            ...(status === undefined ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
          },
        };
      },
      encode: ({ outcome }) => ({
        body:
          outcome.status === "ok" &&
          typeof outcome.value === "object" &&
          outcome.value !== null &&
          !Array.isArray(outcome.value) &&
          Array.isArray(outcome.value.items)
            ? {
                kind: "json",
                value: {
                  data: { items: outcome.value.items },
                  meta: { count: outcome.value.items.length },
                },
              }
            : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
      }),
    },
    "claim-item": {
      decode: (request) => ({
        arguments: { id: request.path.itemId ?? "" },
        idempotencyKey: requiredIdempotencyKey(request.headers),
      }),
      encode: ({ outcome }) => ({
        body:
          outcome.status === "ok"
            ? { kind: "empty" }
            : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
      }),
    },
    "complete-item": {
      decode: (request) => ({
        arguments: {
          id: request.path.itemId ?? "",
          ...(request.body.kind === "text" && request.body.value.length > 0
            ? { result: request.body.value }
            : {}),
        },
        idempotencyKey: requiredIdempotencyKey(request.headers),
      }),
      encode: ({ outcome }) => ({
        ...(outcome.status === "ok" ? { headers: { "x-item-status": "completed" } } : {}),
        body:
          outcome.status === "ok"
            ? { kind: "text", value: "completed\n" }
            : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
      }),
    },
  },
});
