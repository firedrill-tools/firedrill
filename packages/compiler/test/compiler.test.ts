import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorldBuild } from "@firedrill-tools/world-build";
import { WorldKernel } from "@firedrill-tools/world-kernel";
import { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import {
  ToolPackageManifestSchema,
  type InlineScenarioDefinition,
  type JsonObject,
} from "@firedrill-tools/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { compileWorld, formatWorldSources } from "../src/index.js";
import { normalizeManifest } from "../src/normalize.js";
import { DrillSourceSchema, ScenarioSourceSchema, WorldSourceSchema } from "../src/source-schemas.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
const temporaryDirectories: string[] = [];

function temporaryFixture(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `firedrill-compiler-${name}-`));
  temporaryDirectories.push(directory);
  cpSync(join(fixtureRoot, name), directory, { recursive: true });
  return directory;
}

it("compiles pre-publication Tool SDK imports using the bundled runtime", async () => {
  const repository = temporaryFixture("appointments");
  const behavior = join(repository, "world", "reservations.ts");
  const source = readFileSync(behavior, "utf8");
  expect(source).toContain("@firedrill-tools/tool-sdk");
  writeFileSync(behavior, source.replaceAll("@firedrill-tools/tool-sdk", "@firedrill/tool-sdk"));
  const compiled = await compileWorld({ repositoryRoot: repository });
  expect(compiled.status, JSON.stringify(compiled.status === "failed" ? compiled.diagnostics : [])).toBe(
    "success",
  );
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-compiler-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function initialState(scenario: InlineScenarioDefinition) {
  const state = new Map<string, { packageId: string; namespace: string; rowId: string; value: JsonObject }>();
  for (const setup of scenario.state) {
    const key = `${setup.packageId}\u0000${setup.namespace}\u0000${setup.rowId}`;
    if (setup.action === "delete") state.delete(key);
    else {
      state.set(key, {
        packageId: setup.packageId,
        namespace: setup.namespace,
        rowId: setup.rowId,
        value: setup.value,
      });
    }
  }
  return [...state.values()];
}

async function executeFixture(input: {
  readonly name: string;
  readonly prepare?: (repository: string) => void;
  readonly scenarioId?: string;
  readonly operation: { readonly packageId: string; readonly operationId: string };
  readonly arguments: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly verify: (store: SqliteWorldStore, outcome: ReturnType<WorldKernel["invoke"]>["outcome"]) => void;
}) {
  const repository = temporaryFixture(input.name);
  input.prepare?.(repository);
  const compiled = await compileWorld({ repositoryRoot: repository });
  expect(compiled.status, JSON.stringify(compiled.status === "failed" ? compiled.diagnostics : [])).toBe(
    "success",
  );
  if (compiled.status !== "success" || compiled.build.buildDirectory === undefined) return;
  const loaded = await loadWorldBuild(compiled.build.buildDirectory);
  expect(loaded.status, JSON.stringify(loaded.status === "failed" ? loaded.diagnostics : [])).toBe("success");
  if (loaded.status !== "success") return;
  const scenario =
    input.scenarioId === undefined
      ? loaded.build.worldIr.baseline
      : loaded.build.worldIr.scenarios.find((candidate) => candidate.id === input.scenarioId);
  expect(scenario, `fixture has no scenario ${input.scenarioId}`).toBeDefined();
  if (scenario === undefined) return;
  const actor = scenario.actors[0];
  expect(actor).toBeDefined();
  if (actor === undefined) return;
  const store = SqliteWorldStore.create({
    filePath: join(repository, "world.sqlite"),
    worldInstanceId: "world_fixture01",
    buildHash: loaded.build.manifest.buildHash,
    packageLockHash: loaded.build.manifest.packageLockHash,
    seed: loaded.build.worldIr.world.seed,
    virtualTimeUs: scenario.virtualTimeUs,
    correlationId: "corr_create01",
    actors: [
      {
        bindingId: "actor_fixture01",
        actorId: actor.id,
        attributes: actor.attributes,
        grants: actor.grants,
      },
    ],
    state: initialState(scenario),
    activeFaults: scenario.faults,
  });
  try {
    const kernel = new WorldKernel({
      store,
      packageLockHash: loaded.build.manifest.packageLockHash,
      tools: loaded.build.tools,
    });
    const result = kernel.invoke({
      schemaVersion: 1,
      callId: "call_fixture01",
      correlationId: "corr_invoke01",
      operation: input.operation,
      actorBindingId: "actor_fixture01",
      arguments: input.arguments,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    input.verify(store, result.outcome);
    expect(store.readEvidence().some((entry) => entry.kind === "operation")).toBe(true);
  } finally {
    store.close();
  }
}

function installReservationsPack(
  repository: string,
  options: {
    readonly version?: string;
    readonly toolPath?: string;
    readonly lifecycle?: "active" | "deprecated" | "revoked";
  } = {},
): string {
  const packageDirectory = join(repository, "node_modules", "@example", "reservations-pack");
  mkdirSync(packageDirectory, { recursive: true });
  const sourceDirectory = join(repository, "world");
  const declaration = join(sourceDirectory, "reservations.tool.yaml");
  const behavior = join(sourceDirectory, "reservations.ts");
  writeFileSync(join(packageDirectory, "reservations.tool.yaml"), readFileSync(declaration));
  writeFileSync(join(packageDirectory, "reservations.ts"), readFileSync(behavior));
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/reservations-pack",
        version: options.version ?? "1.0.0",
        type: "module",
        exports: { "./package.json": "./package.json" },
        firedrill: {
          layer: "tool-pack",
          tool: options.toolPath ?? "reservations.tool.yaml",
          lifecycle: options.lifecycle ?? "active",
        },
      },
      null,
      2,
    )}\n`,
  );
  rmSync(declaration);
  rmSync(behavior);
  writeFileSync(
    join(repository, "firedrill.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceRoot: "world",
        world: "world.yaml",
        toolPackages: ["@example/reservations-pack"],
      },
      null,
      2,
    )}\n`,
  );
  return packageDirectory;
}

describe("source to executable world", () => {
  it("emits optional bounded actor descriptions in authored-input JSON Schemas", () => {
    const actorSchema = {
      type: "object",
      required: ["id"],
      properties: {
        description: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          pattern: "\\S",
          description:
            "Plain-text actor description for authoring and inspection; not a prompt or permission.",
        },
      },
    };
    for (const schema of [WorldSourceSchema, ScenarioSourceSchema]) {
      expect(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })).toMatchObject({
        properties: { actors: { items: actorSchema } },
      });
    }
    expect(z.toJSONSchema(DrillSourceSchema, { target: "draft-2020-12", io: "input" })).toMatchObject({
      properties: { inlineScenario: { properties: { actors: { items: actorSchema } } } },
    });
  });

  it("normalizes equivalent compatibility claims to one canonical manifest", () => {
    const route = (id: "read-record" | "update-record") => ({
      id,
      operationId: "records.read",
      method: id === "read-record" ? ("GET" as const) : ("PATCH" as const),
      path: id === "read-record" ? "/records/{recordId}" : "/records/{recordId}/status",
      auth: { kind: "bearer" as const, schemes: id === "read-record" ? ["token", "Bearer"] : ["Bearer"] },
      requestBody: id === "read-record" ? ("none" as const) : ("json" as const),
      response: { successStatus: 200, errors: [] },
    });
    const profile = (reversed: boolean) => ({
      id: "official-client",
      mode: "translated" as const,
      protocol: "http" as const,
      service: "Example records",
      client: { ecosystem: "npm" as const, name: "@example/client", version: "2.0.0" },
      configuration: { endpoint: "baseUrl", credential: "token" },
      routes: (reversed
        ? [
            { routeId: "update-record", clientMethod: "records.update" },
            { routeId: "read-record", clientMethod: "records.get" },
          ]
        : [
            { routeId: "read-record", clientMethod: "records.get" },
            { routeId: "update-record", clientMethod: "records.update" },
          ]) as Array<{ routeId: string; clientMethod: string }>,
      flows: reversed
        ? [
            {
              id: "update-and-read",
              description: "Update and then read one record.",
              routeIds: ["update-record", "read-record"],
            },
            { id: "read", description: "Read one record.", routeIds: ["read-record"] },
          ]
        : [
            { id: "read", description: "Read one record.", routeIds: ["read-record"] },
            {
              id: "update-and-read",
              description: "Update and then read one record.",
              routeIds: ["read-record", "update-record"],
            },
          ],
      limitations: reversed
        ? ["Writes cover status only.", "Reads return a bounded field set."]
        : ["Reads return a bounded field set.", "Writes cover status only."],
    });
    const manifest = (reversed: boolean) =>
      ToolPackageManifestSchema.parse({
        schemaVersion: 1,
        id: "records",
        version: "1.0.0",
        engine: ">=0.1.0 <0.2.0",
        capabilities: ["state.read"],
        operations: [
          {
            id: "records.read",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "validated",
          },
        ],
        http: reversed
          ? [route("update-record"), route("read-record")]
          : [route("read-record"), route("update-record")],
        compatibility: [profile(reversed)],
      });

    expect(normalizeManifest(manifest(false))).toEqual(normalizeManifest(manifest(true)));
  });

  it("loads an explicitly selected installed Tool pack through the ordinary world path", async () => {
    const repository = temporaryFixture("appointments");
    installReservationsPack(repository);
    const compiled = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(compiled.status, JSON.stringify(compiled.status === "failed" ? compiled.diagnostics : [])).toBe(
      "success",
    );
    if (compiled.status !== "success") return;
    expect(compiled.build.packageLock.packages[0]?.source).toEqual({
      kind: "npm",
      packageName: "@example/reservations-pack",
      packageVersion: "1.0.0",
    });
    expect(compiled.build.toolSources[0]).toMatchObject({
      packageId: "reservations",
      declarationPath: "npm/@example/reservations-pack/reservations.tool.yaml",
      origin: { kind: "npm", packageName: "@example/reservations-pack", packageVersion: "1.0.0" },
    });
    expect(compiled.build.toolSources[0]?.behaviorPaths).toEqual([
      "npm/@example/reservations-pack/reservations.ts",
    ]);

    const formatted = await formatWorldSources({ repositoryRoot: repository, check: true });
    expect(formatted.status).toBe("success");
    if (formatted.status === "success") {
      expect(formatted.files.every((file) => !file.path.startsWith("npm/"))).toBe(true);
    }

    await executeFixture({
      name: "appointments",
      prepare: installReservationsPack,
      operation: { packageId: "reservations", operationId: "slots.reserve" },
      arguments: { slotId: "morning", customerId: "customer-7" },
      idempotencyKey: "reserve-installed-morning",
      verify: (store, outcome) => {
        expect(outcome).toMatchObject({ status: "ok", value: { reserved: true } });
        expect(store.readState("reservations", "slots", "morning")?.value).toEqual({
          available: false,
          reservedBy: "customer-7",
        });
      },
    });

    await executeFixture({
      name: "appointments",
      prepare: installReservationsPack,
      operation: { packageId: "reservations", operationId: "slots.reserve" },
      arguments: { slotId: "missing", customerId: "customer-7" },
      idempotencyKey: "reserve-installed-missing",
      verify: (_store, outcome) => {
        expect(outcome).toMatchObject({
          status: "tool_error",
          error: { source: "tool", code: "tool.OCCUPIED" },
        });
      },
    });
  });

  it("derives a canonical immutable build from test-local setup without changing repository source", async () => {
    const repository = temporaryFixture("appointments");
    const toolPath = join(repository, "world", "reservations.tool.yaml");
    writeFileSync(
      toolPath,
      `${readFileSync(toolPath, "utf8")}  faults:\n    - id: temporarily-unavailable\n      appliesTo: [slots.reserve]\n      timing: before\n      error:\n        code: OCCUPIED\n        message: Reservations are temporarily unavailable\n        retryable: true\n`,
    );
    const worldPath = join(repository, "world", "world.yaml");
    writeFileSync(
      worldPath,
      `${readFileSync(worldPath, "utf8")}faults:\n  - packageId: reservations\n    faultId: temporarily-unavailable\n`,
    );
    const overrideDirectory = join(repository, "test-support");
    const overridePath = join(overrideDirectory, "reservations.override.ts");
    mkdirSync(overrideDirectory, { recursive: true });
    writeFileSync(
      overridePath,
      [
        "export default {",
        "  operations: {",
        '    "slots.reserve": (input, context) => {',
        "      const slotId = String(input.slotId);",
        "      const customerId = String(input.customerId);",
        '      context.state.put("slots", slotId, { available: false, reservedBy: customerId });',
        "      return { slotId, reserved: true };",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const authoredPaths = [
      "firedrill.json",
      "world/world.yaml",
      "world/reservations.tool.yaml",
      "world/reservations.ts",
      "world/busy-morning.scenario.yaml",
      "world/reserve-slot.drill.yaml",
      "world/booking-agent.target.json",
      "test-support/reservations.override.ts",
    ];
    const before = new Map(
      authoredPaths.map((path) => [path, readFileSync(join(repository, ...path.split("/")), "utf8")]),
    );
    const firstSetup = {
      scenario: {
        virtualTimeUs: 900,
        actors: [
          { id: "reviewer", grants: [] },
          {
            id: "scheduler",
            attributes: { region: "east" },
            grants: [{ packageId: "reservations", operationId: "slots.reserve" }],
          },
        ],
        state: [
          {
            action: "upsert" as const,
            packageId: "reservations",
            namespace: "slots",
            rowId: "afternoon",
            value: { available: true },
          },
        ],
        faults: [{ packageId: "reservations", faultId: "temporarily-unavailable" }],
      },
      tools: {
        behaviorOverrides: [{ packageId: "reservations", module: "test-support/reservations.override.ts" }],
      },
      bindings: {
        environment: {
          SERVICE_TOKEN: "FIREDRILL_HTTP_TOKEN" as const,
          SERVICE_URL: "FIREDRILL_HTTP_URL" as const,
        },
      },
    };
    const first = await compileWorld({
      repositoryRoot: repository,
      runSetup: { drillId: "reserve-slot", setup: firstSetup },
    });
    expect(first.status, JSON.stringify(first.status === "failed" ? first.diagnostics : [])).toBe("success");
    if (first.status !== "success" || first.build.buildDirectory === undefined) return;

    const equivalent = await compileWorld({
      repositoryRoot: repository,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: {
          ...firstSetup,
          scenario: {
            ...firstSetup.scenario,
            actors: [...firstSetup.scenario.actors].reverse(),
          },
          bindings: {
            environment: {
              SERVICE_URL: "FIREDRILL_HTTP_URL",
              SERVICE_TOKEN: "FIREDRILL_HTTP_TOKEN",
            },
          },
        },
      },
    });
    expect(equivalent.status).toBe("success");
    if (equivalent.status !== "success") return;
    expect(equivalent.build.setup?.setupHash).toBe(first.build.setup?.setupHash);
    expect(equivalent.build.manifest.buildHash).toBe(first.build.manifest.buildHash);

    const changed = await compileWorld({
      repositoryRoot: repository,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: {
          ...firstSetup,
          scenario: {
            ...firstSetup.scenario,
            state: [
              {
                action: "upsert",
                packageId: "reservations",
                namespace: "slots",
                rowId: "afternoon",
                value: { available: false },
              },
            ],
          },
        },
      },
    });
    expect(changed.status).toBe("success");
    if (changed.status !== "success") return;
    expect(changed.build.setup?.setupHash).not.toBe(first.build.setup?.setupHash);
    expect(changed.build.manifest.buildHash).not.toBe(first.build.manifest.buildHash);

    expect(first.build.manifest.artifacts.setup).toBe("run-setup.json");
    expect(first.build.sourceProvenance).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        id: "reservations",
        origin: {
          kind: "repository_override",
          module: "test-support/reservations.override.ts",
          base: { kind: "repository" },
        },
      }),
    );
    expect(first.build.packageLock.packages[0]?.source).toEqual({
      kind: "repository_override",
      module: "test-support/reservations.override.ts",
      base: { kind: "repository" },
    });
    expect(first.build.worldIr.targets[0]?.bindingEnvironment).toEqual({
      SERVICE_TOKEN: "FIREDRILL_HTTP_TOKEN",
      SERVICE_URL: "FIREDRILL_HTTP_URL",
    });
    expect(first.build.worldIr.drills[0]?.inlineScenario).toMatchObject({
      virtualTimeUs: 900,
      actors: [
        expect.objectContaining({ id: "reviewer" }),
        expect.objectContaining({ id: "scheduler", attributes: { region: "east" } }),
      ],
      state: expect.arrayContaining([
        expect.objectContaining({ rowId: "afternoon", value: { available: true } }),
      ]),
    });
    const loaded = await loadWorldBuild(first.build.buildDirectory);
    expect(loaded.status).toBe("success");
    if (loaded.status === "success") expect(loaded.build.setup).toEqual(first.build.setup);
    const setupArtifactPath = join(first.build.buildDirectory, "run-setup.json");
    expect(JSON.parse(readFileSync(setupArtifactPath, "utf8"))).toEqual(first.build.setup);
    for (const [path, source] of before) {
      expect(readFileSync(join(repository, ...path.split("/")), "utf8"), path).toBe(source);
    }

    const tamperedSetup = structuredClone(first.build.setup) as {
      setup: { scenario?: { state: Array<{ value?: { available?: boolean } }> } };
    };
    const injectedRow = tamperedSetup.setup.scenario?.state[0];
    if (injectedRow?.value === undefined) throw new Error("derived setup has no injected state");
    injectedRow.value.available = false;
    writeFileSync(setupArtifactPath, `${JSON.stringify(tamperedSetup)}\n`);
    const tampered = await loadWorldBuild(first.build.buildDirectory);
    expect(tampered.status).toBe("failed");
    if (tampered.status === "failed") {
      expect(tampered.diagnostics).toContainEqual(
        expect.objectContaining({ code: "FD1601", message: expect.stringContaining("setup hash") }),
      );
    }
  });

  it("selects an installed Tool package for one derived run without editing firedrill.json", async () => {
    const repository = temporaryFixture("appointments");
    installReservationsPack(repository);
    const configPath = join(repository, "firedrill.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.yaml" }, null, 2)}\n`,
    );
    const configBefore = readFileSync(configPath, "utf8");

    const withoutPackage = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(withoutPackage.status).toBe("failed");

    const selected = await compileWorld({
      repositoryRoot: repository,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: { tools: { packages: ["@example/reservations-pack"] } },
      },
    });
    expect(selected.status, JSON.stringify(selected.status === "failed" ? selected.diagnostics : [])).toBe(
      "success",
    );
    if (selected.status !== "success") return;
    expect(selected.build.packageLock.packages[0]?.source).toEqual({
      kind: "npm",
      packageName: "@example/reservations-pack",
      packageVersion: "1.0.0",
    });
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  });

  it("builds and executes three unrelated repositories without framework changes", async () => {
    await executeFixture({
      name: "appointments",
      operation: { packageId: "reservations", operationId: "slots.reserve" },
      arguments: { slotId: "morning", customerId: "customer-7" },
      idempotencyKey: "reserve-morning",
      verify: (store, outcome) => {
        expect(outcome).toMatchObject({ status: "ok", value: { reserved: true } });
        expect(store.readState("reservations", "slots", "morning")?.value).toEqual({
          available: false,
          reservedBy: "customer-7",
        });
      },
    });
    await executeFixture({
      name: "facility",
      operation: { packageId: "climate-control", operationId: "temperature.set" },
      arguments: { roomId: "greenhouse", celsius: 19 },
      idempotencyKey: "set-greenhouse",
      verify: (store, outcome) => {
        expect(outcome).toMatchObject({ status: "ok", value: { celsius: 19 } });
        expect(store.readState("climate-control", "rooms", "greenhouse")?.value).toEqual({
          celsius: 19,
        });
      },
    });
    await executeFixture({
      name: "facility",
      scenarioId: "unresponsive-controller",
      operation: { packageId: "climate-control", operationId: "temperature.set" },
      arguments: { roomId: "greenhouse", celsius: 19 },
      idempotencyKey: "set-greenhouse-during-timeout",
      verify: (store, outcome) => {
        expect(outcome).toMatchObject({
          status: "tool_error",
          error: { code: "tool.CONTROLLER_TIMEOUT", retryable: true },
        });
        expect(store.readState("climate-control", "rooms", "greenhouse")?.value).toEqual({
          celsius: 21,
        });
        expect(store.readEvidence()).toContainEqual(
          expect.objectContaining({
            kind: "fault",
            packageId: "climate-control",
            faultId: "controller-timeout",
            timing: "before",
          }),
        );
      },
    });
    await executeFixture({
      name: "laboratory",
      operation: { packageId: "sample-tracker", operationId: "samples.process" },
      arguments: { sampleId: "specimen-a" },
      idempotencyKey: "process-specimen-a",
      verify: (store, outcome) => {
        expect(outcome).toMatchObject({ status: "ok", value: { status: "processed" } });
        expect(store.readState("sample-tracker", "audit", "specimen-a")?.value).toEqual({
          processed: true,
        });
      },
    });
  });

  it("retains actor descriptions and build identity across YAML/JSON representation and source relocation", async () => {
    const repository = temporaryFixture("appointments");
    const worldYaml = join(repository, "world", "world.yaml");
    const world = WorldSourceSchema.parse(parseYaml(readFileSync(worldYaml, "utf8")));
    const actor = world.actors[0];
    if (actor === undefined) throw new Error("fixture has no actor");
    const baselineActor = { ...actor, description: "  Handles routine scheduling requests.  " };
    const undescribedActor = { id: "observer", attributes: {}, grants: [] };
    writeFileSync(worldYaml, stringifyYaml({ ...world, actors: [baselineActor, undescribedActor] }));
    const oldScenario = join(repository, "world", "busy-morning.scenario.yaml");
    const scenarioActor = {
      id: "reviewer",
      description: "Reviews the busy morning schedule.",
      attributes: {},
      grants: [],
    };
    writeFileSync(
      oldScenario,
      stringifyYaml({
        ...ScenarioSourceSchema.parse(parseYaml(readFileSync(oldScenario, "utf8"))),
        actors: [scenarioActor],
      }),
    );
    const inlineYaml = join(repository, "world", "inline-review.drill.yaml");
    const { scenarioId: _scenarioId, ...drill } = DrillSourceSchema.parse(
      parseYaml(readFileSync(join(repository, "world", "reserve-slot.drill.yaml"), "utf8")),
    );
    const inlineActor = { ...actor, description: "Handles one inline scheduling request." };
    writeFileSync(
      inlineYaml,
      stringifyYaml({
        ...drill,
        id: "inline-review",
        inlineScenario: { virtualTimeUs: 0, actors: [inlineActor], state: world.state },
      }),
    );

    const first = await compileWorld({ repositoryRoot: repository });
    expect(first.status).toBe("success");
    if (first.status !== "success") return;
    expect(first.build.worldIr.baseline.actors).toEqual([undescribedActor, baselineActor]);
    expect(first.build.worldIr.scenarios[0]?.actors).toEqual([
      undescribedActor,
      scenarioActor,
      baselineActor,
    ]);
    expect(
      first.build.worldIr.drills.find((entry) => entry.id === "inline-review")?.inlineScenario?.actors,
    ).toEqual([inlineActor]);
    expect(first.build.buildDirectory).toBeDefined();
    if (first.build.buildDirectory === undefined) return;
    const loaded = await loadWorldBuild(first.build.buildDirectory);
    expect(loaded.status).toBe("success");
    if (loaded.status === "success") expect(loaded.build.worldIr).toEqual(first.build.worldIr);

    const worldJson = join(repository, "world", "world.json");
    writeFileSync(worldJson, `${JSON.stringify(parseYaml(readFileSync(worldYaml, "utf8")), null, 2)}\n`);
    writeFileSync(
      join(repository, "firedrill.json"),
      `${JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }, null, 2)}\n`,
    );
    const newScenario = join(repository, "world", "situations", "remaining-slot.scenario.json");
    mkdirSync(dirname(newScenario), { recursive: true });
    writeFileSync(newScenario, `${JSON.stringify(parseYaml(readFileSync(oldScenario, "utf8")), null, 2)}\n`);
    rmSync(oldScenario);
    writeFileSync(
      join(repository, "world", "inline-review.drill.json"),
      `${JSON.stringify(parseYaml(readFileSync(inlineYaml, "utf8")), null, 2)}\n`,
    );
    rmSync(inlineYaml);
    const toolDirectory = join(repository, "world", "tools", "reservations");
    mkdirSync(toolDirectory, { recursive: true });
    renameSync(join(repository, "world", "reservations.tool.yaml"), join(toolDirectory, "package.tool.yaml"));
    renameSync(join(repository, "world", "reservations.ts"), join(toolDirectory, "reservations.ts"));

    const second = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(second.status).toBe("success");
    if (second.status !== "success") return;
    expect(second.build.worldIr).toEqual(first.build.worldIr);
    expect(second.build.manifest.buildHash).toBe(first.build.manifest.buildHash);
    expect(second.build.manifest.sourceDigest).toBe(first.build.manifest.sourceDigest);
    expect(second.build.sourceProvenance.find((entry) => entry.kind === "scenario")?.sourcePath).not.toBe(
      first.build.sourceProvenance.find((entry) => entry.kind === "scenario")?.sourcePath,
    );
    expect(second.build.sourceProvenance.find((entry) => entry.kind === "tool")?.sourcePath).not.toBe(
      first.build.sourceProvenance.find((entry) => entry.kind === "tool")?.sourcePath,
    );
  });

  it("normalizes a compact one-task drill and its explicit timeline to the same build", async () => {
    const repository = temporaryFixture("appointments");
    const compact = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(compact.status).toBe("success");
    if (compact.status !== "success") return;
    expect(compact.build.worldIr.drills[0]?.timeline).toMatchObject({
      horizonUs: 0,
      maxEvents: 10_000,
      interactions: [{ id: "task", afterStartUs: 0, actorId: "scheduler" }],
    });

    const drillPath = join(repository, "world", "reserve-slot.drill.yaml");
    const authored = parseYaml(readFileSync(drillPath, "utf8")) as Record<string, unknown>;
    const { actorId, task, settle: _settle, ...shared } = authored;
    writeFileSync(
      drillPath,
      `${JSON.stringify(
        {
          ...shared,
          timeline: {
            horizonUs: 0,
            maxEvents: 10_000,
            stopOnInvariantFailure: true,
            interactions: [{ id: "task", afterStartUs: 0, actorId, task }],
            invariants: [],
          },
        },
        null,
        2,
      )}\n`,
    );

    const explicit = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(explicit.status).toBe("success");
    if (explicit.status !== "success") return;
    expect(explicit.build.manifest.buildHash).toBe(compact.build.manifest.buildHash);
    expect(explicit.build.worldIr.drills).toEqual(compact.build.worldIr.drills);
  });

  it("discovers, normalizes, validates, and locks repository-owned drill suites", async () => {
    const repository = temporaryFixture("appointments");
    const drillPath = join(repository, "world", "reserve-slot.drill.yaml");
    writeFileSync(
      drillPath,
      readFileSync(drillPath, "utf8").replace("targetId:", "tags: [smoke, pr]\ntargetId:"),
    );
    writeFileSync(
      join(repository, "world", "pull-request.suite.yaml"),
      "schemaVersion: 1\nid: pull-request\ntags: [smoke]\ndrills: [reserve-slot]\nconcurrency: 2\nretries: 1\n",
    );

    const compiled = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(compiled.status).toBe("success");
    if (compiled.status !== "success") return;
    expect(compiled.build.worldIr.drills[0]?.tags).toEqual(["pr", "smoke"]);
    expect(compiled.build.worldIr.suites).toEqual([
      {
        schemaVersion: 1,
        id: "pull-request",
        drills: ["reserve-slot"],
        tags: ["smoke"],
        concurrency: 2,
        retries: 1,
      },
    ]);
    expect(compiled.build.sourceProvenance).toContainEqual(
      expect.objectContaining({ kind: "suite", id: "pull-request" }),
    );

    writeFileSync(
      join(repository, "world", "pull-request.suite.yaml"),
      "schemaVersion: 1\nid: pull-request\ndrills: [missing-drill]\n",
    );
    const invalid = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(invalid.status).toBe("failed");
    if (invalid.status === "failed") {
      expect(invalid.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1202",
          message: "suite references unknown drill missing-drill",
          span: expect.objectContaining({ path: "world/pull-request.suite.yaml" }),
        }),
      );
    }
  });

  it("formats authored fields deterministically without expanding compiler defaults", async () => {
    const repository = temporaryFixture("appointments");
    const before = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(before.status).toBe("success");
    const check = await formatWorldSources({ repositoryRoot: repository, check: true });
    expect(check.status).toBe("success");
    if (check.status !== "success") return;
    expect(check.files.some((file) => file.changed)).toBe(true);

    const formatted = await formatWorldSources({ repositoryRoot: repository });
    expect(formatted.status).toBe("success");
    const repeated = await formatWorldSources({ repositoryRoot: repository, check: true });
    expect(repeated.status).toBe("success");
    if (repeated.status === "success") expect(repeated.files.every((file) => !file.changed)).toBe(true);
    expect(readFileSync(join(repository, "world", "busy-morning.scenario.yaml"), "utf8")).not.toContain(
      "actors:",
    );
    const after = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(after.status).toBe("success");
    if (before.status === "success" && after.status === "success") {
      expect(after.build.manifest.buildHash).toBe(before.build.manifest.buildHash);
    }
  });

  it("preserves YAML comments while canonicalizing flow collections", async () => {
    const repository = temporaryFixture("appointments");
    const scenarioPath = join(repository, "world", "busy-morning.scenario.yaml");
    const source = readFileSync(scenarioPath, "utf8");
    writeFileSync(
      scenarioPath,
      `# Scenario explanation retained for reviewers.\n${source.replace(
        "schemaVersion: 1",
        "schemaVersion: 1 # source format version",
      )}\n# End-of-file reviewer note.\n`,
    );

    const formatted = await formatWorldSources({ repositoryRoot: repository });
    expect(formatted.status).toBe("success");
    const output = readFileSync(scenarioPath, "utf8");
    expect(output).toContain("# Scenario explanation retained for reviewers.");
    expect(output).toContain("schemaVersion: 1 # source format version");
    expect(output).toContain("# End-of-file reviewer note.");

    const repeated = await formatWorldSources({ repositoryRoot: repository, check: true });
    expect(repeated.status).toBe("success");
    if (repeated.status === "success") expect(repeated.files.every((file) => !file.changed)).toBe(true);
  });

  it("formats repeated state namespaces without confusing distinct rows", async () => {
    const repository = temporaryFixture("appointments");
    const scenarioPath = join(repository, "world", "busy-morning.scenario.yaml");
    appendFileSync(
      scenarioPath,
      `state:
  - action: upsert
    packageId: reservations
    namespace: slots
    rowId: morning-1
    value: { available: true }
  - action: upsert
    packageId: reservations
    namespace: slots
    rowId: morning-2
    value: { available: false }
`,
    );

    const before = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(before.status).toBe("success");
    const formatted = await formatWorldSources({ repositoryRoot: repository });
    expect(formatted.status).toBe("success");
    const after = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(after.status).toBe("success");
    if (before.status === "success" && after.status === "success") {
      expect(after.build.manifest.buildHash).toBe(before.build.manifest.buildHash);
      const scenario = after.build.worldIr.scenarios.find((item) => item.id === "busy-morning");
      expect(scenario?.state.map((item) => item.rowId)).toEqual(["morning", "morning-1", "morning-2"]);
    }
  });

  it("preserves nested schemas when deterministic formatting reorders Tool resources", async () => {
    const repository = temporaryFixture("appointments");
    const toolPath = join(repository, "world", "reservations.tool.yaml");
    const tool = parseYaml(readFileSync(toolPath, "utf8")) as {
      manifest: {
        state: unknown[];
        operations: unknown[];
      };
    };
    const slots = tool.manifest.state[0];
    const reserve = tool.manifest.operations[0];
    expect(slots).toBeDefined();
    expect(reserve).toBeDefined();
    tool.manifest.state = [
      {
        namespace: "z-audit",
        schema: {
          type: "object",
          required: ["zValue"],
          properties: { zValue: { type: "string" } },
          additionalProperties: false,
        },
      },
      slots,
    ];
    tool.manifest.operations = [
      reserve,
      {
        id: "audit.inspect",
        inputSchema: {
          type: "object",
          required: ["auditId"],
          properties: { auditId: { type: "string" } },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["found"],
          properties: { found: { type: "boolean" } },
          additionalProperties: false,
        },
        idempotency: "none",
        fidelity: "contract",
      },
    ];
    writeFileSync(toolPath, `${JSON.stringify(tool, null, 2)}\n`);

    const before = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(before.status).toBe("success");
    const formatted = await formatWorldSources({ repositoryRoot: repository });
    expect(formatted.status).toBe("success");
    const after = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(after.status).toBe("success");
    if (before.status === "success" && after.status === "success") {
      expect(after.build.manifest.buildHash).toBe(before.build.manifest.buildHash);
    }

    const formattedTool = parseYaml(readFileSync(toolPath, "utf8")) as {
      manifest: {
        state: Array<{ namespace: string; schema: { properties: Record<string, unknown> } }>;
        operations: Array<{
          id: string;
          inputSchema: { properties: Record<string, unknown> };
          outputSchema: { properties: Record<string, unknown> };
        }>;
      };
    };
    expect(
      formattedTool.manifest.state.find((item) => item.namespace === "slots")?.schema.properties,
    ).toHaveProperty("available");
    expect(
      formattedTool.manifest.state.find((item) => item.namespace === "z-audit")?.schema.properties,
    ).toHaveProperty("zValue");
    expect(
      formattedTool.manifest.operations.find((item) => item.id === "slots.reserve")?.inputSchema.properties,
    ).toHaveProperty("slotId");
    expect(
      formattedTool.manifest.operations.find((item) => item.id === "audit.inspect")?.inputSchema.properties,
    ).toHaveProperty("auditId");
  });
});

describe("compiler failures", () => {
  it("rejects unknown authored schema versions before interpreting their fields", async () => {
    const futureConfig = temporaryFixture("appointments");
    const configPath = join(futureConfig, "firedrill.json");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace('"schemaVersion": 1', '"schemaVersion": 2'),
    );
    const future = await compileWorld({ repositoryRoot: futureConfig, materialize: false });
    expect(future.status).toBe("failed");
    if (future.status === "failed") {
      expect(future.diagnostics).toEqual([
        expect.objectContaining({
          code: "FD1103",
          message: "unsupported authored source schemaVersion 2; this release supports 1",
          path: ["schemaVersion"],
          suggestion: expect.stringContaining("do not relabel"),
        }),
      ]);
      expect(future.diagnostics[0]?.span?.path).toBe("firedrill.json");
    }

    const legacyScenario = temporaryFixture("appointments");
    const scenarioPath = join(legacyScenario, "world", "busy-morning.scenario.yaml");
    writeFileSync(
      scenarioPath,
      readFileSync(scenarioPath, "utf8").replace("schemaVersion: 1", "schemaVersion: 0"),
    );
    const legacy = await formatWorldSources({ repositoryRoot: legacyScenario, check: true });
    expect(legacy.status).toBe("failed");
    if (legacy.status === "failed") {
      expect(legacy.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1103",
          message: "unsupported authored source schemaVersion 0; this release supports 1",
          suggestion: expect.stringContaining("Migrate this resource"),
        }),
      );
    }
  });

  it("rejects unknown, duplicate, and escaped test-local Tool setup", async () => {
    const unknown = temporaryFixture("appointments");
    const unknownResult = await compileWorld({
      repositoryRoot: unknown,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: {
          tools: {
            behaviorOverrides: [{ packageId: "missing-tool", module: "world/reservations.ts" }],
          },
        },
      },
    });
    expect(unknownResult.status).toBe("failed");
    if (unknownResult.status === "failed") {
      expect(unknownResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1402",
          message: "Tool behavior override references unknown package missing-tool",
        }),
      );
    }

    const duplicate = temporaryFixture("appointments");
    installReservationsPack(duplicate);
    const duplicateResult = await compileWorld({
      repositoryRoot: duplicate,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: { tools: { packages: ["@example/reservations-pack"] } },
      },
    });
    expect(duplicateResult.status).toBe("failed");
    if (duplicateResult.status === "failed") {
      expect(duplicateResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1402",
          message: "Tool package @example/reservations-pack is selected more than once",
        }),
      );
    }

    const escaped = temporaryFixture("appointments");
    const outsideDirectory = mkdtempSync(join(tmpdir(), "firedrill-compiler-setup-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outside = join(outsideDirectory, "override.ts");
    writeFileSync(outside, "export default { operations: {} };\n");
    mkdirSync(join(escaped, "test-support"));
    const linked = join(escaped, "test-support", "escaped-override.ts");
    symlinkSync(outside, linked);
    const escapedResult = await compileWorld({
      repositoryRoot: escaped,
      materialize: false,
      runSetup: {
        drillId: "reserve-slot",
        setup: {
          tools: {
            behaviorOverrides: [{ packageId: "reservations", module: "test-support/escaped-override.ts" }],
          },
        },
      },
    });
    expect(escapedResult.status).toBe("failed");
    if (escapedResult.status === "failed") {
      expect(escapedResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1002",
          message: expect.stringContaining("resolves through a symlink outside"),
        }),
      );
    }
  });

  it("makes missing and inconsistent installed Tool packs actionable", async () => {
    const missing = temporaryFixture("appointments");
    const configPath = join(missing, "firedrill.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, sourceRoot: "world", toolPackages: ["@example/missing"] })}\n`,
    );
    const unresolved = await compileWorld({ repositoryRoot: missing, materialize: false });
    expect(unresolved.status).toBe("failed");
    if (unresolved.status === "failed") {
      expect(unresolved.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1402",
          message: expect.stringContaining("cannot resolve Tool package @example/missing"),
          span: expect.objectContaining({ path: "firedrill.json" }),
          suggestion: expect.stringContaining("Install @example/missing"),
        }),
      );
    }

    const mismatched = temporaryFixture("appointments");
    installReservationsPack(mismatched, { version: "2.0.0" });
    const invalidVersion = await compileWorld({ repositoryRoot: mismatched, materialize: false });
    expect(invalidVersion.status).toBe("failed");
    if (invalidVersion.status === "failed") {
      expect(invalidVersion.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1402",
          message: expect.stringContaining("declares version 1.0.0"),
          span: expect.objectContaining({
            path: "npm/@example/reservations-pack/reservations.tool.yaml",
          }),
        }),
      );
    }
  });

  it("warns for deprecated packs and refuses revoked installed artifacts", async () => {
    const deprecated = temporaryFixture("appointments");
    installReservationsPack(deprecated, { lifecycle: "deprecated" });
    const warned = await compileWorld({ repositoryRoot: deprecated, materialize: false });
    expect(warned.status).toBe("success");
    if (warned.status === "success") {
      expect(warned.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1403",
          severity: "warning",
          message: expect.stringContaining("is deprecated"),
        }),
      );
    }

    const revoked = temporaryFixture("appointments");
    installReservationsPack(revoked, { lifecycle: "revoked" });
    const refused = await compileWorld({ repositoryRoot: revoked, materialize: false });
    expect(refused.status).toBe("failed");
    if (refused.status === "failed") {
      expect(refused.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1403",
          severity: "error",
          message: expect.stringContaining("is revoked"),
          suggestion: expect.stringContaining("will not execute"),
        }),
      );
    }
  });

  it("rejects installed Tool declarations that escape their package", async () => {
    const repository = temporaryFixture("appointments");
    installReservationsPack(repository, { toolPath: "escape.tool.yaml" });
    const packageDirectory = join(repository, "node_modules", "@example", "reservations-pack");
    const outside = join(repository, "node_modules", "outside.tool.yaml");
    writeFileSync(outside, "schemaVersion: 1\n");
    symlinkSync(outside, join(packageDirectory, "escape.tool.yaml"));
    const result = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "FD1402",
          message: expect.stringContaining("symlink outside npm package"),
        }),
      );
    }
  });

  it("returns located schema, reference, data, compatibility, and behavior diagnostics", async () => {
    const cases = [
      {
        name: "syntax",
        mutate(repository: string) {
          appendFileSync(join(repository, "world", "world.yaml"), "actors: [\n");
        },
        code: "FD1101",
        path: "world/world.yaml",
      },
      {
        name: "schema",
        mutate(repository: string) {
          appendFileSync(join(repository, "world", "world.yaml"), "unknownExecutionField: true\n");
        },
        code: "FD1102",
        path: "world/world.yaml",
      },
      {
        name: "capability",
        mutate(repository: string) {
          const path = join(repository, "world", "reservations.tool.yaml");
          writeFileSync(
            path,
            readFileSync(path, "utf8").replace("    - state.read", "    - state.read\n    - network"),
          );
        },
        code: "FD1102",
        path: "world/reservations.tool.yaml",
      },
      {
        name: "reference",
        mutate(repository: string) {
          const path = join(repository, "world", "world.yaml");
          writeFileSync(path, readFileSync(path, "utf8").replace("slots.reserve", "slots.missing"));
        },
        code: "FD1202",
        path: "world/world.yaml",
      },
      {
        name: "assertion-reference",
        mutate(repository: string) {
          const path = join(repository, "world", "reserve-slot.drill.yaml");
          writeFileSync(path, readFileSync(path, "utf8").replace("slots.reserve", "slots.missing"));
        },
        code: "FD1202",
        path: "world/reserve-slot.drill.yaml",
      },
      {
        name: "data",
        mutate(repository: string) {
          const path = join(repository, "world", "world.yaml");
          writeFileSync(path, readFileSync(path, "utf8").replace("available: true", "available: invalid"));
        },
        code: "FD1203",
        path: "world/world.yaml",
      },
      {
        name: "event-data",
        mutate(repository: string) {
          appendFileSync(
            join(repository, "world", "world.yaml"),
            "initialEvents:\n  - event:\n      packageId: reservations\n      eventId: slot.reserved\n    payload:\n      slotId: morning\n    atUs: 0\n    actorId: scheduler\n",
          );
        },
        code: "FD1203",
        path: "world/world.yaml",
      },
      {
        name: "json-schema",
        mutate(repository: string) {
          const path = join(repository, "world", "reservations.tool.yaml");
          writeFileSync(
            path,
            readFileSync(path, "utf8").replace("        type: object", "        type: impossible"),
          );
        },
        code: "FD1203",
        path: "world/reservations.tool.yaml",
      },
      {
        name: "identity",
        mutate(repository: string) {
          const targetPath = join(repository, "world", "booking-agent.target.json");
          writeFileSync(
            targetPath,
            readFileSync(targetPath, "utf8").replace("booking-agent", "busy-morning"),
          );
          const drillPath = join(repository, "world", "reserve-slot.drill.yaml");
          writeFileSync(drillPath, readFileSync(drillPath, "utf8").replace("booking-agent", "busy-morning"));
        },
        code: "FD1201",
        path: "world/booking-agent.target.json",
      },
      {
        name: "engine",
        mutate(repository: string) {
          const path = join(repository, "world", "reservations.tool.yaml");
          writeFileSync(path, readFileSync(path, "utf8").replace(">=0.1.0 <0.2.0", ">=9.0.0"));
        },
        code: "FD1401",
        path: "world/reservations.tool.yaml",
      },
      {
        name: "behavior",
        mutate(repository: string) {
          const path = join(repository, "world", "reservations.ts");
          writeFileSync(path, `import "left-pad";\n${readFileSync(path, "utf8")}`);
        },
        code: "FD1301",
        path: "world/reservations.ts",
      },
    ] as const;

    for (const case_ of cases) {
      const repository = temporaryFixture("appointments");
      case_.mutate(repository);
      const result = await compileWorld({ repositoryRoot: repository, materialize: false });
      expect(result.status, case_.name).toBe("failed");
      if (result.status !== "failed") continue;
      const found = result.diagnostics.find((item) => item.code === case_.code);
      expect(found, `${case_.name}: ${JSON.stringify(result.diagnostics)}`).toBeDefined();
      expect(found?.span?.path).toBe(case_.path);
      expect(found?.span?.start.line).toBeGreaterThan(0);
    }
  });

  it("anchors resolved scenario data errors to the authored overlay row", async () => {
    const repository = temporaryFixture("appointments");
    const scenarioPath = join(repository, "world", "busy-morning.scenario.yaml");
    const source = `${readFileSync(scenarioPath, "utf8")}state:\n  - action: upsert\n    packageId: reservations\n    namespace: slots\n    rowId: afternoon\n    value:\n      available: invalid\n`;
    writeFileSync(scenarioPath, source);

    const result = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    const found = result.diagnostics.find(
      (item) => item.code === "FD1203" && item.span?.path === "world/busy-morning.scenario.yaml",
    );
    expect(found?.span?.start.line).toBe(
      source.split("\n").findIndex((line) => line.includes("available:")) + 1,
    );
  });

  it("names missing schema fields and gives a field-specific repair", async () => {
    const repository = temporaryFixture("appointments");
    const drillPath = join(repository, "world", "reserve-slot.drill.yaml");
    writeFileSync(drillPath, readFileSync(drillPath, "utf8").replace(/^targetId:.*\n/m, ""));

    const result = await compileWorld({ repositoryRoot: repository, materialize: false });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    const found = result.diagnostics.find((item) => item.code === "FD1102");
    expect(found).toMatchObject({
      message: expect.stringContaining("targetId:"),
      path: ["targetId"],
      suggestion: expect.stringContaining("targetId"),
      span: { path: "world/reserve-slot.drill.yaml" },
    });
    expect(found?.suggestion).not.toContain("remove unknown");
  });

  it("rejects source symlinks escaping the repository", async () => {
    const repository = temporaryFixture("appointments");
    const outside = join(tmpdir(), `external-${Date.now()}.tool.yaml`);
    writeFileSync(outside, "schemaVersion: 1\n");
    try {
      symlinkSync(outside, join(repository, "world", "escape.tool.yaml"));
      const result = await compileWorld({ repositoryRoot: repository, materialize: false });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.diagnostics.map((item) => item.code)).toContain("FD1002");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("never overwrites a corrupted immutable build", async () => {
    const repository = temporaryFixture("appointments");
    const first = await compileWorld({ repositoryRoot: repository });
    expect(first.status).toBe("success");
    if (first.status !== "success" || first.build.buildDirectory === undefined) return;
    writeFileSync(join(first.build.buildDirectory, "world.ir.json"), "{}\n");
    const second = await compileWorld({ repositoryRoot: repository });
    expect(second.status).toBe("failed");
    if (second.status === "failed") expect(second.diagnostics.map((item) => item.code)).toContain("FD1501");
  });
});
