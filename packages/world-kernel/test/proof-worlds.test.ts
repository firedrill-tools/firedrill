import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, OperationInvocation, OperationRef } from "@firedrill-tools/contracts";
import type { ToolDefinition } from "@firedrill-tools/tool-sdk";
import { defineTool, ToolFailure } from "@firedrill-tools/tool-sdk";
import type { SqliteWorldStore as SqliteStore } from "@firedrill-tools/world-store-sqlite";
import { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorldKernel } from "../src/index.js";

const BUILD_HASH = `sha256:${"c".repeat(64)}` as const;
const LOCK_HASH = `sha256:${"d".repeat(64)}` as const;
const ACTOR_BINDING_ID = "actor_proof01" as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface InitialState {
  readonly packageId: string;
  readonly namespace: string;
  readonly rowId: string;
  readonly value: JsonObject;
}

interface ProofWorld {
  readonly id: string;
  readonly tools: readonly ToolDefinition[];
  readonly grants: readonly OperationRef[];
  readonly actorAttributes?: JsonObject;
  readonly state?: readonly InitialState[];
  readonly preRead: OperationInvocation;
  readonly mutation: OperationInvocation;
  readonly postRead: OperationInvocation;
  readonly consequenceRead: OperationInvocation;
  readonly expectedPostRead: JsonObject;
  readonly expectedConsequence: JsonObject;
  readonly domainFailure: OperationInvocation;
  readonly domainErrorCode: string;
  readonly activeFault: { readonly packageId: string; readonly faultId: string };
  readonly faultErrorCode: string;
}

function invocation(
  suffix: string,
  operation: OperationRef,
  arguments_: JsonObject,
  idempotencyKey?: string,
): OperationInvocation {
  return {
    schemaVersion: 1,
    callId: `call_${suffix}`,
    correlationId: `corr_${suffix}`,
    operation,
    actorBindingId: ACTOR_BINDING_ID,
    arguments: arguments_,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function createWorld(
  proof: ProofWorld,
  activeFaults: readonly { readonly packageId: string; readonly faultId: string }[] = [],
): { readonly kernel: WorldKernel; readonly store: SqliteStore } {
  const directory = mkdtempSync(join(tmpdir(), `firedrill-${proof.id}-`));
  temporaryDirectories.push(directory);
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: `world_${proof.id}01`,
    buildHash: BUILD_HASH,
    packageLockHash: LOCK_HASH,
    seed: "91",
    virtualTimeUs: 10_000,
    correlationId: `corr_${proof.id}create`,
    actors: [
      {
        bindingId: ACTOR_BINDING_ID,
        actorId: "developer",
        attributes: proof.actorAttributes ?? {},
        grants: proof.grants,
      },
    ],
    state: proof.state ?? [],
    activeFaults,
  });
  return {
    store,
    kernel: new WorldKernel({ store, packageLockHash: LOCK_HASH, tools: proof.tools }),
  };
}

function sourceControlTools(): readonly ToolDefinition[] {
  const sourceControl = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "source-control",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [{ namespace: "changes", schema: { type: "object" } }],
      operations: [
        {
          id: "changes.submit",
          inputSchema: {
            type: "object",
            required: ["changeId", "branch", "files"],
            properties: {
              changeId: { type: "string" },
              branch: { type: "string" },
              files: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["changeId", "status"],
            properties: { changeId: { type: "string" }, status: { const: "queued" } },
            additionalProperties: false,
          },
          declaredErrors: ["PROTECTED_BRANCH", "HOST_UNAVAILABLE"],
          idempotency: "required",
          fidelity: "behavioral",
        },
        {
          id: "changes.get",
          inputSchema: {
            type: "object",
            required: ["changeId"],
            properties: { changeId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: {
              found: { type: "boolean" },
              changeId: { type: "string" },
              branch: { type: "string" },
              files: { type: "integer" },
              status: { type: "string" },
            },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      events: [
        {
          id: "change.submitted",
          payloadSchema: {
            type: "object",
            required: ["changeId", "files"],
            properties: { changeId: { type: "string" }, files: { type: "integer" } },
            additionalProperties: false,
          },
        },
      ],
      faults: [
        {
          id: "host-unavailable",
          appliesTo: ["changes.submit"],
          timing: "before",
          error: { code: "HOST_UNAVAILABLE", message: "source host is unavailable", retryable: true },
        },
      ],
    },
    operations: {
      "changes.submit": (input, context) => {
        const changeId = String(input.changeId);
        const branch = String(input.branch);
        const files = Number(input.files);
        if (branch === "main" && context.actor.attributes.role !== "maintainer") {
          throw new ToolFailure({
            code: "PROTECTED_BRANCH",
            message: "direct changes to the protected branch are not allowed",
          });
        }
        context.state.put("changes", changeId, {
          found: true,
          changeId,
          branch,
          files,
          status: "queued",
        });
        context.events.emit("change.submitted", { changeId, files });
        return { changeId, status: "queued" };
      },
      "changes.get": (input, context) =>
        context.state.get("changes", String(input.changeId)) ?? { found: false },
    },
  });

  const pipelineRunner = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "pipeline-runner",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "runs", schema: { type: "object" } }],
      operations: [
        {
          id: "runs.get",
          inputSchema: {
            type: "object",
            required: ["changeId"],
            properties: { changeId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: {
              found: { type: "boolean" },
              changeId: { type: "string" },
              status: { type: "string" },
              jobs: { type: "integer" },
            },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      subscriptions: [
        { id: "queue-submitted-change", event: { packageId: "source-control", eventId: "change.submitted" } },
      ],
    },
    operations: {
      "runs.get": (input, context) => context.state.get("runs", String(input.changeId)) ?? { found: false },
    },
    subscriptions: {
      "queue-submitted-change": (payload, context) => {
        const changeId = String(payload.changeId);
        context.state.put("runs", changeId, {
          found: true,
          changeId,
          status: "waiting",
          jobs: Number(payload.files),
        });
      },
    },
  });

  return [sourceControl, pipelineRunner];
}

function buildingControlTools(): readonly ToolDefinition[] {
  const controls = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "building-controls",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [{ namespace: "targets", schema: { type: "object" } }],
      operations: [
        {
          id: "targets.set",
          inputSchema: {
            type: "object",
            required: ["zone", "celsius"],
            properties: { zone: { type: "string" }, celsius: { type: "number" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["zone", "celsius"],
            properties: { zone: { type: "string" }, celsius: { type: "number" } },
            additionalProperties: false,
          },
          declaredErrors: ["OUT_OF_RANGE", "CONTROLLER_OFFLINE"],
          idempotency: "required",
          fidelity: "behavioral",
        },
        {
          id: "targets.get",
          inputSchema: {
            type: "object",
            required: ["zone"],
            properties: { zone: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: { found: { type: "boolean" }, zone: { type: "string" }, celsius: { type: "number" } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      events: [
        {
          id: "target.changed",
          payloadSchema: {
            type: "object",
            required: ["zone", "celsius"],
            properties: { zone: { type: "string" }, celsius: { type: "number" } },
            additionalProperties: false,
          },
        },
      ],
      faults: [
        {
          id: "controller-offline",
          appliesTo: ["targets.set"],
          timing: "before",
          error: {
            code: "CONTROLLER_OFFLINE",
            message: "zone controller is offline",
            retryable: true,
          },
        },
      ],
    },
    operations: {
      "targets.set": (input, context) => {
        const zone = String(input.zone);
        const celsius = Number(input.celsius);
        if (celsius < 16 || celsius > 30) {
          throw new ToolFailure({
            code: "OUT_OF_RANGE",
            message: "target must be between 16 and 30 degrees",
            details: { minimum: 16, maximum: 30, requested: celsius },
          });
        }
        context.state.put("targets", zone, { found: true, zone, celsius });
        context.events.emit("target.changed", { zone, celsius });
        return { zone, celsius };
      },
      "targets.get": (input, context) => context.state.get("targets", String(input.zone)) ?? { found: false },
    },
  });

  const loadMonitor = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "load-monitor",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "forecasts", schema: { type: "object" } }],
      operations: [
        {
          id: "forecasts.get",
          inputSchema: {
            type: "object",
            required: ["zone"],
            properties: { zone: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: { found: { type: "boolean" }, zone: { type: "string" }, watts: { type: "integer" } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      subscriptions: [
        { id: "forecast-target-load", event: { packageId: "building-controls", eventId: "target.changed" } },
      ],
    },
    operations: {
      "forecasts.get": (input, context) =>
        context.state.get("forecasts", String(input.zone)) ?? { found: false },
    },
    subscriptions: {
      "forecast-target-load": (payload, context) => {
        const zone = String(payload.zone);
        const celsius = Number(payload.celsius);
        context.state.put("forecasts", zone, {
          found: true,
          zone,
          watts: Math.round(400 + Math.abs(celsius - 21) * 125),
        });
      },
    },
  });

  return [controls, loadMonitor];
}

function laboratoryTools(): readonly ToolDefinition[] {
  const registry = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "sample-registry",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [{ namespace: "samples", schema: { type: "object" } }],
      operations: [
        {
          id: "samples.record",
          inputSchema: {
            type: "object",
            required: ["sampleId", "massMg", "sealed"],
            properties: {
              sampleId: { type: "string" },
              massMg: { type: "number" },
              sealed: { type: "boolean" },
            },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["sampleId", "accepted"],
            properties: { sampleId: { type: "string" }, accepted: { const: true } },
            additionalProperties: false,
          },
          declaredErrors: ["CONTAMINATED", "INSTRUMENT_BUSY"],
          idempotency: "required",
          fidelity: "behavioral",
        },
        {
          id: "samples.get",
          inputSchema: {
            type: "object",
            required: ["sampleId"],
            properties: { sampleId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: {
              found: { type: "boolean" },
              sampleId: { type: "string" },
              massMg: { type: "number" },
              status: { type: "string" },
            },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      events: [
        {
          id: "sample.recorded",
          payloadSchema: {
            type: "object",
            required: ["sampleId", "massMg"],
            properties: { sampleId: { type: "string" }, massMg: { type: "number" } },
            additionalProperties: false,
          },
        },
      ],
      faults: [
        {
          id: "instrument-busy",
          appliesTo: ["samples.record"],
          timing: "before",
          error: { code: "INSTRUMENT_BUSY", message: "intake instrument is busy", retryable: true },
        },
      ],
    },
    operations: {
      "samples.record": (input, context) => {
        const sampleId = String(input.sampleId);
        const massMg = Number(input.massMg);
        if (input.sealed !== true) {
          throw new ToolFailure({ code: "CONTAMINATED", message: "sample container is not sealed" });
        }
        context.state.put("samples", sampleId, { found: true, sampleId, massMg, status: "received" });
        context.events.emit("sample.recorded", { sampleId, massMg });
        return { sampleId, accepted: true };
      },
      "samples.get": (input, context) =>
        context.state.get("samples", String(input.sampleId)) ?? { found: false },
    },
  });

  const analysisQueue = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "analysis-queue",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "jobs", schema: { type: "object" } }],
      operations: [
        {
          id: "jobs.get",
          inputSchema: {
            type: "object",
            required: ["sampleId"],
            properties: { sampleId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: {
              found: { type: "boolean" },
              sampleId: { type: "string" },
              priority: { type: "string" },
              status: { type: "string" },
            },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      subscriptions: [
        { id: "queue-recorded-sample", event: { packageId: "sample-registry", eventId: "sample.recorded" } },
      ],
    },
    operations: {
      "jobs.get": (input, context) => context.state.get("jobs", String(input.sampleId)) ?? { found: false },
    },
    subscriptions: {
      "queue-recorded-sample": (payload, context) => {
        const sampleId = String(payload.sampleId);
        context.state.put("jobs", sampleId, {
          found: true,
          sampleId,
          priority: Number(payload.massMg) < 10 ? "high" : "normal",
          status: "queued",
        });
      },
    },
  });

  return [registry, analysisQueue];
}

const proofWorlds: readonly ProofWorld[] = [
  {
    id: "repository",
    tools: sourceControlTools(),
    actorAttributes: { role: "contributor" },
    grants: [
      { packageId: "source-control", operationId: "changes.submit" },
      { packageId: "source-control", operationId: "changes.get" },
      { packageId: "pipeline-runner", operationId: "runs.get" },
    ],
    preRead: invocation(
      "reporead01",
      { packageId: "source-control", operationId: "changes.get" },
      { changeId: "change-7" },
    ),
    mutation: invocation(
      "reposubmit1",
      { packageId: "source-control", operationId: "changes.submit" },
      { changeId: "change-7", branch: "feature/safe-change", files: 3 },
      "submit-change-7",
    ),
    postRead: invocation(
      "reporead02",
      { packageId: "source-control", operationId: "changes.get" },
      { changeId: "change-7" },
    ),
    consequenceRead: invocation(
      "reporun001",
      { packageId: "pipeline-runner", operationId: "runs.get" },
      { changeId: "change-7" },
    ),
    expectedPostRead: {
      found: true,
      changeId: "change-7",
      branch: "feature/safe-change",
      files: 3,
      status: "queued",
    },
    expectedConsequence: { found: true, changeId: "change-7", status: "waiting", jobs: 3 },
    domainFailure: invocation(
      "repodenied1",
      { packageId: "source-control", operationId: "changes.submit" },
      { changeId: "change-8", branch: "main", files: 1 },
      "submit-change-8",
    ),
    domainErrorCode: "tool.PROTECTED_BRANCH",
    activeFault: { packageId: "source-control", faultId: "host-unavailable" },
    faultErrorCode: "tool.HOST_UNAVAILABLE",
  },
  {
    id: "facility",
    tools: buildingControlTools(),
    grants: [
      { packageId: "building-controls", operationId: "targets.set" },
      { packageId: "building-controls", operationId: "targets.get" },
      { packageId: "load-monitor", operationId: "forecasts.get" },
    ],
    state: [
      {
        packageId: "building-controls",
        namespace: "targets",
        rowId: "north-lab",
        value: { found: true, zone: "north-lab", celsius: 21 },
      },
    ],
    preRead: invocation(
      "facilityread1",
      { packageId: "building-controls", operationId: "targets.get" },
      { zone: "north-lab" },
    ),
    mutation: invocation(
      "facilityset01",
      { packageId: "building-controls", operationId: "targets.set" },
      { zone: "north-lab", celsius: 24 },
      "set-north-lab-24",
    ),
    postRead: invocation(
      "facilityread2",
      { packageId: "building-controls", operationId: "targets.get" },
      { zone: "north-lab" },
    ),
    consequenceRead: invocation(
      "facilityload1",
      { packageId: "load-monitor", operationId: "forecasts.get" },
      { zone: "north-lab" },
    ),
    expectedPostRead: { found: true, zone: "north-lab", celsius: 24 },
    expectedConsequence: { found: true, zone: "north-lab", watts: 775 },
    domainFailure: invocation(
      "facilityrange1",
      { packageId: "building-controls", operationId: "targets.set" },
      { zone: "north-lab", celsius: 41 },
      "set-north-lab-41",
    ),
    domainErrorCode: "tool.OUT_OF_RANGE",
    activeFault: { packageId: "building-controls", faultId: "controller-offline" },
    faultErrorCode: "tool.CONTROLLER_OFFLINE",
  },
  {
    id: "laboratory",
    tools: laboratoryTools(),
    grants: [
      { packageId: "sample-registry", operationId: "samples.record" },
      { packageId: "sample-registry", operationId: "samples.get" },
      { packageId: "analysis-queue", operationId: "jobs.get" },
    ],
    preRead: invocation(
      "labread001",
      { packageId: "sample-registry", operationId: "samples.get" },
      { sampleId: "sample-12" },
    ),
    mutation: invocation(
      "labrecord1",
      { packageId: "sample-registry", operationId: "samples.record" },
      { sampleId: "sample-12", massMg: 7.5, sealed: true },
      "record-sample-12",
    ),
    postRead: invocation(
      "labread002",
      { packageId: "sample-registry", operationId: "samples.get" },
      { sampleId: "sample-12" },
    ),
    consequenceRead: invocation(
      "labqueue01",
      { packageId: "analysis-queue", operationId: "jobs.get" },
      { sampleId: "sample-12" },
    ),
    expectedPostRead: {
      found: true,
      sampleId: "sample-12",
      massMg: 7.5,
      status: "received",
    },
    expectedConsequence: {
      found: true,
      sampleId: "sample-12",
      priority: "high",
      status: "queued",
    },
    domainFailure: invocation(
      "labreject1",
      { packageId: "sample-registry", operationId: "samples.record" },
      { sampleId: "sample-13", massMg: 12, sealed: false },
      "record-sample-13",
    ),
    domainErrorCode: "tool.CONTAMINATED",
    activeFault: { packageId: "sample-registry", faultId: "instrument-busy" },
    faultErrorCode: "tool.INSTRUMENT_BUSY",
  },
];

describe("generic execution proof", () => {
  it.each(proofWorlds)("$id supports durable runtime fault controls without changing Tool code", (proof) => {
    const { kernel, store } = createWorld(proof);
    const baseline = join(store.filePath, "..", "baseline.sqlite");
    try {
      store.createSnapshot(baseline, "corr_faultbaseline");
      const enabled = kernel.setFault({ ...proof.activeFault, active: true }, "corr_faultenable");
      expect(enabled).toMatchObject({ active: true, previouslyActive: false, changed: true });
      expect(enabled.evidence).toMatchObject([{ kind: "fault_control", ...proof.activeFault, active: true }]);
      expect(kernel.invoke(proof.mutation).outcome).toMatchObject({
        status: "tool_error",
        error: { code: proof.faultErrorCode },
      });
      expect(kernel.setFault({ ...proof.activeFault, active: true }, "corr_faultrepeat").changed).toBe(false);
      const disabled = kernel.setFault({ ...proof.activeFault, active: false }, "corr_faultdisable");
      expect(disabled).toMatchObject({ active: false, previouslyActive: true, changed: true });
      expect(
        kernel.invoke({ ...proof.mutation, callId: "call_afterdisable", correlationId: "corr_afterdisable" })
          .outcome.status,
      ).toBe("ok");
      const observed = store.readEvidence();
      const reopened = SqliteWorldStore.open(store.filePath);
      try {
        expect(reopened.readEvidence()).toEqual(observed);
        expect(reopened.listActiveFaults()).toEqual([]);
      } finally {
        reopened.close();
      }
      kernel.setFault({ ...proof.activeFault, active: true }, "corr_faultagain");
      store.resetFromSnapshot(baseline, "corr_faultreset");
      expect(store.listActiveFaults()).toEqual([]);
      expect(store.readEvidence().some((entry) => entry.kind === "fault_control")).toBe(false);
    } finally {
      store.close();
    }
  });

  it.each(proofWorlds)(
    "$id world supplies its own reads, mutations, domain failures, faults, events, and cross-Tool consequences",
    (proof) => {
      const { kernel, store } = createWorld(proof);
      const before = kernel.invoke(proof.preRead);
      expect(before.outcome.status).toBe("ok");

      const changed = kernel.invoke(proof.mutation);
      expect(changed.outcome.status).toBe("ok");
      expect(changed.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "state_change" }),
          expect.objectContaining({ kind: "event", phase: "emitted" }),
          expect.objectContaining({ kind: "event", phase: "handled" }),
        ]),
      );

      expect(kernel.invoke(proof.postRead).outcome).toMatchObject({
        status: "ok",
        value: proof.expectedPostRead,
      });
      expect(kernel.invoke(proof.consequenceRead).outcome).toMatchObject({
        status: "ok",
        value: proof.expectedConsequence,
      });

      const stateBeforeFailure = store.stateHash();
      const failed = kernel.invoke(proof.domainFailure);
      expect(failed.outcome).toMatchObject({
        status: "tool_error",
        error: { code: proof.domainErrorCode },
      });
      expect(store.stateHash()).toBe(stateBeforeFailure);
      expect(failed.evidence).toHaveLength(1);
      expect(failed.evidence[0]).toMatchObject({
        kind: "operation",
        idempotency: "not_recorded",
      });
      store.close();

      const faultedWorld = createWorld(proof, [proof.activeFault]);
      const stateBeforeFault = faultedWorld.store.stateHash();
      const faulted = faultedWorld.kernel.invoke(proof.mutation);
      expect(faulted.outcome).toMatchObject({
        status: "tool_error",
        error: { code: proof.faultErrorCode },
      });
      expect(faulted.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "fault" })]));
      expect(faulted.evidence[0]).toMatchObject({
        kind: "operation",
        idempotency: "not_recorded",
      });
      expect(faultedWorld.store.stateHash()).toBe(stateBeforeFault);
      faultedWorld.store.close();
    },
  );
});
