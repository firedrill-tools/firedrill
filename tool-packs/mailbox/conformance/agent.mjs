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
  const draft = {
    from: "operator@example.test",
    to: ["reader@example.test"],
    subject: "Synthetic draft",
    body: "Never delivered externally.",
    ifVersion: 0,
  };
  assert.equal((await http("/mailbox/messages/welcome")).message.folder, "inbox");
  assert.equal((await http("/mailbox/messages/missing", "GET", undefined, 404)).error.code, "tool.NOT_FOUND");
  await http("/mailbox/messages/draft", "PUT", draft);
  await http("/mailbox/messages/draft-2", "PUT", draft);
  assert.equal((await mcp("mailbox.messages.get", { id: "draft" })).message.body, draft.body);
  const first = await http("/mailbox/messages?folder=draft&limit=1");
  assert.equal(first.items.length, 1);
  assert.ok(!("body" in first.items[0]));
  assert.ok(first.nextCursor);
  const second = await http(
    `/mailbox/messages?folder=draft&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(
    (await http("/mailbox/messages?cursor=broken", "GET", undefined, 400)).error.code,
    "tool.INVALID_CURSOR",
  );
  assert.equal(
    (
      await http(
        `/mailbox/messages?folder=inbox&cursor=${encodeURIComponent(first.nextCursor)}`,
        "GET",
        undefined,
        400,
      )
    ).error.code,
    "tool.INVALID_CURSOR",
  );
  assert.equal((await http("/mailbox/messages/draft", "PUT", draft, 409)).error.code, "tool.CONFLICT");
  assert.equal((await http("/mailbox/messages/welcome", "PUT", draft, 409)).error.code, "tool.INVALID_STATE");
  assert.equal(
    (await http("/mailbox/messages/missing/send", "POST", undefined, 404)).error.code,
    "tool.NOT_FOUND",
  );
  assert.equal(
    (await http("/mailbox/messages/draft/send?ifVersion=99", "POST", undefined, 409)).error.code,
    "tool.CONFLICT",
  );
  assert.equal(
    (await http("/mailbox/messages/welcome/send", "POST", undefined, 409)).error.code,
    "tool.INVALID_STATE",
  );
  const sent = await http("/mailbox/messages/draft/send?ifVersion=1", "POST", undefined, 200, "send-once");
  assert.equal(sent.message.folder, "sent");
  assert.deepEqual(
    await http("/mailbox/messages/draft/send?ifVersion=1", "POST", undefined, 200, "send-once"),
    sent,
  );
  assert.equal(
    (await http("/mailbox/messages/draft?ifVersion=1", "DELETE", undefined, 409)).error.code,
    "tool.CONFLICT",
  );
  assert.equal(
    (await http("/mailbox/messages/missing", "DELETE", undefined, 404)).error.code,
    "tool.NOT_FOUND",
  );
  assert.deepEqual(await mcp("mailbox.messages.delete", { id: "draft", ifVersion: 2 }), {
    id: "draft",
    deleted: true,
  });
  await http("/mailbox/messages/draft", "GET", undefined, 404);
} finally {
  await client.close();
}
process.stdout.write(JSON.stringify({ completed: true }));
