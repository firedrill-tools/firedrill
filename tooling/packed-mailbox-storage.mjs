import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalWorld } from "@firedrill-run/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Copied to the packed consumer; declarations, behavior and starters resolve
// from the separate minimal consumer's installed archives, never workspace paths.
const installedProject = process.argv[2];
assert.ok(installedProject);
const root = join(installedProject, "mailbox-storage-environment");
mkdirSync(root);
const cli = join(installedProject, "node_modules", ".bin", "firedrill");
const initialized = spawnSync(
  cli,
  [
    "init",
    "--tool",
    "@firedrill-tools/tool-mailbox",
    "--tool",
    "@firedrill-tools/tool-object-storage",
    "--json",
  ],
  { cwd: root, encoding: "utf8", timeout: 30000 },
);
assert.equal(initialized.status, 0, initialized.stderr);
const setup = JSON.parse(initialized.stdout);
assert.equal(setup.status, "initialized");
assert.equal(setup.sourceValidated, true);
assert.equal(setup.testsExecuted, false);
assert.equal(setup.setup.starterRows, 2);
const source = JSON.parse(readFileSync(join(root, "firedrill", "world.json"), "utf8"));
assert.equal(source.actors[0].id, "local-dev");
assert.equal(source.actors[0].grants.length, 9);
assert.equal(source.state.length, 2);
const world = await createLocalWorld({ root });
const binding = await world.listen({ protocols: ["http", "mcp"], actorId: "local-dev" });
const client = new Client({ name: "packed-mailbox-storage", version: "1.0.0" });
let sequence = 0;
async function http(path, method = "GET", body, status = 200) {
  const response = await fetch(binding.http.url + path, {
    method,
    headers: {
      authorization: `Bearer ${binding.http.token}`,
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "idempotency-key": `packed-synthetic-${++sequence}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function mcp(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(binding.mcp.url), {
      authProvider: { token: async () => binding.mcp.token },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 9);
  assert.equal((await http("/mailbox/messages/welcome")).message.ownerId, "local-dev");
  const welcome = (await mcp("object-storage.objects.get", { bucket: "documents", key: "welcome.txt" }))
    .object;
  assert.equal(welcome.ownerId, "local-dev");
  assert.equal(welcome.byteLength, Buffer.byteLength(welcome.content, "utf8"));
  await http("/mailbox/messages/draft", "PUT", {
    from: "writer@example.test",
    to: ["reader@example.test"],
    subject: "Installed archive",
    body: "Synthetic",
    ifVersion: 0,
  });
  assert.equal((await mcp("mailbox.messages.send", { id: "draft", ifVersion: 1 })).message.folder, "sent");
  assert.equal((await http("/mailbox/messages?folder=sent&limit=1")).items[0].id, "draft");
  await mcp("object-storage.objects.put", {
    bucket: "documents",
    key: "notes/packed.txt",
    content: "Packed 🌍",
    ifVersion: 0,
  });
  const stored = (await http("/storage/object?bucket=documents&key=notes%2Fpacked.txt")).object;
  assert.equal(stored.content, "Packed 🌍");
  assert.equal(stored.byteLength, 11);
  await http("/storage/object?bucket=documents&key=notes%2Fpacked.txt&ifVersion=1", "DELETE");
  await http("/storage/object?bucket=documents&key=notes%2Fpacked.txt", "GET", undefined, 404);
  world.reset();
  assert.equal((await http("/mailbox/messages")).items.length, 1);
  assert.equal((await http("/storage/objects?bucket=documents")).items.length, 1);
} finally {
  await client.close();
  await binding.close();
  world.close();
}
process.stdout.write(
  "packed mailbox/storage selection, actor-owned starters, HTTP/MCP lifecycle and reset passed\n",
);
