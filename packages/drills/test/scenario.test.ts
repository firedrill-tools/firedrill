import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedToolOverride, TargetDescriptor } from "@firedrill/contracts";
import { FIREDRILL_ENGINE_VERSION } from "@firedrill/contracts";
import { invokeCliWorldOperation } from "@firedrill/protocol-cli";
import { defineTool } from "@firedrill/tool-sdk";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import {
  BuildIdentitySchema,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  semanticHash,
} from "@firedrill/world-ir";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDrillWorld,
  createScenarioWorld,
  DrillSetupError,
  DrillTrialCoordinator,
  materializeDrillScenario,
  materializeWorldScenario,
  runDrill,
  runDrillTrial,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-drills-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-drills-test-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function loadedBuild(withCallbacks = false): LoadedWorldBuild {
  const tool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "parcel-service",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [
        {
          namespace: "parcels",
          schema: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          namespace: "notifications",
          schema: {
            type: "object",
            required: ["observed"],
            properties: { observed: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "parcels.release",
          inputSchema: {
            type: "object",
            required: ["parcelId"],
            properties: { parcelId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["released"],
            properties: { released: { type: "boolean" } },
            additionalProperties: false,
          },
          declaredErrors: ["SCANNER_OFFLINE"],
          idempotency: "required",
          fidelity: "behavioral",
        },
      ],
      events: [
        {
          id: "parcel.ready",
          payloadSchema: {
            type: "object",
            required: ["parcelId"],
            properties: { parcelId: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      faults: [
        {
          id: "scanner-offline",
          appliesTo: ["parcels.release"],
          timing: "before",
          error: {
            code: "SCANNER_OFFLINE",
            message: "the scanner is offline",
            retryable: true,
          },
        },
      ],
      subscriptions: [
        {
          id: "observe-ready-parcel",
          event: { packageId: "parcel-service", eventId: "parcel.ready" },
        },
      ],
      callbacks: withCallbacks
        ? [
            {
              id: "notify-dispatcher",
              eventId: "parcel.ready",
              receiverId: "dispatch-application",
              method: "POST",
              path: "/ready",
              idempotencyHeader: "Idempotency-Key",
              retry: { delaysUs: [5] },
            },
          ]
        : [],
    },
    operations: {
      "parcels.release": (input, context) => {
        const parcelId = String(input.parcelId);
        context.state.put("parcels", parcelId, { status: "released" });
        return { released: true };
      },
    },
    subscriptions: {
      "observe-ready-parcel": (payload, context) => {
        context.state.put("notifications", String(payload.parcelId), { observed: true });
      },
    },
    ...(withCallbacks
      ? {
          callbacks: {
            "notify-dispatcher": {
              encode: ({ virtualTimeUs, attempt }: { virtualTimeUs: number; attempt: number }) => ({
                body: { kind: "json" as const, value: { virtualTimeUs, attempt } },
              }),
            },
          },
        }
      : {}),
  });

  const worldIr = CanonicalWorldIrSchema.parse({
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    world: { id: "parcel-routing", seed: "17" },
    tools: [tool.manifest],
    baseline: {
      virtualTimeUs: 50,
      actors: [
        {
          id: "dispatcher",
          attributes: { depot: "north" },
          grants: [{ packageId: "parcel-service", operationId: "parcels.release" }],
        },
      ],
      state: [
        {
          action: "upsert",
          packageId: "parcel-service",
          namespace: "parcels",
          rowId: "parcel-a",
          value: { status: "draft" },
        },
        {
          action: "upsert",
          packageId: "parcel-service",
          namespace: "parcels",
          rowId: "parcel-b",
          value: { status: "queued" },
        },
      ],
    },
    scenarios: [
      {
        schemaVersion: 1,
        id: "ready-for-release",
        virtualTimeUs: 100,
        actors: [
          {
            id: "dispatcher",
            attributes: { depot: "north" },
            grants: [{ packageId: "parcel-service", operationId: "parcels.release" }],
          },
        ],
        state: [
          {
            action: "upsert",
            packageId: "parcel-service",
            namespace: "parcels",
            rowId: "parcel-a",
            value: { status: "draft" },
          },
          {
            action: "upsert",
            packageId: "parcel-service",
            namespace: "parcels",
            rowId: "parcel-b",
            value: { status: "queued" },
          },
          {
            action: "delete",
            packageId: "parcel-service",
            namespace: "parcels",
            rowId: "parcel-b",
          },
          {
            action: "upsert",
            packageId: "parcel-service",
            namespace: "parcels",
            rowId: "parcel-a",
            value: { status: "ready" },
          },
        ],
        faults: [{ packageId: "parcel-service", faultId: "scanner-offline" }],
        initialEvents: [
          {
            event: { packageId: "parcel-service", eventId: "parcel.ready" },
            payload: { parcelId: "parcel-a" },
            atUs: 120,
            actorId: "dispatcher",
          },
        ],
      },
    ],
    drills: [
      {
        schemaVersion: 1,
        id: "release-ready-parcel",
        targetId: "parcel-agent",
        scenarioId: "ready-for-release",
        timeline: {
          horizonUs: 0,
          maxEvents: 10_000,
          stopOnInvariantFailure: true,
          interactions: [
            {
              id: "task",
              afterStartUs: 0,
              actorId: "dispatcher",
              task: { instruction: "Release the parcel that is ready." },
            },
          ],
          invariants: [],
        },
        trials: { count: 1, classification: "contract" },
        assertions: [
          {
            id: "release-attempted",
            kind: "operation.count",
            operation: { packageId: "parcel-service", operationId: "parcels.release" },
            comparison: { operator: "equals", value: 1 },
          },
        ],
      },
    ],
    targets: [{ id: "parcel-agent", kind: "external", bindings: ["direct"], timeoutMs: 30_000 }],
  });
  const packageLock = PackageLockSchema.parse({
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    packages: [
      {
        packageId: "parcel-service",
        version: "1.0.0",
        manifestHash: semanticHash(tool.manifest),
        artifactHash: `sha256:${"a".repeat(64)}`,
        artifactPath: "tools/parcel-service.mjs",
        exportName: "default",
        moduleFormat: "esm",
        source: { kind: "repository" },
      },
    ],
  });
  const identity = BuildIdentitySchema.parse({
    schemaVersion: 1,
    worldIrSchemaVersion: 1,
    packageLockSchemaVersion: 1,
    compilerVersion: "0.1.0",
    engineVersion: FIREDRILL_ENGINE_VERSION,
    irHash: semanticHash(worldIr),
    packageLockHash: semanticHash(packageLock),
    sourceDigest: `sha256:${"b".repeat(64)}`,
  });
  const manifest = BuildManifestSchema.parse({
    ...identity,
    buildHash: semanticHash(identity),
    worldId: worldIr.world.id,
    artifacts: { worldIr: "world.ir.json", packageLock: "packages.lock.json" },
    provenance: [],
    diagnostics: { errors: 0, warnings: 0, info: 0 },
  });
  return { manifest, worldIr, packageLock, tools: [tool], toolUis: [], directory: "/verified/build" };
}

function withWorldIr(
  build: LoadedWorldBuild,
  transform: (worldIr: LoadedWorldBuild["worldIr"]) => unknown,
): LoadedWorldBuild {
  const worldIr = CanonicalWorldIrSchema.parse(transform(build.worldIr));
  const identity = BuildIdentitySchema.parse({
    schemaVersion: 1,
    worldIrSchemaVersion: 1,
    packageLockSchemaVersion: 1,
    compilerVersion: build.manifest.compilerVersion,
    engineVersion: build.manifest.engineVersion,
    irHash: semanticHash(worldIr),
    packageLockHash: semanticHash(build.packageLock),
    sourceDigest: build.manifest.sourceDigest,
  });
  const manifest = BuildManifestSchema.parse({
    ...identity,
    buildHash: semanticHash(identity),
    worldId: worldIr.world.id,
    artifacts: build.manifest.artifacts,
    provenance: build.manifest.provenance,
    diagnostics: build.manifest.diagnostics,
  });
  return { ...build, manifest, worldIr };
}

function appBuild(target?: TargetDescriptor): LoadedWorldBuild {
  const build = withWorldIr(loadedBuild(), (world) => ({
    ...world,
    scenarios: world.scenarios.map((scenario) => ({ ...scenario, faults: [] })),
    targets: target === undefined ? world.targets : [target],
    drills: world.drills.map((drill) => ({
      ...drill,
      assertions: [
        ...drill.assertions,
        {
          id: "parcel-released",
          kind: "state.value",
          packageId: "parcel-service",
          namespace: "parcels",
          rowId: "parcel-a",
          path: ["status"],
          comparison: { operator: "equals", value: "released" },
        },
      ],
    })),
  }));
  const bytes = Buffer.from("<!doctype html><title>Dispatch desk</title>");
  return {
    ...build,
    toolUis: [
      {
        packageId: "parcel-service",
        entry: "index.html",
        assets: [
          {
            path: "index.html",
            mediaType: "text/html; charset=utf-8",
            artifactHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            bytes,
          },
        ],
      },
    ],
  };
}

async function releaseThroughApp(link: string, tokenOverride?: string): Promise<Response> {
  const url = new URL(link);
  const token = tokenOverride ?? new URLSearchParams(url.hash.slice(1)).get("token");
  return fetch(`${url.origin}/_firedrill/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: url.origin, "content-type": "application/json" },
    body: JSON.stringify({
      operationId: "parcels.release",
      arguments: { parcelId: "parcel-a" },
      idempotencyKey: "release-one-parcel",
    }),
  });
}

describe("drill-owned Tool apps", () => {
  it("starts apps for direct-only targets and seals app actions through ordinary world assertions", async () => {
    let appLink = "";
    let token = "";
    const execution = await runDrillTrial({
      build: appBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: temporaryDirectory(),
      runDirectory: temporaryDirectory(),
      externalHandler: async (invocation, context) => {
        expect(context.world).toBeDefined();
        expect(Object.isFrozen(context.binding?.apps)).toBe(true);
        expect(context.binding?.apps).toHaveLength(1);
        const app = context.binding?.apps[0];
        if (app === undefined) throw new Error("Tool app was not supplied");
        appLink = app.url;
        token = new URLSearchParams(new URL(appLink).hash.slice(1)).get("token") ?? "";
        expect(JSON.parse(invocation.bindingEnvironment.FIREDRILL_TOOL_APPS ?? "null")).toEqual([app]);
        expect(invocation.bindingEnvironment.FIREDRILL_HTTP_URL).toBeUndefined();
        expect(await (await fetch(appLink)).text()).toContain("Dispatch desk");
        const contextEndpoint = `${new URL(appLink).origin}/_firedrill/context`;
        const contextHeaders = { authorization: `Bearer ${token}` };
        const before = (await (await fetch(contextEndpoint, { headers: contextHeaders })).json()) as {
          revision: { generation: number; evidenceSequence: number };
        };
        expect(before).toMatchObject({ actorId: "dispatcher", revision: { generation: 0 } });
        const response = await releaseThroughApp(appLink);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ outcome: { status: "ok", value: { released: true } } });
        const after = (await (await fetch(contextEndpoint, { headers: contextHeaders })).json()) as {
          revision: { generation: number; evidenceSequence: number };
        };
        expect(after.revision.evidenceSequence).toBeGreaterThan(before.revision.evidenceSequence);
        expect(await (await fetch(contextEndpoint, { headers: contextHeaders })).json()).toEqual(after);
        return { app, token, environment: invocation.bindingEnvironment.FIREDRILL_TOOL_APPS };
      },
    });
    expect(execution.result).toMatchObject({ status: "sealed", verdict: "passed" });
    expect(execution.result.interactions[0]).toMatchObject({
      bindingEvidence: "observed",
      targetResult: {
        status: "completed",
        output: {
          app: { packageId: "parcel-service", url: "[REDACTED]" },
          token: "[REDACTED]",
          environment: "[REDACTED]",
        },
      },
    });
    expect(execution.evidence.filter((entry) => entry.kind === "operation")).toHaveLength(1);
    expect(JSON.stringify(execution)).not.toContain(appLink);
    expect(JSON.stringify(execution)).not.toContain(token);
    const retained = SqliteWorldStore.open(execution.worldFilePath);
    try {
      expect(retained.readState("parcel-service", "parcels", "parcel-a")?.value).toEqual({
        status: "released",
      });
    } finally {
      retained.close();
    }
    await expect(fetch(appLink)).rejects.toThrow();
  });

  it("issues fresh app credentials for retry attempts and closes every prior attempt", async () => {
    const links: string[] = [];
    const execution = await runDrill({
      build: appBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: temporaryDirectory(),
      runDirectory: temporaryDirectory(),
      retries: 1,
      attemptFinished: async () => {
        const link = links.at(-1);
        if (link === undefined) throw new Error("attempt app was not supplied");
        await expect(fetch(link)).rejects.toThrow();
      },
      externalHandler: async (_invocation, context) => {
        const app = context.binding?.apps[0];
        if (app === undefined) throw new Error("Tool app was not supplied");
        const prior = links.at(-1);
        links.push(app.url);
        if (prior === undefined) return { attempted: false };
        const priorToken = new URLSearchParams(new URL(prior).hash.slice(1)).get("token");
        const rejected = await releaseThroughApp(app.url, priorToken ?? "");
        expect(rejected.status).toBe(401);
        await rejected.arrayBuffer();
        const response = await releaseThroughApp(app.url);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        return { attempted: true };
      },
    });
    expect(execution.trials[0]?.attempts).toHaveLength(2);
    expect(
      execution.trials[0]?.attempts.map((attempt) =>
        attempt.result.status === "sealed" ? attempt.result.verdict : attempt.result.status,
      ),
    ).toEqual(["failed", "passed"]);
    expect(new Set(links).size).toBe(2);
    for (const link of links) await expect(fetch(link)).rejects.toThrow();
  });

  it("provides apps to an actual command target and redacts credentials echoed in stdout and stderr", async () => {
    const script = `
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const invocation = JSON.parse(input);
      const serialized = process.env.FIREDRILL_TOOL_APPS;
      const apps = JSON.parse(serialized);
      if (JSON.stringify(apps) !== invocation.bindingEnvironment.FIREDRILL_TOOL_APPS) throw new Error("app environment mismatch");
      const app = apps[0];
      const url = new URL(app.url);
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      const page = await fetch(app.url);
      const html = await page.text();
      const response = await fetch(url.origin + "/_firedrill/invoke", {
        method: "POST", headers: { authorization: "Bearer " + token, origin: url.origin, "content-type": "application/json" },
        body: JSON.stringify({operationId:"parcels.release",arguments:{parcelId:"parcel-a"},idempotencyKey:"command-release"})
      });
      const outcome = await response.json();
      process.stderr.write(JSON.stringify({serialized, link:app.url, token}) + "\\n");
      process.stdout.write(JSON.stringify({packageId:app.packageId,origin:url.origin,link:app.url,token,serialized,html:html.includes("Dispatch desk"),outcome}));
    `;
    const execution = await runDrillTrial({
      build: appBuild({
        id: "parcel-agent",
        kind: "command",
        bindings: ["mcp"],
        executable: process.execPath,
        arguments: ["--input-type=module", "-e", script],
        environmentFromHost: {},
        timeoutMs: 5_000,
      }),
      drillId: "release-ready-parcel",
      repositoryRoot: temporaryDirectory(),
      runDirectory: temporaryDirectory(),
    });
    expect(execution.result).toMatchObject({ status: "sealed", verdict: "passed" });
    const target = execution.result.interactions[0]?.targetResult;
    expect(target).toMatchObject({
      status: "completed",
      output: {
        packageId: "parcel-service",
        link: "[REDACTED]",
        token: "[REDACTED]",
        serialized: "[REDACTED]",
        html: true,
        outcome: { outcome: { status: "ok" } },
      },
      attachments: [{ kind: "process.stderr", text: expect.stringContaining("[REDACTED]") }],
    });
    expect(JSON.stringify(execution)).not.toContain("#token=");
    const output = target?.output;
    if (
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output) ||
      typeof output.origin !== "string"
    )
      throw new Error("command target origin is missing");
    await expect(fetch(output.origin)).rejects.toThrow();
  });

  it("closes app listeners when a target times out and does not claim startup tested the agent", async () => {
    let link = "";
    const execution = await runDrillTrial({
      build: appBuild({ id: "parcel-agent", kind: "external", bindings: ["direct"], timeoutMs: 30 }),
      drillId: "release-ready-parcel",
      repositoryRoot: temporaryDirectory(),
      runDirectory: temporaryDirectory(),
      externalHandler: async (_invocation, context) => {
        link = context.binding?.apps[0]?.url ?? "";
        return new Promise(() => undefined);
      },
    });
    expect(link).not.toBe("");
    expect(execution.result.interactions[0]).toMatchObject({
      bindingEvidence: "issued",
      targetResult: { status: "timed_out" },
    });
    expect(execution.evidence.filter((entry) => entry.kind === "operation")).toHaveLength(0);
    await expect(fetch(link)).rejects.toThrow();
  });
});

describe("drill scenario materialization", () => {
  it("passes resolved scenario and drill rules to the shared kernel in scope order", () => {
    const operation = { packageId: "parcel-service", operationId: "parcels.release" };
    const scenarioRule: ResolvedToolOverride = {
      id: "scenario-result",
      operation,
      outcome: { kind: "return", value: { released: false } },
      scope: { kind: "scenario", scenarioId: "ready-for-release" },
    };
    const drillRule: ResolvedToolOverride = {
      id: "drill-result",
      operation,
      outcome: { kind: "return", value: { released: true } },
      times: 1,
      scope: { kind: "drill", drillId: "release-ready-parcel" },
    };
    const build = withWorldIr(loadedBuild(), (world) => ({
      ...world,
      scenarios: world.scenarios.map((scenario) => ({ ...scenario, toolOverrides: [scenarioRule] })),
      drills: world.drills.map((drill) => ({ ...drill, toolOverrides: [drillRule] })),
    }));
    expect(materializeDrillScenario(build, "release-ready-parcel").toolOverrides).toEqual([
      scenarioRule,
      drillRule,
    ]);
    const created = createDrillWorld({
      build,
      drillId: "release-ready-parcel",
      filePath: join(temporaryDirectory(), "world.sqlite"),
      worldInstanceId: "world_override001",
      correlationId: "corr_overridecreate001",
    });
    try {
      const client = created.clients.get("dispatcher");
      if (client === undefined) throw new Error("fixture has no dispatcher");
      const first = client.invoke(operation, { parcelId: "parcel-a" }, { idempotencyKey: "first" });
      expect(first.outcome).toEqual({ status: "ok", value: { released: true } });
      expect(first.evidence.find((entry) => entry.kind === "operation")?.toolOverride?.scope).toEqual(
        drillRule.scope,
      );
      const next = client.invoke(operation, { parcelId: "parcel-a" }, { idempotencyKey: "next" });
      expect(next.outcome).toEqual({ status: "ok", value: { released: false } });
      expect(next.evidence.find((entry) => entry.kind === "operation")?.toolOverride?.scope).toEqual(
        scenarioRule.scope,
      );
      expect(created.store.readState("parcel-service", "parcels", "parcel-a")?.value).toEqual({
        status: "ready",
      });
    } finally {
      created.store.close();
    }
  });

  it("resolves state actions and actor bindings deterministically", () => {
    const build = loadedBuild();
    const first = materializeDrillScenario(build, "release-ready-parcel");
    const second = materializeDrillScenario(build, "release-ready-parcel");

    expect(first).toEqual(second);
    expect(first.scenarioId).toBe("ready-for-release");
    expect(first.virtualTimeUs).toBe(100);
    expect(first.actors).toHaveLength(1);
    const actorBindingId = first.actors[0]?.bindingId;
    expect(actorBindingId).toMatch(/^actor_[0-9a-f]{64}$/);
    expect(first.state).toEqual([
      {
        packageId: "parcel-service",
        namespace: "parcels",
        rowId: "parcel-a",
        value: { status: "ready" },
      },
    ]);
    expect(first.initialEvents[0]?.actorBindingId).toBe(actorBindingId);
  });

  it("materializes standalone baseline and named scenarios without changing drill evidence", () => {
    const build = loadedBuild();
    const baseline = materializeWorldScenario(build);
    expect(baseline.virtualTimeUs).toBe(50);
    expect(baseline).not.toHaveProperty("drill");
    expect(baseline).not.toHaveProperty("scenarioId");
    const { drill: _drill, ...drillScenario } = materializeDrillScenario(build, "release-ready-parcel");
    expect(materializeWorldScenario(build, "ready-for-release")).toEqual(drillScenario);
    expect(() => materializeWorldScenario(build, "missing")).toThrow("build has no scenario missing");
    const directory = temporaryDirectory();
    const shared = { build, worldInstanceId: "world_same001", correlationId: "corr_same001", seed: "81" };
    const drill = createDrillWorld({
      ...shared,
      drillId: "release-ready-parcel",
      filePath: join(directory, "drill.sqlite"),
    });
    const standalone = createScenarioWorld({
      ...shared,
      scenarioId: "ready-for-release",
      filePath: join(directory, "standalone.sqlite"),
    });
    try {
      for (const created of [drill, standalone]) {
        created.clients
          .get("dispatcher")
          ?.invoke(
            { packageId: "parcel-service", operationId: "parcels.release" },
            { parcelId: "parcel-a" },
            { idempotencyKey: "same-call" },
          );
        created.kernel.advanceTime(120, { correlationId: "corr_clock001" });
      }
      expect(standalone.store.readEvidence()).toEqual(drill.store.readEvidence());
      expect(standalone.store.metadata()).toEqual(drill.store.metadata());
      expect(standalone.store.listScheduledEvents()).toEqual(drill.store.listScheduledEvents());
    } finally {
      standalone.store.close();
      drill.store.close();
    }
  });

  it("creates state, faults, actors, clock, and initial timers atomically in one world", () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "world.sqlite");
    const created = createDrillWorld({
      build: loadedBuild(),
      drillId: "release-ready-parcel",
      filePath,
      worldInstanceId: "world_drill001",
      correlationId: "corr_create001",
      seed: "99",
    });
    try {
      const actorBindingId = created.materialized.actors[0]?.bindingId;
      if (actorBindingId === undefined) throw new Error("fixture actor was not materialized");
      expect(created.store.metadata()).toMatchObject({ virtualTimeUs: 100, seed: "99" });
      expect(created.store.readState("parcel-service", "parcels", "parcel-a")?.value).toEqual({
        status: "ready",
      });
      expect(created.store.readState("parcel-service", "parcels", "parcel-b")).toBeNull();
      expect(created.store.listScheduledEvents("pending")).toMatchObject([
        {
          event: { packageId: "parcel-service", eventId: "parcel.ready" },
          payload: { parcelId: "parcel-a" },
          dueUs: 120,
          actorBindingId,
        },
      ]);

      const blocked = created.kernel.invoke({
        schemaVersion: 1,
        callId: "call_release01",
        correlationId: "corr_release01",
        operation: { packageId: "parcel-service", operationId: "parcels.release" },
        actorBindingId,
        arguments: { parcelId: "parcel-a" },
        idempotencyKey: "release-a",
      });
      expect(blocked.outcome).toMatchObject({
        status: "tool_error",
        error: { code: "tool.SCANNER_OFFLINE" },
      });

      const advanced = created.kernel.advanceTime(120, { correlationId: "corr_advance01" });
      expect(advanced.failures).toEqual([]);
      expect(created.store.readState("parcel-service", "notifications", "parcel-a")?.value).toEqual({
        observed: true,
      });
      expect(created.store.readEvidence().map((entry) => entry.kind)).toEqual(
        expect.arrayContaining(["lifecycle", "state_change", "event", "fault", "operation", "clock"]),
      );
    } finally {
      created.store.close();
    }
  });

  it("reports an unavailable drill before creating a database", () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "world.sqlite");
    expect(() =>
      createDrillWorld({
        build: loadedBuild(),
        drillId: "missing-drill",
        filePath,
        worldInstanceId: "world_drill002",
        correlationId: "corr_create002",
      }),
    ).toThrow(DrillSetupError);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("complete local drill trial", () => {
  it("checks an already-due event invariant before starting an equal-time target interaction", async () => {
    const directory = temporaryDirectory();
    const build = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      scenarios: worldIr.scenarios.map((scenario) => ({
        ...scenario,
        initialEvents: scenario.initialEvents.map((event) => ({ ...event, atUs: 100 })),
      })),
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: {
          ...drill.timeline,
          invariants: [
            {
              id: "no-notification-before-target",
              kind: "state.count",
              packageId: "parcel-service",
              namespace: "notifications",
              comparison: { operator: "equals", value: 0 },
            },
          ],
        },
      })),
    }));
    let invoked = false;
    const execution = await runDrillTrial({
      build,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "already-due-event"),
      externalHandler: () => {
        invoked = true;
        return {};
      },
    });
    expect(invoked).toBe(false);
    expect(execution.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      finishedAtVirtualUs: 100,
      interactions: [],
      checkpoints: [{ kind: "after_event", verdict: "failed" }, { kind: "final" }],
      budgetUsage: { scheduledEvents: { processed: 1, exhausted: false } },
    });
  });

  it("retains every event checkpoint when callback deadline inspection fails mid-advance", async () => {
    const directory = temporaryDirectory();
    const build = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      scenarios: worldIr.scenarios.map((scenario) => ({
        ...scenario,
        initialEvents: [scenario.initialEvents[0], { ...scenario.initialEvents[0], atUs: 121 }],
      })),
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: {
          ...drill.timeline,
          horizonUs: 50,
          interactions: drill.timeline.interactions.map((interaction) => ({
            ...interaction,
            afterStartUs: 50,
          })),
          invariants: [
            {
              id: "single-notification",
              kind: "state.count",
              packageId: "parcel-service",
              namespace: "notifications",
              comparison: { operator: "equals", value: 1 },
            },
          ],
        },
      })),
    }));
    const created = createDrillWorld({
      build,
      drillId: "release-ready-parcel",
      filePath: join(directory, "checkpoint-failure.sqlite"),
      worldInstanceId: "world_checkpointfailure",
      correlationId: "corr_checkpointfailure",
      seed: "12",
    });
    try {
      const failure = new Error("callback deadline inspection failed");
      const coordinator = new DrillTrialCoordinator({
        build,
        drillId: "release-ready-parcel",
        store: created.store,
        kernel: created.kernel,
        identity: {
          runId: "run_checkpointfailure",
          worldInstanceId: "world_checkpointfailure",
          trial: 1,
          trialCount: 1,
          attempt: 1,
          attemptLimit: 1,
          seed: "12",
        },
        callbacks: {
          flush: async () => undefined,
          nextDueUs: () => {
            if (created.store.metadata().virtualTimeUs >= 121) throw failure;
            return null;
          },
        },
      });
      await expect(coordinator.next()).rejects.toBe(failure);
      expect(coordinator.snapshot()).toMatchObject({
        processedEvents: 2,
        checkpointSequence: 2,
        checkpoints: [
          { kind: "after_event", virtualTimeUs: 120, verdict: "passed" },
          { kind: "after_event", virtualTimeUs: 121, verdict: "passed" },
        ],
      });
      expect(coordinator.fail(failure)).toMatchObject({
        status: "runner_failed",
        finishedAtVirtualUs: 121,
        budgetUsage: { scheduledEvents: { processed: 2, exhausted: false } },
      });
    } finally {
      created.store.close();
    }
  });

  it("runs real callback delivery and retry through the public trial coordinator path", async () => {
    const directory = temporaryDirectory();
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(received.length === 1 ? 503 : 204);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("receiver did not bind");
      const build = withWorldIr(loadedBuild(true), (worldIr) => ({
        ...worldIr,
        drills: worldIr.drills.map((drill) => ({
          ...drill,
          timeline: {
            ...drill.timeline,
            horizonUs: 50,
            invariants: [
              {
                id: "notification-not-duplicated",
                kind: "state.count",
                packageId: "parcel-service",
                namespace: "notifications",
                comparison: { operator: "less_than_or_equal", value: 1 },
              },
            ],
          },
          assertions: [
            {
              id: "dispatcher-notified",
              kind: "callback.count",
              callback: { packageId: "parcel-service", callbackId: "notify-dispatcher" },
              phase: "delivered",
              comparison: { operator: "equals", value: 1 },
            },
          ],
        })),
      }));
      const execution = await runDrillTrial({
        build,
        drillId: "release-ready-parcel",
        repositoryRoot: directory,
        runDirectory: join(directory, "callback-trial"),
        externalHandler: () => ({ waitingForNotification: true }),
        callbackReceivers: {
          "dispatch-application": { baseUrl: `http://127.0.0.1:${String(address.port)}` },
        },
      });
      expect(execution.result).toMatchObject({
        status: "sealed",
        verdict: "passed",
        finishedAtVirtualUs: 150,
        budgetUsage: { scheduledEvents: { processed: 1, exhausted: false } },
        checkpoints: [
          { kind: "after_interaction", virtualTimeUs: 100 },
          { kind: "after_event", virtualTimeUs: 120 },
          { kind: "horizon", virtualTimeUs: 150 },
          { kind: "final", virtualTimeUs: 150 },
        ],
      });
      expect(received).toEqual([
        { virtualTimeUs: 120, attempt: 1 },
        { virtualTimeUs: 125, attempt: 2 },
      ]);
      expect(
        execution.evidence.filter((entry) => entry.kind === "callback").map((entry) => entry.phase),
      ).toEqual(["queued", "attempt_started", "retry_scheduled", "attempt_started", "delivered"]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("resumes a settled interaction after a process-like restart without invoking it twice", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "resumable-world.sqlite");
    const build = loadedBuild();
    const identity = {
      runId: "run_resumable01",
      worldInstanceId: "world_resumable01",
      trial: 1,
      trialCount: 1,
      attempt: 1,
      attemptLimit: 1,
      seed: "77",
    } as const;
    const callbacks = {
      flush: async () => undefined,
      nextDueUs: () => null,
    };
    const created = createDrillWorld({
      build,
      drillId: "release-ready-parcel",
      filePath,
      worldInstanceId: identity.worldInstanceId,
      correlationId: "corr_resume_create01",
      seed: identity.seed,
    });

    const coordinator = new DrillTrialCoordinator({
      build,
      drillId: "release-ready-parcel",
      store: created.store,
      kernel: created.kernel,
      identity,
      callbacks,
    });
    const next = await coordinator.next();
    expect(next.kind).toBe("interaction");
    if (next.kind !== "interaction") throw new Error("fixture did not produce an interaction");
    const actorBindingId = created.materialized.actors[0]?.bindingId;
    if (actorBindingId === undefined) throw new Error("fixture actor was not materialized");
    created.kernel.invoke({
      schemaVersion: 1,
      callId: "call_resume_release01",
      correlationId: "corr_resume_release01",
      operation: { packageId: "parcel-service", operationId: "parcels.release" },
      actorBindingId,
      arguments: { parcelId: "parcel-a" },
      idempotencyKey: "resume-release-a",
    });
    const completed = await coordinator.complete({
      interactionId: next.pending.interaction.id,
      targetResult: {
        schemaVersion: 1,
        status: "completed",
        output: { acknowledged: true },
        attachments: [],
      },
      bindingEvidence: "observed",
      callsIssued: 1,
    });
    expect(completed.kind).toBe("ready_to_seal");
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({
      nextInteractionIndex: 1,
      interactions: [{ interactionId: "task" }],
    });
    created.store.close();

    const reopened = SqliteWorldStore.open(filePath);
    try {
      const kernel = new WorldKernel({
        store: reopened,
        packageLockHash: build.manifest.packageLockHash,
        tools: build.tools,
      });
      const resumed = new DrillTrialCoordinator({
        build,
        drillId: "release-ready-parcel",
        store: reopened,
        kernel,
        identity,
        callbacks,
        snapshot,
      });
      expect(await resumed.next()).toEqual({ kind: "ready_to_seal" });
      const result = await resumed.seal();
      expect(result).toMatchObject({
        status: "sealed",
        verdict: "passed",
        bindingEvidence: "observed",
        interactions: [{ interactionId: "task" }],
        budgetUsage: { toolCalls: { attempted: 1 } },
      });
      expect(
        reopened
          .readEvidence()
          .filter(
            (entry) => entry.kind === "operation" && entry.invocation.callId === "call_resume_release01",
          ),
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("accounts Tool-call budgets from the start of a coordinator window", async () => {
    const directory = temporaryDirectory();
    const build = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: { ...drill.timeline, maxToolCalls: 1 },
        assertions: drill.assertions.map((assertion) => ({
          ...assertion,
          comparison: { operator: "equals", value: 2 },
        })),
      })),
    }));
    const created = createDrillWorld({
      build,
      drillId: "release-ready-parcel",
      filePath: join(directory, "budget-window.sqlite"),
      worldInstanceId: "world_budgetwindow1",
      correlationId: "corr_budgetcreate1",
      seed: "91",
    });
    const actorBindingId = created.materialized.actors[0]?.bindingId;
    if (actorBindingId === undefined) throw new Error("fixture actor was not materialized");
    created.kernel.invoke({
      schemaVersion: 1,
      callId: "call_beforewindow1",
      correlationId: "corr_beforewindow1",
      operation: { packageId: "parcel-service", operationId: "parcels.release" },
      actorBindingId,
      arguments: { parcelId: "parcel-a" },
      idempotencyKey: "before-budget-window",
    });
    const kernel = new WorldKernel({
      store: created.store,
      packageLockHash: build.manifest.packageLockHash,
      tools: build.tools,
      budgets: { maxToolCalls: 2 },
    });
    const coordinator = new DrillTrialCoordinator({
      build,
      drillId: "release-ready-parcel",
      store: created.store,
      kernel,
      identity: {
        runId: "run_budgetwindow1",
        worldInstanceId: "world_budgetwindow1",
        trial: 1,
        trialCount: 1,
        attempt: 1,
        attemptLimit: 1,
        seed: "91",
      },
      callbacks: { flush: async () => undefined, nextDueUs: () => null },
    });
    const next = await coordinator.next();
    if (next.kind !== "interaction") throw new Error("fixture did not produce an interaction");
    kernel.invoke({
      schemaVersion: 1,
      callId: "call_insidewindow1",
      correlationId: "corr_insidewindow1",
      operation: { packageId: "parcel-service", operationId: "parcels.release" },
      actorBindingId,
      arguments: { parcelId: "parcel-a" },
      idempotencyKey: "inside-budget-window",
    });
    await coordinator.complete({
      interactionId: next.pending.interaction.id,
      targetResult: { schemaVersion: 1, status: "completed", attachments: [] },
      bindingEvidence: "observed",
      callsIssued: 1,
    });
    const result = await coordinator.seal();
    expect(result).toMatchObject({
      status: "sealed",
      verdict: "passed",
      budgetUsage: { toolCalls: { limit: 1, attempted: 1, rejected: 0 } },
    });
    created.store.close();
  });

  it("invokes the agent, evaluates assertions, seals hashes, and retains the world artifact", async () => {
    const directory = temporaryDirectory();
    let retainedWorld: BoundWorldClient | undefined;
    const execution = await runDrillTrial({
      build: loadedBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "runs"),
      runId: "run_complete01",
      worldInstanceId: "world_complete01",
      externalHandler: (_invocation, context) => {
        retainedWorld = context.world;
        const call = context.world?.invoke(
          { packageId: "parcel-service", operationId: "parcels.release" },
          { parcelId: "parcel-a" },
          { idempotencyKey: "release-parcel-a" },
        );
        return { outcome: call?.outcome.status ?? "missing" };
      },
    });

    expect(execution.result).toMatchObject({
      status: "sealed",
      verdict: "passed",
      bindingEvidence: "observed",
      interactions: [
        {
          interactionId: "task",
          targetResult: {
            status: "completed",
            output: { outcome: "tool_error" },
          },
        },
      ],
      assertionResults: [{ assertionId: "release-attempted", status: "passed", gate: true }],
    });
    expect(execution.evidence.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["lifecycle", "state_change", "operation", "fault"]),
    );
    expect(() =>
      retainedWorld?.invoke(
        { packageId: "parcel-service", operationId: "parcels.release" },
        { parcelId: "parcel-a" },
        { idempotencyKey: "late-release" },
      ),
    ).toThrow(/no longer active/);
    expect(existsSync(execution.worldFilePath)).toBe(true);
    const retained = SqliteWorldStore.open(execution.worldFilePath);
    try {
      expect(retained.stateHash()).toBe(
        execution.result.status === "sealed" ? execution.result.stateHash : undefined,
      );
      expect(retained.evidenceHash()).toBe(
        execution.result.status === "sealed" ? execution.result.evidenceHash : undefined,
      );
    } finally {
      retained.close();
    }
  });

  it("drives an MCP target through the real drill binding and official client", async () => {
    const directory = temporaryDirectory();
    const build = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      targets: [
        {
          id: "parcel-agent",
          kind: "external",
          bindings: ["mcp"],
          bindingEnvironment: {
            PARCEL_MCP_URL: "FIREDRILL_MCP_URL",
            PARCEL_MCP_TOKEN: "FIREDRILL_MCP_TOKEN",
          },
          timeoutMs: 30_000,
        },
      ],
    }));
    const execution = await runDrillTrial({
      build,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "mcp-runs"),
      externalHandler: async (invocation, context) => {
        expect(context.world).toBeUndefined();
        const endpoint = invocation.bindingEnvironment.PARCEL_MCP_URL;
        const token = invocation.bindingEnvironment.PARCEL_MCP_TOKEN;
        expect(endpoint).toBe(invocation.bindingEnvironment.FIREDRILL_MCP_URL);
        expect(token).toBe(invocation.bindingEnvironment.FIREDRILL_MCP_TOKEN);
        if (endpoint === undefined || token === undefined) throw new Error("MCP binding was not exposed");
        const mcp = new Client({ name: "firedrill-drill-e2e", version: "1.0.0" });
        try {
          await mcp.connect(
            new StreamableHTTPClientTransport(new URL(endpoint), {
              authProvider: { token: async () => token },
            }),
          );
          const result = await mcp.callTool({
            name: "parcel-service.parcels.release",
            arguments: { parcelId: "parcel-a" },
            _meta: { "dev.firedrill/idempotency-key": "release-parcel-a" },
          });
          return { isError: result.isError === true, response: result.structuredContent ?? null };
        } finally {
          await mcp.close();
        }
      },
    });

    expect(execution.result).toMatchObject({
      status: "sealed",
      verdict: "passed",
      bindingEvidence: "observed",
      interactions: [
        {
          targetResult: {
            status: "completed",
            output: {
              isError: true,
              response: { status: "tool_error", error: { code: "tool.SCANNER_OFFLINE" } },
            },
          },
        },
      ],
    });
    expect(
      execution.evidence.some(
        (entry) =>
          entry.kind === "operation" &&
          entry.invocation.operation.operationId === "parcels.release" &&
          entry.outcome.status === "tool_error",
      ),
    ).toBe(true);
  });

  it("drives a CLI-bound target through the real drill binding", async () => {
    const directory = temporaryDirectory();
    const build = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      targets: [{ id: "parcel-agent", kind: "external", bindings: ["cli"], timeoutMs: 30_000 }],
    }));
    const execution = await runDrillTrial({
      build,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "cli-runs"),
      externalHandler: async (invocation, context) => {
        expect(context.world).toBeUndefined();
        const result = await invokeCliWorldOperation({
          packageId: "parcel-service",
          operationId: "parcels.release",
          arguments: { parcelId: "parcel-a" },
          idempotencyKey: "release-parcel-a",
          environment: invocation.bindingEnvironment,
          signal: context.signal,
        });
        return result.outcome;
      },
    });

    expect(execution.result).toMatchObject({
      status: "sealed",
      verdict: "passed",
      bindingEvidence: "observed",
      interactions: [
        {
          targetResult: {
            status: "completed",
            output: { status: "tool_error", error: { code: "tool.SCANNER_OFFLINE" } },
          },
        },
      ],
    });
    expect(
      execution.evidence.some(
        (entry) =>
          entry.kind === "operation" &&
          entry.invocation.operation.operationId === "parcels.release" &&
          entry.outcome.status === "tool_error",
      ),
    ).toBe(true);
  });

  it("seals agent failures as failed drills and represents setup faults as runner failures", async () => {
    const directory = temporaryDirectory();
    const agentFailure = await runDrillTrial({
      build: loadedBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "agent-failure"),
      runId: "run_failure01",
      worldInstanceId: "world_failure01",
    });

    expect(agentFailure.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      interactions: [
        {
          targetResult: {
            status: "failed",
            error: { code: "target.EXTERNAL_HANDLER_REQUIRED" },
          },
        },
      ],
    });
    await expect(
      runDrillTrial({
        build: loadedBuild(),
        drillId: "missing-drill",
        repositoryRoot: directory,
        runDirectory: join(directory, "setup-failure"),
        runId: "run_failure02",
        worldInstanceId: "world_failure02",
      }),
    ).rejects.toMatchObject({ code: "framework.DRILL_NOT_FOUND" });
  });

  it("classifies malformed output, target timeout, and bounded world failure without rejecting", async () => {
    const directory = temporaryDirectory();
    const base = loadedBuild();

    const malformed = await runDrillTrial({
      build: base,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "malformed-output"),
      runId: "run_malformed01",
      worldInstanceId: "world_malformed01",
      externalHandler: () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return cyclic;
      },
    });
    expect(malformed.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      interactions: [{ targetResult: { status: "failed", error: { code: "target.INVALID_OUTPUT" } } }],
    });

    const timeoutBuild = withWorldIr(base, (worldIr) => ({
      ...worldIr,
      targets: worldIr.targets.map((target) => ({ ...target, timeoutMs: 20 })),
    }));
    let timeoutObserved = false;
    let lateCallRejected = false;
    const timedOut = await runDrillTrial({
      build: timeoutBuild,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "target-timeout"),
      runId: "run_timeout001",
      worldInstanceId: "world_timeout001",
      externalHandler: (_invocation, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              timeoutObserved = true;
              try {
                context.world?.invoke(
                  { packageId: "parcel-service", operationId: "parcels.release" },
                  { parcelId: "parcel-a" },
                  { idempotencyKey: "late-timeout-release" },
                );
              } catch {
                lateCallRejected = true;
              }
              resolve({ stopped: true });
            },
            { once: true },
          );
        }),
    });
    expect(timeoutObserved).toBe(true);
    expect(lateCallRejected).toBe(true);
    expect(timedOut.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      interactions: [{ targetResult: { status: "timed_out", error: { code: "target.TIMEOUT" } } }],
      assertionResults: [{ assertionId: "release-attempted", status: "failed", actual: 0 }],
    });

    const worldFailureBuild = withWorldIr(base, (worldIr) => ({
      ...worldIr,
      scenarios: worldIr.scenarios.map((scenario) => ({
        ...scenario,
        initialEvents: [
          ...scenario.initialEvents,
          {
            event: { packageId: "parcel-service", eventId: "parcel.ready" },
            payload: { parcelId: "parcel-a" },
            atUs: 121,
            actorId: "dispatcher",
          },
        ],
      })),
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: { ...drill.timeline, horizonUs: 100, maxEvents: 1 },
      })),
    }));
    const worldFailed = await runDrillTrial({
      build: worldFailureBuild,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "world-failure"),
      runId: "run_worldfail01",
      worldInstanceId: "world_worldfail01",
      externalHandler: () => ({ completed: true }),
    });
    expect(worldFailed.result).toMatchObject({
      status: "runner_failed",
      error: { source: "world", code: "world.EVENT_BUDGET_EXCEEDED" },
      budgetUsage: {
        scheduledEvents: { limit: 1, processed: 1, exhausted: true },
      },
      interactions: [{ targetResult: { status: "completed" } }],
      assertionResults: [],
    });
  });

  it("runs every requested trial with a reproducible independent seed", async () => {
    const directory = temporaryDirectory();
    const execution = await runDrill({
      build: loadedBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "runs"),
      trialCount: 2,
      externalHandler: (_invocation, context) => {
        context.world?.invoke(
          { packageId: "parcel-service", operationId: "parcels.release" },
          { parcelId: "parcel-a" },
          { idempotencyKey: "release-parcel-a" },
        );
        return { attempted: true };
      },
    });

    expect(execution).toMatchObject({ verdict: "passed", passed: 2, failed: 0, inconclusive: 0 });
    expect(execution.trials.map((trial) => trial.result.identity.seed)).toEqual(["17", "18"]);
    expect(new Set(execution.trials.map((trial) => trial.worldFilePath)).size).toBe(2);
  });

  it("stops a trial after its cumulative Tool-call budget and retains the rejected call", async () => {
    const directory = temporaryDirectory();
    const limited = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: { ...drill.timeline, maxToolCalls: 1 },
      })),
    }));
    const execution = await runDrillTrial({
      build: limited,
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "tool-budget"),
      runId: "run_toolbudget1",
      worldInstanceId: "world_toolbudget1",
      externalHandler: (_invocation, context) => {
        context.world?.invoke(
          { packageId: "parcel-service", operationId: "parcels.release" },
          { parcelId: "parcel-a" },
          { idempotencyKey: "first-release" },
        );
        context.world?.invoke(
          { packageId: "parcel-service", operationId: "parcels.release" },
          { parcelId: "parcel-a" },
          { idempotencyKey: "second-release" },
        );
        return { attempted: 2 };
      },
    });

    expect(execution.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      budgetUsage: {
        toolCalls: { limit: 1, attempted: 2, rejected: 1 },
        scheduledEvents: { processed: 0, exhausted: false },
      },
      interactions: [
        {
          targetResult: {
            status: "failed",
            error: { code: "framework.TOOL_CALL_BUDGET_EXCEEDED" },
          },
        },
      ],
    });
    const operations = execution.evidence.filter((entry) => entry.kind === "operation");
    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({
      outcome: { status: "tool_error", error: { code: "world.TOOL_CALL_BUDGET_EXCEEDED" } },
    });
  });

  it("runs a multi-actor workload across hours of virtual time with durable invariant checkpoints", async () => {
    const directory = temporaryDirectory();
    const hourUs = 3_600_000_000;
    const startUs = 100;
    const workload = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      scenarios: worldIr.scenarios.map((scenario) => ({
        ...scenario,
        actors: [
          ...scenario.actors,
          {
            id: "observer",
            attributes: { depot: "south" },
            grants: [{ packageId: "parcel-service", operationId: "parcels.release" }],
          },
        ],
        faults: [],
        initialEvents: [
          {
            ...scenario.initialEvents[0],
            atUs: startUs + 2 * hourUs,
          },
        ],
      })),
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: {
          horizonUs: 6 * hourUs,
          maxEvents: 10,
          stopOnInvariantFailure: true,
          interactions: [],
          workloads: [
            {
              id: "release-check",
              actorIds: ["dispatcher", "observer"],
              task: { instruction: "Release or confirm the ready parcel." },
              startAfterUs: 0,
              everyUs: 4 * hourUs,
              occurrences: 2,
            },
          ],
          invariants: [
            {
              id: "notification-not-duplicated",
              kind: "state.count",
              packageId: "parcel-service",
              namespace: "notifications",
              comparison: { operator: "less_than_or_equal", value: 1 },
            },
          ],
        },
        assertions: [
          {
            id: "release-attempted-four-times",
            kind: "operation.count",
            operation: { packageId: "parcel-service", operationId: "parcels.release" },
            comparison: { operator: "equals", value: 4 },
          },
          {
            id: "ready-event-handled-once",
            kind: "event.count",
            event: { packageId: "parcel-service", eventId: "parcel.ready" },
            phase: "handled",
            comparison: { operator: "equals", value: 1 },
          },
        ],
      })),
    }));
    const observed: Array<{ interactionId: string; actorId: string }> = [];
    const run = (runId: `run_${string}`, worldInstanceId: `world_${string}`, runDirectory: string) =>
      runDrillTrial({
        build: workload,
        drillId: "release-ready-parcel",
        repositoryRoot: directory,
        runDirectory,
        runId,
        worldInstanceId,
        seed: "71",
        externalHandler: (invocation, context) => {
          observed.push({ interactionId: invocation.interactionId, actorId: invocation.actorId });
          const call = context.world?.invoke(
            { packageId: "parcel-service", operationId: "parcels.release" },
            { parcelId: "parcel-a" },
            { idempotencyKey: `release-${invocation.interactionId}` },
          );
          return { outcome: call?.outcome.status ?? "missing" };
        },
      });

    const first = await run("run_timeline01", "world_timeline01", join(directory, "first"));
    const second = await run("run_timeline02", "world_timeline02", join(directory, "second"));

    expect(first.result).toMatchObject({
      status: "sealed",
      verdict: "passed",
      startedAtVirtualUs: startUs,
      finishedAtVirtualUs: startUs + 6 * hourUs,
      interactions: [
        {
          interactionId: "release-check-1-1",
          actorId: "dispatcher",
          scheduledAtVirtualUs: startUs,
        },
        {
          interactionId: "release-check-1-2",
          actorId: "observer",
          scheduledAtVirtualUs: startUs,
        },
        {
          interactionId: "release-check-2-1",
          actorId: "dispatcher",
          scheduledAtVirtualUs: startUs + 4 * hourUs,
        },
        {
          interactionId: "release-check-2-2",
          actorId: "observer",
          scheduledAtVirtualUs: startUs + 4 * hourUs,
        },
      ],
      assertionResults: [
        { assertionId: "release-attempted-four-times", status: "passed" },
        { assertionId: "ready-event-handled-once", status: "passed" },
      ],
    });
    expect(observed.slice(0, 4)).toEqual([
      { interactionId: "release-check-1-1", actorId: "dispatcher" },
      { interactionId: "release-check-1-2", actorId: "observer" },
      { interactionId: "release-check-2-1", actorId: "dispatcher" },
      { interactionId: "release-check-2-2", actorId: "observer" },
    ]);
    expect(first.result.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
      "after_interaction",
      "after_interaction",
      "after_event",
      "after_interaction",
      "after_interaction",
      "horizon",
      "final",
    ]);
    expect(first.evidence.filter((entry) => entry.kind === "verification")).toHaveLength(8);
    expect(first.result.status === "sealed" && second.result.status === "sealed").toBe(true);
    if (first.result.status === "sealed" && second.result.status === "sealed") {
      expect(second.result.stateHash).toBe(first.result.stateHash);
      expect(second.result.evidenceHash).not.toBe(first.result.evidenceHash);
      expect(second.result.trajectoryHash).toBe(first.result.trajectoryHash);
    }
  });

  it("stops a workload at the first failing event invariant and reproduces the failure", async () => {
    const directory = temporaryDirectory();
    const hourUs = 3_600_000_000;
    const startUs = 100;
    const workload = withWorldIr(loadedBuild(), (worldIr) => ({
      ...worldIr,
      scenarios: worldIr.scenarios.map((scenario) => ({
        ...scenario,
        faults: [],
        initialEvents: [{ ...scenario.initialEvents[0], atUs: startUs + 2 * hourUs }],
      })),
      drills: worldIr.drills.map((drill) => ({
        ...drill,
        timeline: {
          horizonUs: 8 * hourUs,
          maxEvents: 10,
          stopOnInvariantFailure: true,
          interactions: [
            {
              id: "initial-request",
              afterStartUs: 0,
              actorId: "dispatcher",
              task: { instruction: "Release the ready parcel." },
            },
            {
              id: "late-follow-up",
              afterStartUs: 6 * hourUs,
              actorId: "dispatcher",
              task: { instruction: "Check the parcel again." },
            },
          ],
          invariants: [
            {
              id: "no-notification-created",
              kind: "state.count",
              packageId: "parcel-service",
              namespace: "notifications",
              comparison: { operator: "equals", value: 0 },
            },
          ],
        },
        assertions: [
          {
            id: "only-initial-agent-call-ran",
            kind: "operation.count",
            operation: { packageId: "parcel-service", operationId: "parcels.release" },
            comparison: { operator: "equals", value: 1 },
          },
        ],
      })),
    }));
    let invocations = 0;
    const execute = (runId: `run_${string}`, worldInstanceId: `world_${string}`, folder: string) =>
      runDrillTrial({
        build: workload,
        drillId: "release-ready-parcel",
        repositoryRoot: directory,
        runDirectory: join(directory, folder),
        runId,
        worldInstanceId,
        seed: "83",
        externalHandler: (invocation, context) => {
          invocations += 1;
          context.world?.invoke(
            { packageId: "parcel-service", operationId: "parcels.release" },
            { parcelId: "parcel-a" },
            { idempotencyKey: `release-${invocation.interactionId}` },
          );
          return { attempted: true };
        },
      });

    const first = await execute("run_invariant01", "world_invariant01", "first-failure");
    const second = await execute("run_invariant02", "world_invariant02", "second-failure");
    expect(invocations).toBe(2);
    expect(first.result).toMatchObject({
      status: "sealed",
      verdict: "failed",
      finishedAtVirtualUs: startUs + 2 * hourUs,
      interactions: [{ interactionId: "initial-request" }],
      checkpoints: [
        { kind: "after_interaction", verdict: "passed" },
        {
          kind: "after_event",
          verdict: "failed",
          assertionResults: [{ assertionId: "no-notification-created", status: "failed" }],
        },
        { kind: "final", verdict: "passed" },
      ],
    });
    if (first.result.status === "sealed" && second.result.status === "sealed") {
      expect(second.result.trajectoryHash).toBe(first.result.trajectoryHash);
    }
  });

  it("seals cancellation and does not start later trials", async () => {
    const directory = temporaryDirectory();
    const controller = new AbortController();
    let invocations = 0;
    const pending = runDrill({
      build: loadedBuild(),
      drillId: "release-ready-parcel",
      repositoryRoot: directory,
      runDirectory: join(directory, "cancelled-runs"),
      trialCount: 3,
      signal: controller.signal,
      externalHandler: (_invocation, context) => {
        invocations += 1;
        queueMicrotask(() => controller.abort());
        return new Promise((resolve) => {
          context.signal.addEventListener("abort", () => resolve({ stopped: true }), { once: true });
        });
      },
    });

    const execution = await pending;

    expect(invocations).toBe(1);
    expect(execution).toMatchObject({
      verdict: "inconclusive",
      passed: 0,
      failed: 0,
      inconclusive: 1,
      trials: [
        {
          result: {
            status: "cancelled",
            interactions: [{ targetResult: { status: "cancelled", error: { code: "target.CANCELLED" } } }],
          },
        },
      ],
    });
  });
});
