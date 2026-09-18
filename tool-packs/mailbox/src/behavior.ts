import { defineToolBehavior, type ToolContext, type ToolOperationHandler } from "@firedrill-run/tool-sdk";
import { failure, nextVersion, page, route } from "./support.js";

type Input = Parameters<ToolOperationHandler>[0];
function rowId(input: Input, context: ToolContext): string {
  return `${context.actor.id}:${String(input.id)}`;
}
function get(input: Input, context: ToolContext) {
  const value = context.state.get("messages", rowId(input, context));
  if (value === null || value.ownerId !== context.actor.id) failure("NOT_FOUND");
  return value;
}

export default defineToolBehavior({
  operations: {
    "messages.list": (input, context) =>
      page(
        context,
        "messages",
        input,
        JSON.stringify([context.actor.id, input.folder ?? null]),
        (value) => input.folder === undefined || value.folder === input.folder,
        (value) => {
          const { body: _body, ...header } = value;
          return header;
        },
      ),
    "messages.get": (input, context) => ({ message: get(input, context) }),
    "messages.write": (input, context) => {
      const id = rowId(input, context);
      const previous = context.state.get("messages", id);
      if (previous !== null && (previous.ownerId !== context.actor.id || previous.folder !== "draft"))
        failure("INVALID_STATE");
      const version = nextVersion(input, previous);
      const message = {
        id: String(input.id),
        ownerId: context.actor.id,
        from: String(input.from),
        to: input.to ?? [],
        subject: String(input.subject),
        body: String(input.body),
        folder: "draft",
        read: false,
        version,
      };
      context.state.put("messages", id, message);
      return { message };
    },
    "messages.send": (input, context) => {
      const previous = get(input, context);
      const version = nextVersion(input, previous);
      if (previous.folder !== "draft") failure("INVALID_STATE");
      const message = { ...previous, folder: "sent", version };
      context.state.put("messages", rowId(input, context), message);
      context.events.emit("message.sent", {
        id: String(input.id),
        ownerId: context.actor.id,
        to: previous.to ?? [],
      });
      return { message };
    },
    "messages.delete": (input, context) => {
      const previous = get(input, context);
      nextVersion(input, previous);
      context.state.delete("messages", rowId(input, context));
      return { id: String(input.id), deleted: true };
    },
  },
  http: {
    list: route(["folder", "limit", "cursor"], false, false),
    get: route([], false, false, true),
    write: route([], true, true, true),
    send: route(["ifVersion"], true, false, true),
    delete: route(["ifVersion"], true, false, true),
  },
});
