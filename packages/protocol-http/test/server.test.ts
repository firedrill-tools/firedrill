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
            required: ["points"],
            properties: { points: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["score"],
            properties: { score: { type: "integer" } },
            additionalProperties: false,
          },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
    operations: {
      "scores.add": (input, context) => {
        const score = Number(context.state.get("scores", "main")?.score ?? 0) + Number(input.points);
        context.state.put("scores", "main", { score });
        return { score };
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
      tools: [fixture.tool.manifest],
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

      const called = await fetch(`${binding.baseUrl}/v1/operations/scoreboard/scores.add`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ arguments: { points: 6 }, idempotencyKey: "add-six" }),
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
      tools: [fixture.tool.manifest],
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
});
