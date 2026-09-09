import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, ToolFailure } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { mcpToolName, startMcpWorldBinding } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const directories: string[] = [];

function world() {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-mcp-test-"));
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
          declaredErrors: ["NEGATIVE_POINTS"],
          idempotency: "required",
          fidelity: "stateful",
        },
        {
          id: "scores.labels",
          description: "List score labels",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "array", items: { type: "string" } },
          declaredErrors: [],
          idempotency: "none",
          fidelity: "contract",
        },
        {
          id: "scores.total",
          description: "Read the total score",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "integer" },
          declaredErrors: [],
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
    },
    operations: {
      "scores.add": (input, context) => {
        const points = Number(input.points);
        if (points < 0) {
          throw new ToolFailure({
            code: "NEGATIVE_POINTS",
            message: "points cannot be negative",
          });
        }
        const score = Number(context.state.get("scores", "main")?.score ?? 0) + points;
        context.state.put("scores", "main", { score });
        return { score };
      },
      "scores.labels": () => ["main", "bonus"],
      "scores.total": (_input, context) => Number(context.state.get("scores", "main")?.score ?? 0),
    },
  });
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_mcp000001",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "7",
    virtualTimeUs: 0,
    correlationId: "corr_create002",
    actors: [
      {
        bindingId: "actor_mcp000001",
        actorId: "operator",
        grants: [
          { packageId: "scoreboard", operationId: "scores.add" },
          { packageId: "scoreboard", operationId: "scores.labels" },
          { packageId: "scoreboard", operationId: "scores.total" },
        ],
      },
    ],
  });
  const kernel = new WorldKernel({ store, packageLockHash: HASH_B, tools: [tool] });
  const client = new BoundWorldClient({
    kernel,
    actorBindingId: "actor_mcp000001",
    namespace: "run_mcp000001",
  });
  return { tool, store, client };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-mcp-test-`)) {
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

function postRaw(url: URL, token: string, body: Buffer, contentLength?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
        },
      },
      (response) => {
        settled = true;
        const status = response.statusCode ?? 0;
        response.on("error", reject);
        response.resume();
        response.on("end", () => resolve(status));
      },
    );
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

describe("MCP world binding", () => {
  it("rejects canonical/alias and alias/alias collisions before opening a server", async () => {
    const fixture = world();
    const first = {
      ...fixture.tool.manifest,
      operations: fixture.tool.manifest.operations.map((operation) => ({
        ...operation,
        ...(operation.id === "scores.add" ? { mcp: { name: "other.scores.total" } } : {}),
      })),
    };
    const other = { ...fixture.tool.manifest, id: "other" };
    try {
      await expect(startMcpWorldBinding({ client: fixture.client, tools: [first, other] })).rejects.toThrow(
        "duplicate MCP tool name other.scores.total",
      );
      const aliases = {
        ...first,
        operations: first.operations.map((operation) => ({ ...operation, mcp: { name: "SAME" } })),
      };
      await expect(startMcpWorldBinding({ client: fixture.client, tools: [aliases] })).rejects.toThrow(
        "duplicate MCP tool name SAME",
      );
    } finally {
      fixture.store.close();
    }
  });
  it("lists and executes declared operations through the official MCP client", async () => {
    const fixture = world();
    const binding = await startMcpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool.manifest],
      token: "test-mcp-token-000000001",
    });
    const mcp = new Client(
      { name: "firedrill-binding-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      const transport = new StreamableHTTPClientTransport(new URL(binding.url), {
        authProvider: { token: async () => binding.token },
      });
      await mcp.connect(transport);

      const name = mcpToolName("scoreboard", "scores.add");
      const listed = await mcp.listTools();
      expect(listed.tools.find((tool) => tool.name === name)).toMatchObject({
        name,
        description: "Add points to one score",
        inputSchema: { type: "object", required: ["points"] },
      });

      const params = {
        name,
        arguments: { points: 6 },
        _meta: { "dev.firedrill/idempotency-key": "scoreboard-add-six" },
      };
      const first = await mcp.callTool(params);
      const replay = await mcp.callTool(params);
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toEqual({ score: 6 });
      expect(replay.structuredContent).toEqual({ score: 6 });
      expect(fixture.store.readState("scoreboard", "scores", "main")?.value).toEqual({ score: 6 });

      const labels = await mcp.callTool({
        name: mcpToolName("scoreboard", "scores.labels"),
        arguments: {},
      });
      const total = await mcp.callTool({
        name: mcpToolName("scoreboard", "scores.total"),
        arguments: {},
      });
      expect(labels.structuredContent).toEqual(["main", "bonus"]);
      expect(total.structuredContent).toBe(6);

      const failed = await mcp.callTool({ name, arguments: { points: -1 } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        status: "tool_error",
        error: { code: "tool.NEGATIVE_POINTS", retryable: false },
      });
      expect(binding.environment).toEqual({
        FIREDRILL_MCP_URL: binding.url,
        FIREDRILL_MCP_TOKEN: binding.token,
      });
    } finally {
      await mcp.close();
      await binding.close();
      fixture.store.close();
    }
  });

  it("rejects missing credentials and non-loopback Host headers before tool dispatch", async () => {
    const fixture = world();
    const binding = await startMcpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool.manifest],
      token: "test-mcp-token-000000002",
    });
    const unauthorized = new Client({ name: "unauthorized-test", version: "1.0.0" });
    try {
      await expect(
        unauthorized.connect(new StreamableHTTPClientTransport(new URL(binding.url))),
      ).rejects.toThrow();
      expect(await requestWithHost(new URL(binding.url), "attacker.example")).toBe(403);
      expect(fixture.client.callsIssued()).toBe(0);
    } finally {
      await unauthorized.close();
      await binding.close();
      fixture.store.close();
    }
  });

  it("rejects declared and streamed request bodies larger than 1 MiB before MCP dispatch", async () => {
    const fixture = world();
    const binding = await startMcpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool.manifest],
      token: "test-mcp-token-000000003",
    });
    try {
      const url = new URL(binding.url);
      const oversized = Buffer.alloc(1024 * 1024 + 1, 32);
      expect(await postRaw(url, binding.token, oversized, oversized.length)).toBe(413);
      expect(await postRaw(url, binding.token, oversized)).toBe(413);
      expect(fixture.client.callsIssued()).toBe(0);
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });

  it("closes while an MCP client still holds an active transport", async () => {
    const fixture = world();
    const binding = await startMcpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool.manifest],
      token: "test-mcp-token-000000004",
    });
    const mcp = new Client({ name: "active-close-test", version: "1.0.0" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(binding.url), {
          authProvider: { token: async () => binding.token },
        }),
      );
      await expect(
        Promise.race([
          binding.close().then(() => "closed"),
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("timed-out"), 1_000);
          }),
        ]),
      ).resolves.toBe("closed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await mcp.close().catch(() => undefined);
      await binding.close();
      fixture.store.close();
    }
  });
});
