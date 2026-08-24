import { ToolFailure, defineToolBehavior } from "@firedrill/tool-sdk";

function itemId(input: Readonly<Record<string, unknown>>): string {
  return String(input.id);
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
});
