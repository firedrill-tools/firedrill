import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CliWorldError,
  invokeCliWorldOperation,
  listCliWorldTools,
  startCliWorldBinding,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function world() {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-cli-protocol-"));
  directories.push(directory);
  const tool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "counter",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "values", schema: { type: "object" } }],
      operations: [
        {
          id: "values.add",
          description: "Add to the counter",
          inputSchema: {
            type: "object",
            required: ["amount"],
            properties: { amount: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: { type: "object" },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
    operations: {
      "values.add": (input, context) => {
        const value = Number(context.state.get("values", "main")?.value ?? 0) + Number(input.amount);
        context.state.put("values", "main", { value });
        return { value };
      },
    },
  });
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_cli0001",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "7",
    virtualTimeUs: 0,
    correlationId: "corr_create001",
    actors: [
      {
        bindingId: "actor_cli0001",
        actorId: "operator",
        grants: [{ packageId: "counter", operationId: "values.add" }],
      },
    ],
  });
  const kernel = new WorldKernel({ store, packageLockHash: HASH_B, tools: [tool] });
  const client = new BoundWorldClient({
    kernel,
    actorBindingId: "actor_cli0001",
    namespace: "run_cli0001",
  });
  return { tool, store, client };
}

describe("CLI world protocol", () => {
  it("discovers and invokes the same stateful operations through binding environment", async () => {
    const fixture = world();
    const binding = await startCliWorldBinding({
      client: fixture.client,
      tools: [fixture.tool.manifest],
      token: "test-cli-token-000000001",
    });
    try {
      const tools = await listCliWorldTools({ environment: binding.environment });
      expect(tools).toMatchObject([
        { id: "counter", operations: [{ id: "values.add", fidelity: "stateful" }] },
      ]);

      const result = await invokeCliWorldOperation({
        packageId: "counter",
        operationId: "values.add",
        arguments: { amount: 9 },
        idempotencyKey: "add-nine",
        environment: binding.environment,
      });

      expect(result.outcome).toEqual({ status: "ok", value: { value: 9 } });
      expect(fixture.store.readState("counter", "values", "main")?.value).toEqual({ value: 9 });
      expect(binding.environment).toEqual({
        FIREDRILL_CLI_URL: binding.baseUrl,
        FIREDRILL_CLI_TOKEN: binding.token,
      });
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });

  it("fails clearly outside an active drill binding", async () => {
    await expect(listCliWorldTools({ environment: {} })).rejects.toMatchObject({
      name: "CliWorldError",
      code: "framework.CLI_BINDING_MISSING",
    } satisfies Partial<CliWorldError>);
  });
});
