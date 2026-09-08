import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld, type LocalWorld, type LocalWorldBinding } from "@firedrill/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalInspectorWithAssets, type LocalInspectorServer } from "../src/server.js";

const directories: string[] = [];
const servers: LocalInspectorServer[] = [];
const worlds: LocalWorld[] = [];
const bindings: LocalWorldBinding[] = [];
const token = "inspector-environment-control-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-inspector-environment-"));
  directories.push(root);
  return root;
}

function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function repository(): string {
  const root = temporary();
  mkdirSync(join(root, "world"));
  json(join(root, "firedrill.json"), { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  json(join(root, "world/world.json"), {
    schemaVersion: 1,
    id: "counter-world",
    seed: "8",
    actors: [{ id: "operator", grants: [{ packageId: "counter", operationId: "set" }] }],
    state: ["a", "b", "c"].map((rowId, count) => ({
      action: "upsert",
      packageId: "counter",
      namespace: "records",
      rowId,
      value: { count, password: "fixture-password-value", privateNote: "declared-sensitive-value" },
    })),
  });
  const schema = {
    type: "object",
    required: ["count"],
    properties: {
      count: { type: "integer" },
      password: { type: "string" },
      privateNote: { type: "string", writeOnly: true },
    },
    additionalProperties: false,
  };
  json(join(root, "world/counter.tool.json"), {
    schemaVersion: 1,
    module: "./counter.js",
    manifest: {
      schemaVersion: 1,
      id: "counter",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "records", schema }],
      operations: ["set", "blocked"].map((id) => ({
        id,
        inputSchema: schema,
        outputSchema: schema,
        idempotency: "none",
        fidelity: "stateful",
      })),
    },
  });
  writeFileSync(
    join(root, "world/counter.js"),
    'export default { operations: { set(input, context) { context.state.put("records", "a", input); return input; }, blocked(input) { return input; } } };\n',
  );
  return root;
}

function assets(): string {
  const root = temporary();
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><meta name="firedrill-token" content="__FIREDRILL_TOKEN__">',
  );
  return root;
}

async function environment() {
  const root = repository();
  const world = await createLocalWorld({ root });
  worlds.push(world);
  const binding = await world.listen({ protocols: ["http"] });
  bindings.push(binding);
  const server = await startLocalInspectorWithAssets({
    root,
    environment: { world, binding },
    assetDirectory: assets(),
    token,
  });
  servers.push(server);
  return { root, world, binding, server };
}

async function get(server: LocalInspectorServer, route: string) {
  const response = await fetch(`${server.url}/api/environment${route}`, { headers });
  return { status: response.status, body: await response.json() };
}

async function post(server: LocalInspectorServer, route: string, body: unknown) {
  const response = await fetch(`${server.url}/api/environment${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const binding of bindings.splice(0)) await binding.close();
  for (const world of worlds.splice(0)) world.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("live inspector environment", () => {
  it("refuses endpoints from a different world even when the actor and repository match", async () => {
    const { root, world, binding } = await environment();
    const other = await createLocalWorld({ root, buildHash: world.describe().buildHash });
    worlds.push(other);
    await expect(
      startLocalInspectorWithAssets({
        root,
        assetDirectory: assets(),
        token,
        environment: { world: other, binding },
      }),
    ).rejects.toThrow("binding must belong");
    expect(world.metadata().worldInstanceId).toBe(binding.worldInstanceId);
    expect(other.metadata().worldInstanceId).not.toBe(binding.worldInstanceId);
  });
  it("has an explicit absent state in the source/report inspector", async () => {
    const server = await startLocalInspectorWithAssets({
      root: repository(),
      assetDirectory: assets(),
      token,
    });
    servers.push(server);
    expect(await get(server, "")).toEqual({ status: 200, body: { schemaVersion: 1, available: false } });
    expect((await get(server, "/tools")).status).toBe(404);
    expect((await fetch(`${server.url}/api/environment`)).status).toBe(401);
  });

  it("shows baseline live data and immutable operation contracts without asserting an agent was tested", async () => {
    const { root, world, binding, server } = await environment();
    const sourceBefore = readFileSync(join(root, "world/world.json"), "utf8");
    const status = await get(server, "");
    expect(status).toMatchObject({
      status: 200,
      body: {
        available: true,
        agentTested: false,
        source: "live_environment",
        description: { worldId: "counter-world", generation: 0 },
      },
    });
    expect(status.body).not.toHaveProperty("description.scenarioId");
    expect(status.body).not.toHaveProperty("description.drillId");
    expect(JSON.stringify(status.body)).not.toContain(binding.http?.token);
    expect((await get(server, "/tools")).body).toMatchObject({
      tools: [{ operationContracts: [{ id: "blocked", inputSchema: { type: "object" } }, { id: "set" }] }],
    });
    const state = await get(server, "/state?packageId=counter&namespace=records&limit=1");
    expect(state.body).toMatchObject({
      records: [{ rowId: "a", value: { count: 0, password: "[REDACTED]", privateNote: "[REDACTED]" } }],
      nextRowId: "a",
    });
    expect(
      (await get(server, "/state?packageId=counter&namespace=records&limit=1&afterRowId=a")).body,
    ).toMatchObject({ records: [{ rowId: "b" }], nextRowId: "b" });
    expect(
      (await get(server, "/state?packageId=counter&namespace=records&limit=1&afterRowId=b")).body,
    ).toMatchObject({ records: [{ rowId: "c" }] });
    expect(
      (await get(server, "/state?packageId=counter&namespace=records&limit=1&afterRowId=b")).body,
    ).not.toHaveProperty("nextRowId");
    const call = await post(server, "/call", {
      actorId: "operator",
      packageId: "counter",
      operationId: "set",
      arguments: { count: 14, password: "new-password-value", privateNote: "new-private-note" },
    });
    expect(call).toMatchObject({
      status: 200,
      body: {
        initiator: "operator",
        agentTested: false,
        result: {
          outcome: { status: "ok", value: { count: 14, password: "[REDACTED]", privateNote: "[REDACTED]" } },
        },
      },
    });
    expect(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count).toBe(14);
    expect(
      (
        await post(server, "/call", {
          actorId: "operator",
          packageId: "counter",
          operationId: "blocked",
          arguments: { count: 90 },
        })
      ).body,
    ).toMatchObject({ result: { outcome: { status: "denied" } } });
    const activity = await get(server, "/activity?limit=1000");
    const journal = activity.body as {
      entries: Array<{ kind: string; initiator: string }>;
      nextSequence: number;
    };
    expect(journal.entries.filter((entry) => entry.kind === "operation")).toMatchObject([
      { initiator: "operator" },
      { initiator: "operator" },
    ]);
    expect(JSON.stringify(activity.body)).not.toContain("new-password-value");
    expect(JSON.stringify(activity.body)).not.toContain("new-private-note");
    expect((await get(server, `/activity?fromSequence=${journal.nextSequence}`)).body).toMatchObject({
      entries: [],
    });
    expect(readFileSync(join(root, "world/world.json"), "utf8")).toBe(sourceBefore);
    const revealed = await get(server, "/connections");
    expect(revealed.body).toMatchObject({
      connections: [{ protocol: "http", token: binding.http?.token, actorId: "operator" }],
      environment: binding.environment,
    });
  });

  it("requires exact identity to reset, invalidates cursor epochs, and never owns supplied listeners", async () => {
    const { world, binding, server } = await environment();
    await post(server, "/call", {
      actorId: "operator",
      packageId: "counter",
      operationId: "set",
      arguments: { count: 88 },
    });
    const identity = world.metadata().worldInstanceId;
    for (const body of [{}, { worldInstanceId: "another-world" }])
      expect((await post(server, "/reset", body)).status).toBe(409);
    for (const packages of [[], ["missing"], "counter"])
      expect(
        (await post(server, "/reset", { worldInstanceId: identity, packages })).status,
      ).toBeGreaterThanOrEqual(400);
    expect(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count).toBe(88);
    expect(await post(server, "/reset", { worldInstanceId: identity })).toMatchObject({
      status: 200,
      body: { generation: 1, result: { scope: "world" }, agentTested: false },
    });
    expect(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count).toBe(0);
    expect((await get(server, "/activity?generation=0&fromSequence=2")).status).toBe(409);
    expect((await get(server, "/activity?generation=1")).body).toMatchObject({
      entries: expect.not.arrayContaining([expect.objectContaining({ kind: "operation" })]),
    });
    expect(
      (await post(server, "/reset", { worldInstanceId: identity, packages: ["counter"] })).body,
    ).toMatchObject({ generation: 2, result: { scope: "packages" } });
    await server.close();
    expect(world.metadata().worldInstanceId).toBe(identity);
    const response = await fetch(`${binding.http?.url}/v1/operations/counter/set`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${binding.http?.token}` },
      body: JSON.stringify({ arguments: { count: 6 } }),
    });
    expect(response.status).toBe(200);
    expect(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count).toBe(6);
    expect(
      world
        .evidence()
        .filter((entry) => entry.kind === "operation")
        .at(-1)?.correlationId,
    ).not.toContain("corr_local_operator_");
  });

  it("rejects missing credentials, cross-origin controls, malformed bodies, and invalid pagination", async () => {
    const { server, world } = await environment();
    for (const route of ["", "/connections", "/state?packageId=counter&namespace=records", "/activity"])
      expect((await fetch(`${server.url}/api/environment${route}`)).status).toBe(401);
    for (const origin of ["https://outside.test", "http://localhost:1234", "null"])
      expect(
        (
          await fetch(`${server.url}/api/environment/reset`, {
            method: "POST",
            headers: { ...headers, origin },
            body: JSON.stringify({ worldInstanceId: world.metadata().worldInstanceId }),
          })
        ).status,
      ).toBe(421);
    expect(
      (await fetch(`${server.url}/api/environment`, { headers: { ...headers, origin: server.url } })).status,
    ).toBe(200);
    expect(
      await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          `${server.url}/api/environment`,
          { headers: { ...headers, host: "127.0.0.1:1234" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      }),
    ).toBe(421);
    for (const route of [
      "/activity?limit=0",
      "/activity?limit=1001",
      "/activity?fromSequence=1.5",
      "/activity?generation=-1",
      "/state?packageId=counter&namespace=records&limit=1001",
      "/state?packageId=counter&namespace=records&afterRowId=",
    ])
      expect((await get(server, route)).status).toBe(400);
    expect((await get(server, "/state?packageId=counter&namespace=missing")).status).toBe(404);
    expect(
      (await fetch(`${server.url}/api/environment/call`, { method: "POST", headers, body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${server.url}/api/environment/call`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "x".repeat(65536) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await post(server, "/call", {
          actorId: "operator",
          packageId: "counter",
          operationId: "set",
          unknown: true,
        })
      ).status,
    ).toBe(400);
  });

  it("rejects a control upload that crosses a world reset instead of applying it to the new generation", async () => {
    const { server, world } = await environment();
    for (const route of ["call", "reset"]) {
      const body = JSON.stringify(
        route === "call"
          ? {
              actorId: "operator",
              packageId: "counter",
              operationId: "set",
              arguments: { count: 99 },
            }
          : { worldInstanceId: world.metadata().worldInstanceId },
      );
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          `${server.url}/api/environment/${route}`,
          {
            method: "POST",
            headers: { ...headers, "content-length": Buffer.byteLength(body), expect: "100-continue" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        outgoing.once("error", reject);
        outgoing.once("continue", () => {
          world.reset();
          outgoing.end(body);
        });
        outgoing.flushHeaders();
      });
      expect(status).toBe(409);
      expect(world.state({ packageId: "counter", namespace: "records" })[0]?.value.count).toBe(0);
    }
    expect(world.describe().generation).toBe(2);
  });
});
