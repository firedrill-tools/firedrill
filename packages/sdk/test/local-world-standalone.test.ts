import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeCliWorldOperation } from "@firedrill/protocol-cli";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorld, type LocalWorldBinding, type LocalWorldListenOptions } from "../src/index.js";

const directories: string[] = [];
const empty = { type: "object", additionalProperties: false };
const count = {
  type: "object",
  required: ["count"],
  properties: { count: { type: "integer" } },
  additionalProperties: false,
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function repository(
  id: string,
  world: Record<string, unknown>,
  manifest: Record<string, unknown>,
  module: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-standalone-"));
  directories.push(root);
  mkdirSync(join(root, "world"));
  writeJson(join(root, "firedrill.json"), { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  writeJson(join(root, "world/world.json"), { schemaVersion: 1, id: `${id}-world`, seed: "81", ...world });
  writeJson(join(root, "world/service.tool.json"), {
    schemaVersion: 1,
    module: "./service.js",
    manifest: { schemaVersion: 1, id, version: "1.0.0", engine: ">=0.1.0 <0.2.0", ...manifest },
  });
  writeFileSync(join(root, "world/service.js"), module);
  return root;
}

function stockRepository(): string {
  const root = repository(
    "stockroom",
    {
      actors: [
        {
          id: "clerk",
          grants: [
            { packageId: "stockroom", operationId: "reserve" },
            { packageId: "stockroom", operationId: "read" },
          ],
        },
      ],
      state: [
        {
          action: "upsert",
          packageId: "stockroom",
          namespace: "stock",
          rowId: "remaining",
          value: { count: 7 },
        },
      ],
    },
    {
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "stock", schema: count }],
      operations: [
        {
          id: "reserve",
          inputSchema: count,
          outputSchema: count,
          idempotency: "required",
          fidelity: "stateful",
        },
        { id: "read", inputSchema: empty, outputSchema: count, idempotency: "none", fidelity: "stateful" },
        { id: "erase", inputSchema: empty, outputSchema: count, idempotency: "none", fidelity: "stateful" },
      ],
    },
    `export default { operations: {
    reserve(input, context) { const count = context.state.get("stock", "remaining").count - input.count; context.state.put("stock", "remaining", {count}); return {count}; },
    read(_input, context) { return context.state.get("stock", "remaining"); },
    erase(_input, context) { context.state.put("stock", "remaining", {count: 0}); return {count: 0}; }
  } };`,
  );
  writeJson(join(root, "world/audit.scenario.json"), {
    schemaVersion: 1,
    id: "audit",
    virtualTimeUs: 75,
    actors: [{ id: "clerk", grants: [{ packageId: "stockroom", operationId: "read" }] }],
    state: [
      {
        action: "upsert",
        packageId: "stockroom",
        namespace: "stock",
        rowId: "remaining",
        value: { count: 19 },
      },
    ],
  });
  return root;
}

function calculatorRepository(
  actors: readonly unknown[] = [
    { id: "analyst", grants: [{ packageId: "calculator", operationId: "convert" }] },
  ],
): string {
  return repository(
    "calculator",
    { actors },
    {
      capabilities: ["random.draw"],
      state: [],
      operations: [
        {
          id: "convert",
          inputSchema: count,
          outputSchema: {
            type: "object",
            required: ["doubled", "nonce"],
            properties: { doubled: { type: "integer" }, nonce: { type: "integer" } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "behavioral",
        },
      ],
    },
    "export default { operations: { convert(input, context) { return { doubled: input.count * 2, nonce: context.random.nextInteger(0, 1000000) }; } } };",
  );
}

function sensorRepository(): string {
  return repository(
    "sensor-net",
    {
      virtualTimeUs: 10,
      actors: [{ id: "observer", grants: [{ packageId: "sensor-net", operationId: "reading" }] }],
      state: [
        {
          action: "upsert",
          packageId: "sensor-net",
          namespace: "readings",
          rowId: "current",
          value: { count: 0 },
        },
      ],
      initialEvents: [
        {
          event: { packageId: "sensor-net", eventId: "sample" },
          payload: { count: 42 },
          atUs: 30,
          actorId: "observer",
        },
      ],
    },
    {
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [{ namespace: "readings", schema: count }],
      events: [{ id: "sample", payloadSchema: count }],
      subscriptions: [{ id: "measure", event: { packageId: "sensor-net", eventId: "sample" } }],
      operations: [
        { id: "reading", inputSchema: empty, outputSchema: count, idempotency: "none", fidelity: "stateful" },
      ],
    },
    'export default { operations: { reading(_input, context) { return context.state.get("readings", "current"); } }, subscriptions: { measure(payload, context) { context.state.put("readings", "current", { count: payload.count }); } } };',
  );
}

async function httpCall(
  endpoint: { url: string; token: string },
  operationId: string,
  arguments_: unknown = {},
  idempotencyKey?: string,
) {
  const response = await fetch(`${endpoint.url}/v1/operations/stockroom/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      arguments: arguments_,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  });
  return { status: response.status, body: await response.json() };
}

let requestId = 0;
async function mcpCall(
  endpoint: { url: string; token: string },
  operationId: string,
  arguments_: unknown = {},
) {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name: `stockroom.${operationId}`, arguments: arguments_ },
    }),
  });
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .at(-1)
    : JSON.parse(text);
  return { status: response.status, body };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function assertPortReleased(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone local worlds", () => {
  it("closes every protocol promptly even while a client leaves an authenticated body incomplete", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    const binding = await world.listen();
    const sockets: Socket[] = [];
    try {
      for (const protocol of ["http", "mcp", "cli"] as const) {
        const endpoint = binding[protocol];
        if (endpoint === undefined) throw new Error("missing listener");
        const url = new URL(endpoint.url);
        const socket = createConnection({ host: url.hostname, port: Number(url.port) });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", resolve);
        });
        const continued = new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("data", (data) =>
            data.toString().includes("100 Continue")
              ? resolve()
              : reject(new Error("expected upload acknowledgement")),
          );
        });
        socket.write(
          `POST ${protocol === "mcp" ? "/mcp" : "/v1/operations/stockroom/reserve"} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${endpoint.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n`,
        );
        await continued;
      }
      const deadline = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 1000);
      const started = Date.now();
      try {
        await Promise.all([binding.close(), binding.close()]);
        expect(Date.now() - started).toBeLessThan(750);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await binding.close();
      world.close();
    }
  });
  it("uses the baseline without a target or drill and resolves named scenario state and grants", async () => {
    const root = stockRepository();
    const baseline = await createLocalWorld({ root });
    const audit = await createLocalWorld({
      root,
      scenario: "audit",
      buildHash: baseline.describe().buildHash,
    });
    try {
      expect(baseline.describe()).toMatchObject({
        worldId: "stockroom-world",
        actors: [{ actorId: "clerk" }],
      });
      expect(baseline.describe()).not.toHaveProperty("drillId");
      expect(baseline.describe()).not.toHaveProperty("scenarioId");
      expect(audit.describe()).toMatchObject({ scenarioId: "audit" });
      expect(audit.metadata().virtualTimeUs).toBe(75);
      expect(
        baseline.call({
          actorId: "clerk",
          packageId: "stockroom",
          operationId: "reserve",
          arguments: { count: 2 },
          idempotencyKey: "reserve-1",
        }).outcome,
      ).toMatchObject({ status: "ok", value: { count: 5 } });
      expect(
        audit.call({ actorId: "clerk", packageId: "stockroom", operationId: "read" }).outcome,
      ).toMatchObject({ status: "ok", value: { count: 19 } });
      expect(
        audit.call({
          actorId: "clerk",
          packageId: "stockroom",
          operationId: "reserve",
          arguments: { count: 1 },
          idempotencyKey: "denied-1",
        }).outcome.status,
      ).toBe("denied");
      expect(baseline.evidence().some((entry) => entry.kind === "operation")).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(root, ".firedrill/builds", baseline.describe().buildHash.slice(7), "world.ir.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ drills: [], targets: [] });
    } finally {
      baseline.close();
      audit.close();
    }
  });

  it("runs a stateless seeded backend with a resettable operation budget", async () => {
    const root = calculatorRepository();
    const first = await createLocalWorld({ root, seed: "951", maxToolCalls: 1 });
    const second = await createLocalWorld({ root, seed: "951", buildHash: first.describe().buildHash });
    const call = {
      actorId: "analyst",
      packageId: "calculator",
      operationId: "convert",
      arguments: { count: 12 },
    };
    try {
      const initial = first.call(call).outcome;
      expect(initial).toMatchObject({ status: "ok", value: { doubled: 24 } });
      expect(second.call(call).outcome).toEqual(initial);
      expect(first.call(call).outcome).toMatchObject({
        status: "tool_error",
        error: { code: "world.TOOL_CALL_BUDGET_EXCEEDED" },
      });
      first.reset();
      expect(first.call(call).outcome).toEqual(initial);
      expect(first.describe().tools[0]?.stateNamespaces).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("runs event-reactive state and restores the clock and pending work without a drill", async () => {
    const world = await createLocalWorld({ root: sensorRepository() });
    const call = { actorId: "observer", packageId: "sensor-net", operationId: "reading" };
    try {
      expect(world.metadata().virtualTimeUs).toBe(10);
      expect(world.scheduledEvents("pending")).toMatchObject([{ dueUs: 30 }]);
      expect(world.call(call).outcome).toMatchObject({ value: { count: 0 } });
      world.advanceTime(30);
      expect(world.call(call).outcome).toMatchObject({ value: { count: 42 } });
      expect(world.scheduledEvents("pending")).toEqual([]);
      world.reset();
      expect(world.metadata().virtualTimeUs).toBe(10);
      expect(world.scheduledEvents("pending")).toMatchObject([{ dueUs: 30 }]);
      expect(world.call(call).outcome).toMatchObject({ value: { count: 0 } });
      world.advanceTime(30);
      expect(world.call(call).outcome).toMatchObject({ value: { count: 42 } });
    } finally {
      world.close();
    }
  });

  it("keeps HTTP, MCP, and CLI actor bindings usable across full and package resets without widening grants", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    const binding = await world.listen();
    if (binding.http === undefined || binding.mcp === undefined || binding.cli === undefined)
      throw new Error("default listeners missing");
    const initialConnection = JSON.stringify(binding.environment);
    try {
      expect(binding.actorId).toBe("clerk");
      expect(Object.keys(binding).sort()).toEqual([
        "actorId",
        "apps",
        "cli",
        "close",
        "environment",
        "http",
        "mcp",
        "worldInstanceId",
      ]);
      expect(binding.apps).toEqual([]);
      expect(binding.worldInstanceId).toBe(world.metadata().worldInstanceId);
      expect((await fetch(`${binding.http.url}/v1/tools`)).status).toBe(401);
      expect((await fetch(binding.mcp.url, { method: "POST", body: "{}" })).status).toBe(401);
      expect(await httpCall(binding.http, "reserve", { count: 2 }, "stable-id")).toMatchObject({
        status: 200,
        body: { outcome: { value: { count: 5 } } },
      });
      expect(await mcpCall(binding.mcp, "read")).toMatchObject({
        status: 200,
        body: { result: { structuredContent: { count: 5 } } },
      });
      for (const scope of [undefined, { packages: ["stockroom"] }]) {
        world.reset(scope);
        expect(JSON.stringify(binding.environment)).toBe(initialConnection);
        expect((await httpCall(binding.http, "read")).body).toMatchObject({
          outcome: { value: { count: 7 } },
        });
        expect((await mcpCall(binding.mcp, "reserve", { count: 1 })).body).toMatchObject({
          result: { structuredContent: { count: 6 } },
        });
        expect(await httpCall(binding.http, "erase")).toMatchObject({
          status: 403,
          body: { outcome: { status: "denied" } },
        });
        expect((await mcpCall(binding.mcp, "erase")).body).toMatchObject({
          result: { isError: true, structuredContent: { status: "denied" } },
        });
        expect(
          (
            await invokeCliWorldOperation({
              environment: binding.environment,
              packageId: "stockroom",
              operationId: "read",
            })
          ).outcome,
        ).toMatchObject({ status: "ok", value: { count: 6 } });
      }
      // A full reset must not replay an old-generation result for the same explicit key.
      world.reset();
      expect((await httpCall(binding.http, "reserve", { count: 3 }, "stable-id")).body).toMatchObject({
        outcome: { status: "ok", value: { count: 4 } },
      });
      await binding.close();
      await binding.close();
      expect(
        world.call({ actorId: "clerk", packageId: "stockroom", operationId: "read" }).outcome.status,
      ).toBe("ok");
    } finally {
      world.close();
      await binding.close();
    }
  });

  it("keeps named-scenario actor denials through listener resets", async () => {
    const world = await createLocalWorld({ root: stockRepository(), scenario: "audit" });
    const binding = await world.listen({ protocols: ["http", "mcp"] });
    if (binding.http === undefined || binding.mcp === undefined) throw new Error("listeners missing");
    try {
      for (const scope of [undefined, { packages: ["stockroom"] }]) {
        world.reset(scope);
        expect((await httpCall(binding.http, "reserve", { count: 1 }, "not-allowed")).status).toBe(403);
        expect((await mcpCall(binding.mcp, "reserve", { count: 1 })).body).toMatchObject({
          result: { isError: true, structuredContent: { status: "denied" } },
        });
        expect(world.state({ packageId: "stockroom", namespace: "stock" })[0]?.value).toEqual({ count: 19 });
      }
    } finally {
      world.close();
      await binding.close();
    }
  });

  it("rejects invalid selection before creating a retained world", async () => {
    const root = stockRepository();
    for (const input of [
      { drill: "missing", scenario: "audit" },
      { scenario: "../bad" },
      { drill: "" },
      { maxToolCalls: 0 },
      { maxToolCalls: 1_000_001 },
    ])
      await expect(createLocalWorld({ root, ...input })).rejects.toMatchObject({
        code: "framework.INVALID_ARGUMENT",
      });
    await expect(createLocalWorld({ root, scenario: "missing" })).rejects.toMatchObject({
      code: "framework.SCENARIO_NOT_FOUND",
    });
    await expect(createLocalWorld({ root, drill: "missing" })).rejects.toMatchObject({
      code: "framework.DRILL_NOT_FOUND",
    });
  });

  it("never invents actors or grants and requires selection with multiple actors", async () => {
    const emptyWorld = await createLocalWorld({ root: calculatorRepository([]) });
    const multiple = await createLocalWorld({ root: calculatorRepository([{ id: "one" }, { id: "two" }]) });
    let binding: LocalWorldBinding | undefined;
    try {
      expect(emptyWorld.describe().actors).toEqual([]);
      await expect(emptyWorld.listen()).rejects.toThrow("has no actor");
      await expect(multiple.listen()).rejects.toMatchObject({ code: "framework.INVALID_ARGUMENT" });
      await expect(multiple.listen({ actorId: "missing" })).rejects.toMatchObject({
        code: "framework.INVALID_ARGUMENT",
      });
      binding = await multiple.listen({ actorId: "one", protocols: ["cli"] });
      expect(binding.http).toBeUndefined();
      expect(binding.mcp).toBeUndefined();
      expect(
        (
          await invokeCliWorldOperation({
            environment: binding.environment,
            packageId: "calculator",
            operationId: "convert",
            arguments: { count: 1 },
          })
        ).outcome.status,
      ).toBe("denied");
    } finally {
      emptyWorld.close();
      multiple.close();
      await binding?.close();
    }
  });

  it("validates protocols and loopback ports without starting listeners", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    try {
      const invalid: unknown[] = [
        { protocols: [] },
        { protocols: null },
        { protocols: ["http", "http"] },
        { protocols: ["smtp"] },
        { httpPort: -1 },
        { mcpPort: 65536 },
        { cliPort: 1.5 },
        { protocols: ["mcp"], httpPort: 0 },
        { hostname: "0.0.0.0" },
        { actorId: null },
      ];
      for (const options of invalid)
        await expect(world.listen(options as LocalWorldListenOptions)).rejects.toMatchObject({
          code: "framework.INVALID_ARGUMENT",
        });
    } finally {
      world.close();
    }
  });

  it("rolls back already-started listeners after a later port collision", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    const port = await freePort();
    try {
      await expect(
        world.listen({ protocols: ["http", "mcp"], httpPort: port, mcpPort: port }),
      ).rejects.toMatchObject({
        code: "framework.INTERNAL_ERROR",
        details: { protocol: "mcp", code: "EADDRINUSE" },
      });
      await assertPortReleased(port);
      const binding = await world.listen({ protocols: ["http"], httpPort: port });
      await binding.close();
      await assertPortReleased(port);
    } finally {
      world.close();
    }
  });

  it("closing during asynchronous startup revokes immediately and does not leak the late listener", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    const port = await freePort();
    const starting = world.listen({ httpPort: port });
    world.close();
    expect(() => world.call({ actorId: "clerk", packageId: "stockroom", operationId: "read" })).toThrow(
      "closed",
    );
    await expect(starting).rejects.toMatchObject({ code: "framework.WORLD_CLOSED" });
    await expect(world.listen()).rejects.toMatchObject({ code: "framework.WORLD_CLOSED" });
    await assertPortReleased(port);
  });

  it("resolves current actor clients when reset happens while listeners are still starting", async () => {
    const world = await createLocalWorld({ root: stockRepository() });
    const starting = world.listen();
    world.reset();
    const binding = await starting;
    try {
      if (binding.http === undefined || binding.mcp === undefined) throw new Error("listeners missing");
      expect(
        (await httpCall(binding.http, "reserve", { count: 2 }, "after-startup-reset")).body,
      ).toMatchObject({ outcome: { status: "ok", value: { count: 5 } } });
      expect((await mcpCall(binding.mcp, "read")).body).toMatchObject({
        result: { structuredContent: { count: 5 } },
      });
    } finally {
      world.close();
      await binding.close();
    }
  });
});
