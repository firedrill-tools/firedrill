import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalWorld } from "@firedrill-tools/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = {
  packageId: "mailbox",
  namespace: "messages",
  write: "messages.write",
  get: "messages.get",
  list: "messages.list",
  remove: "messages.delete",
  create: {
    id: "sample",
    from: "writer@example.test",
    to: ["reader@example.test"],
    subject: "Sample",
    body: "Hello 🌍",
    ifVersion: 0,
  },
  read: {
    id: "sample",
  },
  writePath: "/mailbox/messages/sample",
  getPath: "/mailbox/messages/sample",
  listPath: "/mailbox/messages",
  payload: "message",
  field: "body",
  filter: {
    folder: "sent",
  },
};
let sequence = 0;
function call(world, operationId, args, actorId = "operator", key) {
  const mutates = [config.write, config.remove, "messages.send"].includes(operationId);
  return world.call({
    actorId,
    packageId: config.packageId,
    operationId,
    arguments: args,
    ...(mutates ? { idempotencyKey: key ?? `public-${++sequence}` } : {}),
  }).outcome;
}
function ok(world, operationId, args, actorId = "operator") {
  const outcome = call(world, operationId, args, actorId);
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  return outcome.value;
}
function wireBody(create) {
  if (config.packageId !== "mailbox") return create;
  const { id: _id, ...body } = create;
  return body;
}

test("real HTTP and MCP share actor-scoped state, idempotency, errors, reset and independent worlds", {
  timeout: 60000,
}, async () => {
  const world = await createLocalWorld({ root, scenario: "baseline" });
  const independent = await createLocalWorld({ root, scenario: "baseline" });
  const binding = await world.listen({ protocols: ["http", "mcp"], actorId: "operator" });
  const foreign = await world.listen({ protocols: ["http"], actorId: "other" });
  const client = new Client({ name: "public-pack-test", version: "1.0.0" });
  const http = async (path, method = "GET", body, key = "http-key", target = binding) => {
    const response = await fetch(target.http.url + path, {
      method,
      headers: {
        authorization: `Bearer ${target.http.token}`,
        "content-type": "application/json",
        ...(method === "GET" ? {} : { "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(binding.mcp.url), {
        authProvider: { token: async () => binding.mcp.token },
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some((tool) => tool.name === `${config.packageId}.${config.get}`),
    );
    const created = await http(config.writePath, "PUT", wireBody(config.create));
    assert.equal(created.status, 200);
    assert.equal(created.body[config.payload].version, 1);
    assert.deepEqual(await http(config.writePath, "PUT", wireBody(config.create)), created);
    const conflictingReplay = await http(
      config.writePath,
      "PUT",
      wireBody({ ...config.create, [config.field]: "changed" }),
    );
    assert.equal(conflictingReplay.status, 400);
    assert.match(conflictingReplay.body.error.code, /IDEMPOTENCY/);
    const read = await client.callTool({ name: `${config.packageId}.${config.get}`, arguments: config.read });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.equal(read.structuredContent[config.payload][config.field], "Hello 🌍");
    assert.equal(call(independent, config.get, config.read).error.code, "tool.NOT_FOUND");
    assert.equal((await http(config.getPath, "GET", undefined, undefined, foreign)).status, 404);
    assert.equal(call(world, config.get, config.read, "other").error.code, "tool.NOT_FOUND");
    const update = await client.callTool({
      name: `${config.packageId}.${config.write}`,
      arguments: { ...config.create, [config.field]: "MCP update", ifVersion: 1 },
    });
    assert.ok(!update.isError, JSON.stringify(update));
    const updated = await http(config.getPath);
    assert.equal(updated.body[config.payload][config.field], "MCP update");
    assert.equal(updated.body[config.payload].version, 2);
    assert.equal((await http(config.writePath, "PUT", wireBody(config.create), "stale")).status, 409);
    assert.equal(
      (await http(config.writePath, "PUT", { ...wireBody(config.create), unknown: true }, "invalid")).status,
      400,
    );
    const separator = config.listPath.includes("?") ? "&" : "?";
    assert.equal((await http(`${config.listPath + separator}limit=0`)).status, 400);
    assert.equal((await http(`${config.listPath + separator}limit=1&limit=2`)).status, 400);
    assert.equal((await http(config.writePath, "PUT", wireBody(config.create), "")).status, 400);
    const denied = await fetch(binding.http.url + config.getPath, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(denied.status, 401);
    assert.equal(world.state({ packageId: config.packageId, namespace: config.namespace }).length, 2);
    ok(world, config.remove, { ...config.read, ifVersion: 2 });
    assert.equal((await http(config.getPath)).status, 404);
    world.reset();
    assert.equal((await http(config.getPath)).status, 404);
    assert.equal(world.state({ packageId: config.packageId, namespace: config.namespace }).length, 1);
    assert.equal(world.evidence().filter((entry) => entry.kind === "operation.completed").length <= 1, true);
  } finally {
    await client.close();
    await binding.close();
    await foreign.close();
    world.close();
    independent.close();
  }
});

test("sparse pages continue after the 1,000-row scan bound and bind cursors to actor and filters", {
  timeout: 120000,
}, async () => {
  const world = await createLocalWorld({ root, scenario: "baseline", maxToolCalls: 2000 });
  try {
    for (let index = 0; index < 1002; index++) {
      const name = `bulk-${String(index).padStart(4, "0")}`;
      ok(world, config.write, {
        ...config.create,
        ...(config.packageId === "mailbox" ? { id: name, body: "" } : { key: name, content: "" }),
      });
    }
    const needle =
      config.packageId === "mailbox"
        ? { ...config.create, id: "needle" }
        : { ...config.create, key: "needle.txt" };
    ok(world, config.write, needle);
    if (config.packageId === "mailbox") ok(world, "messages.send", { id: "needle", ifVersion: 1 });
    const first = ok(world, config.list, { ...config.filter, limit: 1 });
    assert.deepEqual(first.items, []);
    assert.ok(first.nextCursor, "a bounded sparse page must not claim the filtered result is exhausted");
    const second = ok(world, config.list, { ...config.filter, limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.ok(!(config.field in second.items[0]), "lists return metadata, not unbounded content");
    assert.equal(
      call(world, config.list, { ...config.filter, cursor: first.nextCursor }, "other").error.code,
      "tool.INVALID_CURSOR",
    );
    const changedFilter =
      config.packageId === "mailbox" ? { folder: "inbox" } : { bucket: "documents", prefix: "other" };
    assert.equal(
      call(world, config.list, { ...changedFilter, cursor: first.nextCursor }).error.code,
      "tool.INVALID_CURSOR",
    );
    const cursor = JSON.parse(first.nextCursor);
    assert.equal(
      call(world, config.list, { ...config.filter, cursor: JSON.stringify({ ...cursor, injected: true }) })
        .error.code,
      "tool.INVALID_CURSOR",
    );
    ok(world, config.write, { ...needle, ifVersion: 0 }, "other");
    assert.equal(
      ok(world, config.list, config.packageId === "mailbox" ? {} : { bucket: "documents" }, "other").items
        .length,
      1,
    );
  } finally {
    world.close();
  }
});
