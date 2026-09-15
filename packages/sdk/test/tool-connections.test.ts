import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorld } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-connection-recipes-"));
  roots.push(root);
  mkdirSync(join(root, "world"));
  writeFileSync(
    join(root, "firedrill.json"),
    JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }),
  );
  writeFileSync(
    join(root, "world", "world.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "records-world",
      actors: [{ id: "operator", grants: [{ packageId: "records", operationId: "items.update" }] }],
    }),
  );
  writeFileSync(
    join(root, "world", "records.tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      module: "./records.js",
      manifest: {
        schemaVersion: 1,
        id: "records",
        version: "1.0.0",
        engine: ">=0.1.0",
        capabilities: ["state.read", "state.write"],
        state: [{ namespace: "items", schema: { type: "object" } }],
        operations: [
          {
            id: "items.update",
            inputSchema: {
              type: "object",
              properties: { value: { type: "integer" } },
              required: ["value"],
              additionalProperties: false,
            },
            outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
            idempotency: "none",
            fidelity: "stateful",
            mcp: {
              name: "RECORDS_UPDATE_v2",
              description: "Update a record using the existing client contract",
            },
          },
        ],
        connections: [
          {
            id: "http-client",
            title: "HTTP client",
            protocol: "http",
            environment: { CLIENT_API_URL: "FIREDRILL_HTTP_URL" },
          },
          {
            id: "mcp-client",
            title: "MCP client",
            protocol: "mcp",
            environment: { CLIENT_MCP_URL: "FIREDRILL_MCP_URL", CLIENT_MCP_TOKEN: "FIREDRILL_MCP_TOKEN" },
            instructions: "Pass these values only to a test process.",
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(root, "world", "records.js"),
    'export default { operations: { "items.update": (input, context) => { const value = { value: input.value }; context.state.put("items", "main", value); return value; } } };\n',
  );
  return root;
}

describe("exact MCP aliases and resolved connection recipes", () => {
  it("connects a real unmodified MCP client by a package recipe, retains exact names, and changes the real synthetic state", async () => {
    const root = repository();
    const world = await createLocalWorld({ root });
    const binding = await world.listen({ protocols: ["mcp"] });
    const client = new Client({ name: "external-client", version: "1.0.0" });
    try {
      const definitions = world.describe().tools[0]?.connections;
      expect(definitions).toHaveLength(2);
      expect(definitions?.[1]?.environment.CLIENT_MCP_TOKEN).toBe("FIREDRILL_MCP_TOKEN");
      expect(binding.connections).toHaveLength(1);
      const connection = binding.connections?.[0];
      if (connection === undefined) throw new Error("Missing connection recipe");
      expect(connection).toMatchObject({ packageId: "records", id: "mcp-client", protocol: "mcp" });
      expect(binding.environment).not.toHaveProperty("CLIENT_MCP_TOKEN");
      expect(connection.environment.CLIENT_MCP_TOKEN).toBe(binding.mcp?.token);
      const url = connection.environment.CLIENT_MCP_URL;
      const token = connection.environment.CLIENT_MCP_TOKEN;
      if (url === undefined || token === undefined) throw new Error("Recipe not resolved");
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(["records.items.update", "RECORDS_UPDATE_v2"]);
      const result = await client.callTool({ name: "RECORDS_UPDATE_v2", arguments: { value: 42 } });
      expect(result.structuredContent).toEqual({ value: 42 });
      expect(world.state({ packageId: "records", namespace: "items" })[0]?.value).toEqual({ value: 42 });
      const canonical = await client.callTool({ name: "records.items.update", arguments: { value: 43 } });
      expect(canonical.structuredContent).toEqual({ value: 43 });
      expect(world.state({ packageId: "records", namespace: "items" })[0]?.value).toEqual({ value: 43 });
      const operations = world.evidence().filter((entry) => entry.kind === "operation");
      expect(operations).toHaveLength(2);
      expect(operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invocation: expect.objectContaining({
              operation: { packageId: "records", operationId: "items.update" },
            }),
          }),
        ]),
      );
      world.reset();
      expect(binding.connections?.[0]).toEqual(connection);
    } finally {
      await client.close();
      await binding.close();
      world.close();
    }
  });

  it("rejects cross-package aliases that steal canonical tool names before creating listeners", async () => {
    const root = repository();
    const path = join(root, "world", "records.tool.json");
    const source = JSON.parse(readFileSync(path, "utf8")) as {
      manifest: { id: string; connections: unknown[]; operations: Array<{ mcp: { name: string } }> };
    };
    const other = structuredClone(source);
    other.manifest.id = "secondary";
    const operation = source.manifest.operations[0];
    const otherOperation = other.manifest.operations[0];
    if (operation === undefined || otherOperation === undefined) throw new Error("Missing fixture operation");
    operation.mcp.name = "secondary.items.update";
    otherOperation.mcp.name = "SECONDARY_UPDATE";
    writeFileSync(path, JSON.stringify(source));
    writeFileSync(join(root, "world", "secondary.tool.json"), JSON.stringify(other));
    await expect(createLocalWorld({ root })).rejects.toMatchObject({
      code: "framework.SOURCE_INVALID",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("MCP alias conflicts") }),
      ]),
    });
  });
});
