import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpWorldBinding } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const directories: string[] = [];

function world() {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-http-test-"));
  directories.push(directory);
  const tool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "scoreboard",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "scores", schema: { type: "object" } }],
      operations: [
        {
          id: "scores.add",
          description: "Add points to one score",
          inputSchema: {
            type: "object",
            required: ["board", "points"],
            properties: { board: { type: "string" }, points: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["score"],
            properties: { score: { type: "integer" } },
            additionalProperties: false,
          },
          declaredErrors: ["BOARD_LOCKED"],
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
      http: [
        {
          id: "add-score",
          operationId: "scores.add",
          method: "POST",
          path: "/api/boards/{board}/scores",
          auth: { kind: "header", name: "x-api-key" },
          requestBody: "json",
          response: {
            successStatus: 201,
            errors: [{ code: "BOARD_LOCKED", status: 409 }],
          },
        },
      ],
    },
    operations: {
      "scores.add": (input, context) => {
        const board = String(input.board);
        if (board === "locked") {
          context.fail({
            code: "BOARD_LOCKED",
            message: "this board no longer accepts scores",
          });
        }
        const score = Number(context.state.get("scores", board)?.score ?? 0) + Number(input.points);
        context.state.put("scores", board, { score });
        return { score };
      },
    },
    http: {
      "add-score": {
        decode: (request) => {
          if (request.headers["x-api-key"] !== undefined) {
            throw new TypeError("the route credential must not be exposed to the codec");
          }
          const payload =
            request.body.kind === "json" &&
            typeof request.body.value === "object" &&
            request.body.value !== null &&
            !Array.isArray(request.body.value)
              ? request.body.value
              : undefined;
          if (typeof payload?.delta !== "number" || !Number.isSafeInteger(payload.delta)) {
            throw new TypeError("delta must be an integer");
          }
          const idempotencyKey = request.headers["idempotency-key"]?.[0];
          return {
            arguments: { board: request.path.board ?? "", points: payload.delta },
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          };
        },
        encode: ({ outcome }) => ({
          headers: { "x-synthetic-service": "scoreboard" },
          body:
            outcome.status === "ok"
              ? {
                  kind: "json",
                  value: {
                    total:
                      typeof outcome.value === "object" &&
                      outcome.value !== null &&
                      !Array.isArray(outcome.value)
                        ? (outcome.value.score ?? null)
                        : null,
                  },
                }
              : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
        }),
      },
    },
  });
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_http0001",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "4",
    virtualTimeUs: 0,
    correlationId: "corr_create001",
    actors: [
      {
        bindingId: "actor_http0001",
        actorId: "operator",
        grants: [{ packageId: "scoreboard", operationId: "scores.add" }],
      },
    ],
  });
  const kernel = new WorldKernel({ store, packageLockHash: HASH_B, tools: [tool] });
  const client = new BoundWorldClient({
    kernel,
    actorBindingId: "actor_http0001",
    namespace: "run_http0001",
  });
  return { tool, store, client };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-http-test-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function requestWithHost(url: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: "/health",
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("HTTP world binding", () => {
  it("lists and executes declared operations through the bound actor", async () => {
    const fixture = world();
    const binding = await startHttpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool],
      token: "test-world-token-00000001",
    });
    try {
      const unauthorized = await fetch(`${binding.baseUrl}/v1/tools`);
      expect(unauthorized.status).toBe(401);
      expect(fixture.client.callsIssued()).toBe(0);

      const listed = await fetch(`${binding.baseUrl}/v1/tools`, {
        headers: { authorization: `Bearer ${binding.token}` },
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        tools: [{ id: "scoreboard", operations: [{ id: "scores.add" }] }],
      });

      const oversized = await fetch(`${binding.baseUrl}/v1/operations/scoreboard/scores.add`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ arguments: { board: "main", padding: "x".repeat(1024 * 1024) } }),
      });
      expect(oversized.status).toBe(413);
      expect(fixture.client.callsIssued()).toBe(0);

      const called = await fetch(`${binding.baseUrl}/v1/operations/scoreboard/scores.add`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ arguments: { board: "main", points: 6 }, idempotencyKey: "add-six" }),
      });
      expect(called.status).toBe(200);
      expect(await called.json()).toMatchObject({ outcome: { status: "ok", value: { score: 6 } } });
      expect(fixture.store.readState("scoreboard", "scores", "main")?.value).toEqual({ score: 6 });
      expect(binding.environment).toEqual({
        FIREDRILL_HTTP_URL: binding.baseUrl,
        FIREDRILL_HTTP_TOKEN: binding.token,
      });
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });

  it("rejects non-loopback Host headers before routing", async () => {
    const fixture = world();
    const binding = await startHttpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool],
      token: "test-world-token-00000002",
    });
    try {
      expect(await requestWithHost(new URL(binding.baseUrl), "attacker.example")).toBe(421);
      expect(fixture.client.callsIssued()).toBe(0);
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });

  it("maps a provider-shaped request and response around the same semantic operation", async () => {
    const fixture = world();
    const binding = await startHttpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool],
      token: "test-world-token-00000003",
    });
    try {
      const unauthorized = await fetch(`${binding.baseUrl}/api/boards/west/scores`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: 4 }),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBeNull();
      expect(await unauthorized.json()).toMatchObject({ code: "framework.HTTP_UNAUTHORIZED" });
      expect(fixture.client.callsIssued()).toBe(0);

      const malformed = await fetch(`${binding.baseUrl}/api/boards/west/scores`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "missing-delta",
          "x-api-key": binding.token,
        },
        body: JSON.stringify({}),
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "framework.HTTP_REQUEST_MAPPING_FAILED" });
      expect(fixture.client.callsIssued()).toBe(0);

      const unsupported = await fetch(`${binding.baseUrl}/api/boards/west/scores`, {
        headers: { "x-api-key": binding.token },
      });
      expect(unsupported.status).toBe(405);
      expect(unsupported.headers.get("allow")).toBe("POST");
      expect(await unsupported.json()).toMatchObject({ code: "framework.HTTP_METHOD_NOT_ALLOWED" });
      expect(fixture.client.callsIssued()).toBe(0);

      const called = await fetch(`${binding.baseUrl}/api/boards/west/scores?source=agent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "west-add-four",
          "x-api-key": binding.token,
        },
        body: JSON.stringify({ delta: 4 }),
      });
      expect(called.status).toBe(201);
      expect(called.headers.get("x-synthetic-service")).toBe("scoreboard");
      expect(await called.json()).toEqual({ total: 4 });
      expect(fixture.store.readState("scoreboard", "scores", "west")?.value).toEqual({ score: 4 });
      expect(fixture.client.callsIssued()).toBe(1);

      const rejected = await fetch(`${binding.baseUrl}/api/boards/locked/scores`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "locked-add-four",
          "x-api-key": binding.token,
        },
        body: JSON.stringify({ delta: 4 }),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: "this board no longer accepts scores" });
      expect(fixture.store.readState("scoreboard", "scores", "locked")).toBeNull();
      expect(fixture.client.callsIssued()).toBe(2);
      expect(fixture.store.readEvidence().at(-1)).toMatchObject({
        kind: "operation",
        outcome: {
          status: "tool_error",
          error: { code: "tool.BOARD_LOCKED" },
        },
      });
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });
});
