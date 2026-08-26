import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorld, type FiredrillProjectError } from "../src/index.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-local-world-"));
  directories.push(directory);
  return directory;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function repository(): string {
  const root = temporaryDirectory();
  const world = join(root, "world");
  mkdirSync(world);
  writeJson(join(root, "firedrill.json"), {
    schemaVersion: 1,
    sourceRoot: "world",
    world: "world.json",
  });
  writeJson(join(world, "world.json"), {
    schemaVersion: 1,
    id: "local-world-fixture",
    seed: "31",
    actors: [
      {
        id: "operator",
        grants: [
          { packageId: "inventory", operationId: "items.update" },
          { packageId: "notifications", operationId: "messages.send" },
        ],
      },
    ],
    state: [],
  });
  writeJson(join(world, "inventory.tool.json"), {
    schemaVersion: 1,
    module: "./inventory.js",
    manifest: {
      schemaVersion: 1,
      id: "inventory",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [
        {
          namespace: "items",
          schema: {
            type: "object",
            required: ["quantity"],
            properties: { quantity: { type: "integer" } },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "items.update",
          inputSchema: {
            type: "object",
            required: ["quantity"],
            properties: { quantity: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["quantity"],
            properties: { quantity: { type: "integer" } },
            additionalProperties: false,
          },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
  });
  writeFileSync(
    join(world, "inventory.js"),
    'export default { operations: { "items.update": (input, context) => { const value = { quantity: Number(input.quantity) }; context.state.put("items", "primary", value); return value; } } };\n',
  );
  writeJson(join(world, "notifications.tool.json"), {
    schemaVersion: 1,
    module: "./notifications.js",
    manifest: {
      schemaVersion: 1,
      id: "notifications",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [
        {
          namespace: "messages",
          schema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "messages.send",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
  });
  writeFileSync(
    join(world, "notifications.js"),
    'export default { operations: { "messages.send": (input, context) => { const value = { text: String(input.text) }; context.state.put("messages", "primary", value); return value; } } };\n',
  );
  writeJson(join(world, "agent.target.json"), {
    schemaVersion: 1,
    target: {
      id: "agent-under-test",
      kind: "external",
      bindings: ["direct"],
      timeoutMs: 5_000,
    },
  });
  writeJson(join(world, "state-reset.drill.json"), {
    schemaVersion: 1,
    id: "state-reset",
    targetId: "agent-under-test",
    actorId: "operator",
    inlineScenario: {
      virtualTimeUs: 1_000,
      actors: [
        {
          id: "operator",
          grants: [
            { packageId: "inventory", operationId: "items.update" },
            { packageId: "notifications", operationId: "messages.send" },
          ],
        },
      ],
      state: [
        {
          action: "upsert",
          packageId: "inventory",
          namespace: "items",
          rowId: "primary",
          value: { quantity: 0 },
        },
        {
          action: "upsert",
          packageId: "notifications",
          namespace: "messages",
          rowId: "primary",
          value: { text: "baseline" },
        },
      ],
    },
    task: { instruction: "Exercise the controlled world." },
    assertions: [
      {
        id: "inventory-present",
        kind: "state.value",
        packageId: "inventory",
        namespace: "items",
        rowId: "primary",
        path: ["quantity"],
        comparison: { operator: "greater_than_or_equal", value: 0 },
      },
    ],
  });
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createLocalWorld", () => {
  it("controls, inspects, scopes, and fully resets a repository world through the public SDK", async () => {
    const root = repository();
    const world = await createLocalWorld({ root, drill: "state-reset", seed: "41" });

    expect(world.describe()).toMatchObject({
      drillId: "state-reset",
      actors: [{ actorId: "operator" }],
      tools: [{ packageId: "inventory" }, { packageId: "notifications" }],
    });
    expect(existsSync(world.worldFilePath)).toBe(true);
    expect(existsSync(world.baselineFilePath)).toBe(true);
    expect(world.directoryPath.startsWith(join(root, ".firedrill", "worlds"))).toBe(true);

    expect(
      world.call({
        actorId: "operator",
        packageId: "inventory",
        operationId: "items.update",
        arguments: { quantity: 7 },
        idempotencyKey: "inventory-1",
      }).outcome,
    ).toEqual({ status: "ok", value: { quantity: 7 } });
    expect(
      world.call({
        actorId: "operator",
        packageId: "notifications",
        operationId: "messages.send",
        arguments: { text: "changed" },
        idempotencyKey: "message-1",
      }).outcome,
    ).toEqual({ status: "ok", value: { text: "changed" } });
    world.advanceTime(9_000);

    const scoped = world.reset({ packages: ["inventory", "inventory"] });
    expect(scoped).toMatchObject({
      scope: "packages",
      packages: ["inventory"],
      stateChanges: 1,
      metadata: { virtualTimeUs: 9_000 },
    });
    expect(world.state({ packageId: "inventory", namespace: "items" })[0]?.value).toEqual({
      quantity: 0,
    });
    expect(world.state({ packageId: "notifications", namespace: "messages" })[0]?.value).toEqual({
      text: "changed",
    });
    expect(
      world.call({
        actorId: "operator",
        packageId: "inventory",
        operationId: "items.update",
        arguments: { quantity: 9 },
        idempotencyKey: "inventory-1",
      }).outcome,
    ).toEqual({ status: "ok", value: { quantity: 9 } });
    expect(
      world
        .evidence()
        .some(
          (entry) =>
            entry.kind === "lifecycle" &&
            entry.action === "world_reset" &&
            entry.details?.scope === "packages",
        ),
    ).toBe(true);

    const reset = world.reset();
    expect(reset).toMatchObject({ scope: "world", metadata: { virtualTimeUs: 1_000 } });
    expect(world.state({ packageId: "inventory", namespace: "items" })[0]?.value).toEqual({
      quantity: 0,
    });
    expect(world.state({ packageId: "notifications", namespace: "messages" })[0]?.value).toEqual({
      text: "baseline",
    });
    expect(world.evidence().filter((entry) => entry.kind === "operation")).toHaveLength(0);
    expect(world.evidence().at(-1)).toMatchObject({ kind: "lifecycle", action: "world_reset" });

    world.close();
    world.close();
    expect(() => world.metadata()).toThrow(
      expect.objectContaining({ code: "framework.WORLD_CLOSED" }) satisfies Partial<FiredrillProjectError>,
    );
  });

  it("rejects an unknown scoped Tool without changing the active world", async () => {
    const root = repository();
    const world = await createLocalWorld({ root, drill: "state-reset" });
    const beforeState = world.state({ packageId: "inventory", namespace: "items" });
    const beforeEvidence = world.evidence();

    expect(() => world.reset({ packages: ["missing-tool"] })).toThrow(
      expect.objectContaining({ code: "framework.TOOL_NOT_FOUND" }) satisfies Partial<FiredrillProjectError>,
    );
    expect(world.state({ packageId: "inventory", namespace: "items" })).toEqual(beforeState);
    expect(world.evidence()).toEqual(beforeEvidence);
    world.close();
  });

  it("refuses to overwrite an explicitly selected directory", async () => {
    const root = repository();
    const destination = join(root, "existing-world");
    mkdirSync(destination);

    await expect(
      createLocalWorld({ root, drill: "state-reset", directory: destination }),
    ).rejects.toMatchObject({ code: "framework.INVALID_ARGUMENT" } satisfies Partial<FiredrillProjectError>);
  });
});
