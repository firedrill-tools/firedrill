import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorld } from "@firedrill/compiler";
import { afterEach, describe, expect, it } from "vitest";
import { captureScenarioState, createLocalWorld, type ScenarioStateReader } from "../src/index.js";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-scenario-capture-"));
  directories.push(root);
  const json = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
  mkdirSync(join(root, "world"));
  json("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  json("world/world.json", {
    schemaVersion: 1,
    id: "capture-fixture",
    actors: [
      {
        id: "worker",
        grants: [
          { packageId: "records", operationId: "put" },
          { packageId: "records", operationId: "remove" },
        ],
      },
    ],
    state: [
      { action: "upsert", packageId: "records", namespace: "items", rowId: "initial", value: { count: 3 } },
    ],
  });
  json("world/records.tool.json", {
    schemaVersion: 1,
    module: "./behavior.js",
    manifest: {
      schemaVersion: 1,
      id: "records",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [
        {
          namespace: "items",
          schema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
      ],
      operations: ["put", "remove"].map((id) => ({
        id,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        idempotency: "none",
        fidelity: "stateful",
      })),
    },
  });
  writeFileSync(
    join(root, "world/behavior.js"),
    'export default {operations: {put(input, context) {context.state.put("items", input.id, {count: input.count}); return {};}, remove(input, context) {context.state.delete("items", input.id); return {};}}};',
  );
  return { root, json };
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("repository-owned data scenario capture", () => {
  it("exports the same source through a read-only adapter without requiring a LocalWorld", async () => {
    const { root } = fixture();
    const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
    expect(compiled.status).toBe("success");
    if (compiled.status !== "success") throw new Error("fixture did not compile");
    const world = await createLocalWorld({ root });
    try {
      world.call({
        actorId: "worker",
        packageId: "records",
        operationId: "remove",
        arguments: { id: "initial" },
      });
      world.call({
        actorId: "worker",
        packageId: "records",
        operationId: "put",
        arguments: { id: "new", count: 8 },
      });
      const adapter: ScenarioStateReader = {
        describe: () => {
          const description = world.describe();
          return {
            buildHash: description.buildHash,
            generation: description.generation,
            tools: description.tools.map(({ packageId, stateNamespaces }) => ({
              packageId,
              stateNamespaces,
            })),
          };
        },
        metadata: () => ({ worldInstanceId: world.metadata().worldInstanceId }),
        state: (query) => world.state(query),
      };
      const options = { id: "adapter-export", packages: ["records"] };
      const evidence = world.evidence();
      expect(
        captureScenarioState(adapter, { state: compiled.build.worldIr.baseline.state }, options),
      ).toEqual(world.exportScenario(options));
      expect(world.evidence()).toEqual(evidence);
      expect(() =>
        captureScenarioState(adapter, { state: [] }, { id: "safe", packages: ["missing"] }),
      ).toThrow();
    } finally {
      world.close();
    }
  });

  it("bounds the actual formatted source before writes and keeps near-limit exports compilable", async () => {
    const { root, json } = fixture();
    const source = JSON.parse(readFileSync(join(root, "world/world.json"), "utf8"));
    const rows = Array.from({ length: 6210 }, (_, index) => ({
      action: "upsert",
      packageId: "records",
      namespace: "items",
      rowId: `r${String(index).padStart(5, "0")}`,
      value: { count: index },
    }));
    json("world/world.json", { ...source, state: rows });
    const world = await createLocalWorld({ root });
    try {
      const preview = world.exportScenario({ id: "size-check" });
      const bytes = Buffer.byteLength(`${JSON.stringify(preview.scenario, null, 2)}\n`);
      expect(bytes).toBeLessThanOrEqual(1_048_576);
      expect(bytes).toBeGreaterThan(1_048_576 - 512);
      expect(Buffer.byteLength(JSON.stringify(preview.scenario))).toBeLessThan(700_000);
      expect(
        world.call({
          actorId: "worker",
          packageId: "records",
          operationId: "put",
          arguments: { id: "overflow", count: 9 },
        }).outcome.status,
      ).toBe("ok");
      expect(() => world.exportScenario({ id: "size-check" })).toThrowError(
        expect.objectContaining({ code: "framework.SCENARIO_EXPORT_TOO_LARGE" }),
      );
      await expect(world.saveScenario({ id: "size-check" })).rejects.toMatchObject({
        code: "framework.SCENARIO_EXPORT_TOO_LARGE",
      });
      expect(existsSync(join(root, "world/scenarios"))).toBe(false);
      expect(
        world.call({
          actorId: "worker",
          packageId: "records",
          operationId: "remove",
          arguments: { id: "overflow" },
        }).outcome.status,
      ).toBe("ok");
      const saved = await world.saveScenario({ id: "size-check" });
      expect(readFileSync(join(root, saved.path)).byteLength).toBe(bytes);
      expect((await compileWorld({ repositoryRoot: root, materialize: false })).status).toBe("success");
    } finally {
      world.close();
    }
  }, 30000);

  it("captures writes and deletions, saves a real scenario, restarts from it and resets to it", async () => {
    const { root } = fixture();
    const world = await createLocalWorld({ root });
    try {
      expect(
        world.call({
          actorId: "worker",
          packageId: "records",
          operationId: "remove",
          arguments: { id: "initial" },
        }).outcome.status,
      ).toBe("ok");
      expect(
        world.call({
          actorId: "worker",
          packageId: "records",
          operationId: "put",
          arguments: { id: "after", count: 9 },
        }).outcome.status,
      ).toBe("ok");
      const preview = world.exportScenario({ id: "after-action", title: "After action" });
      expect(preview.recordCount).toBe(1);
      expect(preview.deletionCount).toBe(1);
      expect(preview.omitted).toContain("history");
      expect(world.exportScenario({ id: "after-action", title: "After action" })).toEqual(preview);
      const saved = await world.saveScenario({
        id: "after-action",
        title: "After action",
        expectedSourceHash: preview.sourceHash,
      });
      expect(saved.path).toBe("world/scenarios/after-action.scenario.json");
      expect(JSON.parse(readFileSync(join(root, saved.path), "utf8"))).toEqual(preview.scenario);
      // Adding the first saved scenario must not invalidate a second save.
      await expect(world.saveScenario({ id: "another-situation" })).resolves.toMatchObject({
        id: "another-situation",
      });
      await expect(world.saveScenario({ id: "after-action" })).rejects.toMatchObject({
        code: "framework.SCENARIO_EXISTS",
      });
      const replay = await createLocalWorld({ root, scenario: "after-action" });
      try {
        expect(
          replay.state({ packageId: "records", namespace: "items" }).map((row) => [row.rowId, row.value]),
        ).toEqual([["after", { count: 9 }]]);
        replay.call({
          actorId: "worker",
          packageId: "records",
          operationId: "put",
          arguments: { id: "later", count: 5 },
        });
        replay.reset();
        expect(replay.state({ packageId: "records", namespace: "items" }).map((row) => row.rowId)).toEqual([
          "after",
        ]);
      } finally {
        replay.close();
      }
    } finally {
      world.close();
    }
  });

  it("rejects stale preview, reset generation, unknown packages and path escape", async () => {
    const { root } = fixture();
    const world = await createLocalWorld({ root });
    try {
      const preview = world.exportScenario({ id: "snapshot" });
      world.call({
        actorId: "worker",
        packageId: "records",
        operationId: "put",
        arguments: { id: "new", count: 8 },
      });
      await expect(
        world.saveScenario({ id: "snapshot", expectedSourceHash: preview.sourceHash }),
      ).rejects.toMatchObject({ code: "framework.SCENARIO_CAPTURE_CHANGED" });
      world.reset();
      await expect(world.saveScenario({ id: "snapshot", expectedGeneration: 0 })).rejects.toMatchObject({
        code: "framework.SCENARIO_CAPTURE_CHANGED",
      });
      expect(() => world.exportScenario({ id: "../../escape" })).toThrow();
      expect(() => world.exportScenario({ id: "safe", packages: ["unknown"] })).toThrow();
      const elsewhere = mkdtempSync(join(tmpdir(), "firedrill-scenario-outside-"));
      directories.push(elsewhere);
      symlinkSync(elsewhere, join(root, "world/scenarios"));
      await expect(world.saveScenario({ id: "safe" })).rejects.toMatchObject({
        code: "framework.SOURCE_INVALID",
      });
    } finally {
      world.close();
    }
  });

  it("refuses source drift instead of saving data against a different Tool schema", async () => {
    const { root } = fixture();
    const world = await createLocalWorld({ root });
    try {
      const path = join(root, "world/world.json");
      const source = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...source, seed: "919" }));
      await expect(world.saveScenario({ id: "stale" })).rejects.toMatchObject({
        code: "framework.BUILD_HASH_MISMATCH",
      });
    } finally {
      world.close();
    }
  });
});
