import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

let task = "";
for await (const chunk of process.stdin) task += chunk;
JSON.parse(task);
const base = process.env.FIREDRILL_HTTP_URL;
const token = process.env.FIREDRILL_HTTP_TOKEN;
const mcpUrl = process.env.FIREDRILL_MCP_URL;
const mcpToken = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(base && token && mcpUrl && mcpToken, "both world bindings are required");
const client = new Client({ name: "pack-conformance", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: { token: async () => mcpToken } }),
);
let sequence = 0;
async function http(path, method = "GET", body, status = 200, idempotencyKey) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(method !== "GET" ? { "idempotency-key": idempotencyKey ?? `conformance-${++sequence}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
async function mcp(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}
try {
  const object = {
    bucket: "documents",
    key: "draft.txt",
    content: "Hello 🌍",
    contentType: "text/plain",
    metadata: { purpose: "conformance" },
    ifVersion: 0,
  };
  const welcome = (await http("/storage/object?bucket=documents&key=welcome.txt")).object;
  assert.equal(welcome.version, 1);
  assert.equal(welcome.byteLength, Buffer.byteLength(welcome.content, "utf8"));
  assert.equal(
    (await http("/storage/object?bucket=documents&key=missing", "GET", undefined, 404)).error.code,
    "tool.NOT_FOUND",
  );
  const created = await http("/storage/object", "PUT", object, 200, "put-once");
  assert.equal(created.object.byteLength, 10);
  assert.deepEqual(await http("/storage/object", "PUT", object, 200, "put-once"), created);
  await http("/storage/object", "PUT", { ...object, key: "draft-2.txt" });
  assert.equal(
    (await mcp("object-storage.objects.get", { bucket: "documents", key: "draft.txt" })).object.content,
    object.content,
  );
  const first = await http("/storage/objects?bucket=documents&prefix=draft&limit=1");
  assert.equal(first.items.length, 1);
  assert.ok(!("content" in first.items[0]));
  assert.ok(first.nextCursor);
  const second = await http(
    `/storage/objects?bucket=documents&prefix=draft&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assert.notEqual(first.items[0].key, second.items[0].key);
  assert.equal(
    (await http("/storage/objects?bucket=documents&cursor=broken", "GET", undefined, 400)).error.code,
    "tool.INVALID_CURSOR",
  );
  assert.equal(
    (
      await http(
        `/storage/objects?bucket=elsewhere&prefix=draft&cursor=${encodeURIComponent(first.nextCursor)}`,
        "GET",
        undefined,
        400,
      )
    ).error.code,
    "tool.INVALID_CURSOR",
  );
  assert.equal((await http("/storage/object", "PUT", object, 409)).error.code, "tool.CONFLICT");
  assert.equal(
    (await http("/storage/object?bucket=documents&key=draft.txt&ifVersion=99", "DELETE", undefined, 409))
      .error.code,
    "tool.CONFLICT",
  );
  assert.equal(
    (await http("/storage/object?bucket=documents&key=missing", "DELETE", undefined, 404)).error.code,
    "tool.NOT_FOUND",
  );
  assert.deepEqual(
    await mcp("object-storage.objects.delete", { bucket: "documents", key: "draft.txt", ifVersion: 1 }),
    { bucket: "documents", key: "draft.txt", deleted: true },
  );
  await http("/storage/object?bucket=documents&key=draft.txt", "GET", undefined, 404);
} finally {
  await client.close();
}
process.stdout.write(JSON.stringify({ completed: true }));
