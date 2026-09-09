import { defineToolBehavior, type ToolContext, type ToolOperationHandler } from "@firedrill/tool-sdk";
import { failure, nextVersion, page, route } from "./support.js";

type Input = Parameters<ToolOperationHandler>[0];
function rowId(input: Input, context: ToolContext): string {
  return `${context.actor.id}:${String(input.bucket)}:${String(input.key)}`;
}
function get(input: Input, context: ToolContext) {
  const value = context.state.get("objects", rowId(input, context));
  if (value === null || value.ownerId !== context.actor.id) failure("NOT_FOUND");
  return value;
}
function utf8Bytes(text: string): number {
  let size = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

export default defineToolBehavior({
  operations: {
    "objects.list": (input, context) =>
      page(
        context,
        "objects",
        input,
        JSON.stringify([context.actor.id, input.bucket, input.prefix ?? ""]),
        (value) => value.bucket === input.bucket && String(value.key).startsWith(String(input.prefix ?? "")),
        (value) => {
          const { content: _content, ...metadata } = value;
          return metadata;
        },
      ),
    "objects.get": (input, context) => ({ object: get(input, context) }),
    "objects.put": (input, context) => {
      const id = rowId(input, context);
      const previous = context.state.get("objects", id);
      if (previous !== null && previous.ownerId !== context.actor.id) failure("CONFLICT");
      const version = nextVersion(input, previous);
      const content = String(input.content);
      const object = {
        ownerId: context.actor.id,
        bucket: String(input.bucket),
        key: String(input.key),
        content,
        contentType: input.contentType ?? "text/plain; charset=utf-8",
        metadata: input.metadata ?? {},
        byteLength: utf8Bytes(content),
        version,
      };
      context.state.put("objects", id, object);
      context.events.emit("object.changed", {
        ownerId: context.actor.id,
        bucket: object.bucket,
        key: object.key,
        action: "put",
      });
      return { object };
    },
    "objects.delete": (input, context) => {
      const previous = get(input, context);
      nextVersion(input, previous);
      context.state.delete("objects", rowId(input, context));
      context.events.emit("object.changed", {
        ownerId: context.actor.id,
        bucket: String(input.bucket),
        key: String(input.key),
        action: "delete",
      });
      return { bucket: String(input.bucket), key: String(input.key), deleted: true };
    },
  },
  http: {
    list: route(["bucket", "prefix", "limit", "cursor"], false, false),
    get: route(["bucket", "key"], false, false),
    put: route([], true, true),
    delete: route(["bucket", "key", "ifVersion"], true, false),
  },
});
