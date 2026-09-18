import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolOverride } from "@firedrill-run/contracts";
import { loadWorldBuild } from "@firedrill-run/world-build";
import { WorldKernel } from "@firedrill-run/world-kernel";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { compileWorld } from "../src/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const directories: string[] = [];
function fixture(name = "appointments"): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-tool-overrides-"));
  directories.push(directory);
  cpSync(join(fixtures, name), directory, { recursive: true });
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function amend(root: string, path: string, update: (source: Record<string, unknown>) => void): void {
  const file = join(root, path);
  const source = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  update(source);
  writeFileSync(file, path.endsWith(".json") ? JSON.stringify(source) : stringify(source));
}
const operation = { packageId: "reservations", operationId: "slots.reserve" };
function rule(id: string, kind: "return" | "original" = "return"): ToolOverride {
  return {
    id,
    operation,
    outcome: kind === "return" ? { kind, value: { slotId: id, reserved: true } } : { kind },
  };
}

describe("compiled Tool override scopes", () => {
  it("resolves ordered baseline, scenario, drill and run rules with source-owned provenance", async () => {
    const root = fixture();
    amend(root, "world/world.yaml", (source) => {
      source.toolOverrides = [rule("shared"), rule("baseline-only")];
    });
    amend(root, "world/busy-morning.scenario.yaml", (source) => {
      source.toolOverrides = [rule("scenario-only"), rule("shared", "original")];
    });
    amend(root, "world/reserve-slot.drill.yaml", (source) => {
      source.toolOverrides = [rule("drill-only"), rule("shared")];
    });
    const compiled = await compileWorld({
      repositoryRoot: root,
      runSetup: {
        drillId: "reserve-slot",
        setup: { scenario: { toolOverrides: [rule("shared", "original"), rule("run-only")] } },
      },
    });
    expect(compiled.status, JSON.stringify(compiled)).toBe("success");
    if (compiled.status !== "success") return;
    const rules = compiled.build.worldIr.drills[0]?.inlineScenario?.toolOverrides;
    expect(rules?.map((item) => [item.id, item.scope])).toEqual([
      ["baseline-only", { kind: "baseline" }],
      ["scenario-only", { kind: "scenario", scenarioId: "busy-morning" }],
      ["drill-only", { kind: "drill", drillId: "reserve-slot" }],
      ["shared", { kind: "run", drillId: "reserve-slot" }],
      ["run-only", { kind: "run", drillId: "reserve-slot" }],
    ]);
    expect(compiled.build.worldIr.drills[0]).not.toHaveProperty("toolOverrides");
    expect(compiled.build.setup?.setup.scenario?.toolOverrides).toEqual([
      rule("shared", "original"),
      rule("run-only"),
    ]);
    expect(JSON.stringify(compiled.build.setup?.setup ?? {})).not.toContain('"scope"');
    const changed = await compileWorld({
      repositoryRoot: root,
      runSetup: {
        drillId: "reserve-slot",
        setup: { scenario: { toolOverrides: [rule("run-only"), rule("shared", "original")] } },
      },
    });
    expect(changed.status).toBe("success");
    if (changed.status === "success")
      expect(changed.build.manifest.buildHash).not.toBe(compiled.build.manifest.buildHash);
  });

  it("keeps inline scenarios independent of baseline while layering drill overrides", async () => {
    const root = fixture();
    amend(root, "world/world.yaml", (source) => {
      source.toolOverrides = [rule("baseline")];
    });
    amend(root, "world/reserve-slot.drill.yaml", (source) => {
      delete source.scenarioId;
      source.inlineScenario = {
        virtualTimeUs: 0,
        actors: [{ id: "scheduler", grants: [operation] }],
        toolOverrides: [rule("inline")],
      };
      source.toolOverrides = [rule("drill")];
    });
    const result = await compileWorld({ repositoryRoot: root });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.build.worldIr.drills[0]?.inlineScenario?.toolOverrides?.map((item) => item.id)).toEqual([
      "inline",
    ]);
    expect(result.build.worldIr.drills[0]?.toolOverrides?.[0]?.scope).toEqual({
      kind: "drill",
      drillId: "reserve-slot",
    });
  });

  it.each([
    ["unknown operation", { ...rule("invalid"), operation: { ...operation, operationId: "missing" } }],
    ["unknown actor", { ...rule("invalid"), when: { actorId: "missing" } }],
    [
      "undeclared error",
      { ...rule("invalid"), outcome: { kind: "error", code: "MISSING", message: "blocked" } },
    ],
    ["invalid output", { ...rule("invalid"), outcome: { kind: "return", value: { reserved: "wrong" } } }],
    ["forged provenance", { ...rule("invalid"), scope: { kind: "run", drillId: "reserve-slot" } }],
  ])("rejects %s before execution", async (_label, invalidRule) => {
    const root = fixture();
    amend(root, "world/world.yaml", (source) => {
      source.toolOverrides = [invalidRule];
    });
    const result = await compileWorld({ repositoryRoot: root });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.diagnostics.some((item) => item.span?.path === "world/world.yaml")).toBe(true);
    }
  });

  it("rejects duplicate same-scope IDs and invalid inline return outputs", async () => {
    const root = fixture();
    amend(root, "world/busy-morning.scenario.yaml", (source) => {
      source.toolOverrides = [rule("duplicate"), rule("duplicate")];
    });
    expect((await compileWorld({ repositoryRoot: root })).status).toBe("failed");
    amend(root, "world/busy-morning.scenario.yaml", (source) => {
      delete source.toolOverrides;
    });
    amend(root, "world/reserve-slot.drill.yaml", (source) => {
      delete source.scenarioId;
      source.inlineScenario = {
        virtualTimeUs: 0,
        actors: [{ id: "scheduler", grants: [operation] }],
        toolOverrides: [{ ...rule("invalid"), outcome: { kind: "return", value: null } }],
      };
    });
    const result = await compileWorld({ repositoryRoot: root });
    expect(result.status).toBe("failed");
    if (result.status === "failed")
      expect(result.diagnostics.some((item) => item.message.includes("override invalid output"))).toBe(true);
  });

  it.each([
    {
      name: "appointments",
      source: "world/world.yaml",
      operation,
      args: { slotId: "morning", customerId: "guest" },
      value: { slotId: "synthetic", reserved: false },
      key: "reserve",
    },
    {
      name: "facility",
      source: "simulation/world.json",
      operation: { packageId: "climate-control", operationId: "temperature.read" },
      args: { roomId: "greenhouse" },
      value: { celsius: -17 },
    },
    {
      name: "laboratory",
      source: "drill-world/world.yaml",
      operation: { packageId: "sample-tracker", operationId: "samples.read" },
      args: { sampleId: "specimen-a" },
      value: { status: "held" },
    },
  ])(
    "executes compiled static behavior in unrelated $name world without handler state changes",
    async (sample) => {
      const root = fixture(sample.name);
      amend(root, sample.source, (source) => {
        source.toolOverrides = [
          {
            id: "controlled-response",
            operation: sample.operation,
            outcome: { kind: "return", value: sample.value },
            times: 1,
          },
        ];
      });
      const compiled = await compileWorld({ repositoryRoot: root });
      expect(compiled.status, JSON.stringify(compiled)).toBe("success");
      if (compiled.status !== "success" || compiled.build.buildDirectory === undefined) return;
      const loaded = await loadWorldBuild(compiled.build.buildDirectory);
      expect(loaded.status, JSON.stringify(loaded)).toBe("success");
      if (loaded.status !== "success") return;
      const base = loaded.build.worldIr.baseline;
      const actor = base.actors[0];
      if (actor === undefined) throw new Error("fixture lacks actor");
      const store = SqliteWorldStore.create({
        filePath: join(root, "world.sqlite"),
        worldInstanceId: "world_override01",
        buildHash: loaded.build.manifest.buildHash,
        packageLockHash: loaded.build.manifest.packageLockHash,
        seed: "2",
        virtualTimeUs: base.virtualTimeUs,
        correlationId: "corr_overridecreate",
        actors: [
          {
            bindingId: "actor_override01",
            actorId: actor.id,
            attributes: actor.attributes,
            grants: actor.grants,
          },
        ],
      });
      try {
        const kernel = new WorldKernel({
          store,
          packageLockHash: loaded.build.manifest.packageLockHash,
          tools: loaded.build.tools,
          toolOverrides: base.toolOverrides ?? [],
        });
        const result = kernel.invoke({
          schemaVersion: 1,
          callId: "call_override01",
          correlationId: "corr_override01",
          actorBindingId: "actor_override01",
          operation: sample.operation,
          arguments: sample.args,
          ...(sample.key === undefined ? {} : { idempotencyKey: sample.key }),
        });
        expect(result.outcome).toEqual({ status: "ok", value: sample.value });
        expect(result.evidence.find((entry) => entry.kind === "operation")?.toolOverride).toEqual({
          id: "controlled-response",
          scope: { kind: "baseline" },
          outcome: "return",
          matchIndex: 1,
        });
        expect(result.evidence.some((entry) => entry.kind === "state_change")).toBe(false);
      } finally {
        store.close();
      }
    },
  );
});
