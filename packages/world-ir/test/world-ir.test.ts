import { CheckpointResultSchema, EvidenceEntrySchema } from "@firedrill/contracts";
import { describe, expect, it } from "vitest";
import {
  BuildIdentitySchema,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  ResolvedRunSetupSchema,
  semanticHash,
  trajectoryHash,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const tool = {
  schemaVersion: 1,
  id: "reservations",
  version: "1.2.0",
  engine: ">=0.1.0 <0.2.0",
  capabilities: ["state.read", "state.write"],
  state: [{ namespace: "slots", schema: { type: "object" } }],
  operations: [
    {
      id: "slots.reserve",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      idempotency: "required",
      fidelity: "stateful",
    },
  ],
} as const;

const world = {
  schemaVersion: 1,
  engineVersion: "0.1.0",
  world: { id: "appointments", seed: "42" },
  tools: [tool],
  baseline: {
    virtualTimeUs: 0,
    actors: [
      {
        id: "scheduler",
        grants: [{ packageId: "reservations", operationId: "slots.reserve" }],
      },
    ],
    state: [
      {
        action: "upsert",
        packageId: "reservations",
        namespace: "slots",
        rowId: "morning",
        value: { available: true },
      },
    ],
  },
  scenarios: [
    {
      schemaVersion: 1,
      id: "busy-morning",
      virtualTimeUs: 0,
      actors: [
        {
          id: "scheduler",
          grants: [{ packageId: "reservations", operationId: "slots.reserve" }],
        },
      ],
    },
  ],
  targets: [{ id: "booking-agent", kind: "external", bindings: ["http"], timeoutMs: 30_000 }],
  drills: [
    {
      schemaVersion: 1,
      id: "reserve-one-slot",
      targetId: "booking-agent",
      scenarioId: "busy-morning",
      timeline: {
        horizonUs: 0,
        maxEvents: 10_000,
        stopOnInvariantFailure: true,
        interactions: [
          {
            id: "task",
            afterStartUs: 0,
            actorId: "scheduler",
            task: { instruction: "Reserve one slot." },
          },
        ],
        invariants: [],
      },
      trials: { count: 1, classification: "contract" },
      assertions: [
        {
          id: "one-reservation",
          kind: "operation.count",
          operation: { packageId: "reservations", operationId: "slots.reserve" },
          comparison: { operator: "equals", value: 1 },
        },
      ],
    },
  ],
} as const;

describe("canonical world IR", () => {
  it("accepts a complete generic world and resolves its cross-resource references", () => {
    const parsed = CanonicalWorldIrSchema.parse(world);
    expect(parsed.world.id).toBe("appointments");
    expect(parsed.drills[0]?.id).toBe("reserve-one-slot");
  });

  it("rejects unknown state, operation, event, fault, scenario, target, and actor references", () => {
    const invalid = structuredClone(world) as Record<string, unknown>;
    invalid.baseline = {
      virtualTimeUs: 0,
      actors: [{ id: "scheduler", grants: [{ packageId: "reservations", operationId: "missing" }] }],
      state: [
        {
          action: "upsert",
          packageId: "reservations",
          namespace: "missing",
          rowId: "one",
          value: {},
        },
      ],
    };
    const result = CanonicalWorldIrSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(
      /unknown operation[\s\S]*unknown state namespace/,
    );
  });

  it("validates inline scenarios against the same Tool graph as named scenarios", () => {
    const inline = structuredClone(world) as Record<string, unknown>;
    inline.scenarios = [];
    inline.drills = [
      {
        ...world.drills[0],
        scenarioId: undefined,
        inlineScenario: {
          virtualTimeUs: 0,
          actors: [
            {
              id: "scheduler",
              grants: [{ packageId: "reservations", operationId: "missing" }],
            },
          ],
          state: [
            {
              action: "upsert",
              packageId: "reservations",
              namespace: "missing",
              rowId: "one",
              value: {},
            },
          ],
          faults: [{ packageId: "reservations", faultId: "missing" }],
          initialEvents: [
            {
              event: { packageId: "reservations", eventId: "missing" },
              payload: {},
              atUs: 0,
              actorId: "scheduler",
            },
          ],
        },
      },
    ];
    const result = CanonicalWorldIrSchema.safeParse(inline);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message).join("\n") ?? "";
    expect(messages).toMatch(/unknown operation/);
    expect(messages).toMatch(/unknown state namespace/);
    expect(messages).toMatch(/unknown fault/);
    expect(messages).toMatch(/unknown event/);
  });

  it("rejects a callback assertion that does not resolve to a declared Tool callback", () => {
    const invalid = structuredClone(world) as Record<string, unknown>;
    invalid.drills = [
      {
        ...world.drills[0],
        assertions: [
          {
            id: "application-notified",
            kind: "callback.count",
            callback: { packageId: "reservations", callbackId: "missing" },
            phase: "delivered",
            comparison: { operator: "equals", value: 1 },
          },
        ],
      },
    ];
    const result = CanonicalWorldIrSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "assertion references unknown callback reservations.missing",
    );
  });

  it("requires canonical ordering rather than making array order part of identity by accident", () => {
    const extraTool = { ...tool, id: "audit", operations: [{ ...tool.operations[0], id: "entries.add" }] };
    const result = CanonicalWorldIrSchema.safeParse({ ...world, tools: [tool, extraTool] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "tools must be sorted by stable identity",
    );
  });

  it("rejects overlapping HTTP routes across unrelated Tool packages", () => {
    const route = {
      id: "reserve-slot",
      operationId: "slots.reserve",
      method: "POST",
      path: "/api/slots/{slotId}",
      auth: { kind: "bearer" },
      requestBody: "json",
      response: { successStatus: 200, errors: [] },
    } as const;
    const competing = {
      ...tool,
      id: "alternate-reservations",
      operations: [{ ...tool.operations[0], id: "book" }],
      http: [
        {
          ...route,
          id: "book-slot",
          operationId: "book",
          path: "/api/slots/special",
        },
      ],
    } as const;
    const result = CanonicalWorldIrSchema.safeParse({
      ...world,
      tools: [{ ...competing }, { ...tool, http: [route] }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(/HTTP route overlaps/);
  });

  it("resolves suite drill references and tag selection against canonical drills", () => {
    const valid = CanonicalWorldIrSchema.parse({
      ...world,
      drills: [{ ...world.drills[0], tags: ["smoke"] }],
      suites: [{ schemaVersion: 1, id: "pr", drills: [], tags: ["smoke"] }],
    });
    expect(valid.suites[0]?.id).toBe("pr");

    const unknown = CanonicalWorldIrSchema.safeParse({
      ...world,
      suites: [{ schemaVersion: 1, id: "pr", drills: ["missing"], tags: [] }],
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues.map((issue) => issue.message)).toContain(
      "suite references unknown drill missing",
    );
  });
});

describe("locked immutable build identity", () => {
  it("binds a run-local setup hash to its full canonical contents", () => {
    const identity = {
      schemaVersion: 1 as const,
      drillId: "reserve-one-slot",
      setup: {
        scenario: {
          actors: [],
          state: [
            {
              action: "upsert" as const,
              packageId: "reservations",
              namespace: "slots",
              rowId: "afternoon",
              value: { available: true },
            },
          ],
          faults: [],
          initialEvents: [],
        },
        tools: { packages: [], behaviorOverrides: [] },
        bindings: { environment: {} },
      },
    };
    const setup = ResolvedRunSetupSchema.parse({ ...identity, setupHash: semanticHash(identity) });
    expect(setup.setup.scenario?.state[0]?.rowId).toBe("afternoon");
    expect(
      ResolvedRunSetupSchema.safeParse({
        ...setup,
        setup: {
          ...setup.setup,
          scenario: {
            ...setup.setup.scenario,
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
      }).success,
    ).toBe(false);
  });

  it("locks exact Tool artifacts and rejects noncanonical package ordering", () => {
    const first = {
      packageId: "audit",
      version: "1.0.0",
      manifestHash: HASH_A,
      artifactHash: HASH_B,
      artifactPath: "tools/audit.mjs",
      exportName: "default",
      moduleFormat: "esm",
      source: { kind: "repository" },
    } as const;
    expect(
      PackageLockSchema.safeParse({
        schemaVersion: 1,
        engineVersion: "0.1.0",
        packages: [{ ...first, packageId: "reservations" }, first],
      }).success,
    ).toBe(false);
  });

  it("detects a forged build hash", () => {
    const identity = BuildIdentitySchema.parse({
      schemaVersion: 1,
      worldIrSchemaVersion: 1,
      packageLockSchemaVersion: 1,
      compilerVersion: "0.1.0",
      engineVersion: "0.1.0",
      irHash: HASH_A,
      packageLockHash: HASH_B,
      sourceDigest: semanticHash([{ kind: "world", id: "appointments", contentHash: HASH_A }]),
    });
    const base = {
      ...identity,
      worldId: "appointments",
      artifacts: { worldIr: "world.ir.json", packageLock: "packages.lock.json" },
      provenance: [{ kind: "world", id: "appointments", contentHash: HASH_A }],
      diagnostics: { errors: 0, warnings: 0, info: 0 },
    } as const;
    expect(BuildManifestSchema.parse({ ...base, buildHash: semanticHash(identity) }).worldId).toBe(
      "appointments",
    );
    expect(BuildManifestSchema.safeParse({ ...base, buildHash: HASH_A }).success).toBe(false);
    expect(
      BuildManifestSchema.safeParse({
        ...base,
        artifacts: { ...base.artifacts, setup: "run-setup.json" },
        buildHash: semanticHash(identity),
      }).success,
    ).toBe(false);
  });
});

describe("behavioral trajectory identity", () => {
  it("ignores transport and storage identities while retaining the observed actor", () => {
    const operation = (input: {
      callId: string;
      correlationId: string;
      transactionId: string;
      actorBindingId: string;
    }) =>
      EvidenceEntrySchema.parse({
        schemaVersion: 1,
        kind: "operation",
        sequence: 1,
        transactionId: input.transactionId,
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 10,
        correlationId: input.correlationId,
        invocation: {
          schemaVersion: 1,
          callId: input.callId,
          correlationId: input.correlationId,
          operation: { packageId: "reservations", operationId: "slots.reserve" },
          actorBindingId: input.actorBindingId,
          arguments: { slot: "morning" },
          idempotencyKey: `${input.callId}-key`,
        },
        actorId: "scheduler",
        outcome: { status: "ok", value: { reserved: true } },
        idempotency: "recorded",
      });

    const first = operation({
      callId: "call_compare01",
      correlationId: "corr_compare01",
      transactionId: "txn_compare01",
      actorBindingId: "actor_compare01",
    });
    const second = operation({
      callId: "call_compare02",
      correlationId: "corr_compare02",
      transactionId: "txn_compare02",
      actorBindingId: "actor_compare02",
    });

    expect(semanticHash(first)).not.toBe(semanticHash(second));
    expect(trajectoryHash({ interactions: [], checkpoints: [], evidence: [first] })).toBe(
      trajectoryHash({ interactions: [], checkpoints: [], evidence: [second] }),
    );

    const differentActor = EvidenceEntrySchema.parse({ ...second, actorId: "reviewer" });
    expect(trajectoryHash({ interactions: [], checkpoints: [], evidence: [differentActor] })).not.toBe(
      trajectoryHash({ interactions: [], checkpoints: [], evidence: [first] }),
    );

    const lifecycle = (input: {
      correlationId: string;
      transactionId: string;
      worldInstanceId: string;
      snapshotId: string;
      artifactHash: string;
    }) =>
      EvidenceEntrySchema.parse({
        schemaVersion: 1,
        kind: "lifecycle",
        sequence: 1,
        transactionId: input.transactionId,
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 10,
        correlationId: input.correlationId,
        action: "snapshot_created",
        worldInstanceId: input.worldInstanceId,
        snapshotId: input.snapshotId,
        details: { artifactHash: input.artifactHash },
      });
    const firstSnapshot = lifecycle({
      correlationId: "corr_snapshot01",
      transactionId: "txn_snapshot01",
      worldInstanceId: "world_snapshot01",
      snapshotId: "snap_snapshot01",
      artifactHash: HASH_A,
    });
    const secondSnapshot = lifecycle({
      correlationId: "corr_snapshot02",
      transactionId: "txn_snapshot02",
      worldInstanceId: "world_snapshot02",
      snapshotId: "snap_snapshot02",
      artifactHash: HASH_B,
    });
    expect(trajectoryHash({ interactions: [], checkpoints: [], evidence: [firstSnapshot] })).toBe(
      trajectoryHash({ interactions: [], checkpoints: [], evidence: [secondSnapshot] }),
    );

    if (second.kind !== "operation") throw new Error("operation fixture parsed to the wrong evidence kind");
    const shiftedOperation = EvidenceEntrySchema.parse({
      ...second,
      sequence: 2,
      transactionId: "txn_compare03",
      correlationId: "corr_compare03",
      invocation: {
        ...second.invocation,
        callId: "call_compare03",
        correlationId: "corr_compare03",
        idempotencyKey: "call_compare03-key",
      },
    });
    const checkpoint = (evidenceSequence: number) =>
      CheckpointResultSchema.parse({
        schemaVersion: 1,
        checkpointId: "final",
        kind: "final",
        virtualTimeUs: 10,
        verdict: "passed",
        assertionResults: [
          {
            schemaVersion: 1,
            assertionId: "operation-observed",
            kind: "operation.count",
            status: "passed",
            gate: true,
            message: "operation count matched",
            expected: { operator: "equals", value: 1 },
            actual: 1,
            location: {
              subject: "operation",
              operations: [{ packageId: "reservations", operationId: "slots.reserve" }],
            },
            diff: { operator: "equals", matched: true, details: {} },
            evidenceSequences: [evidenceSequence],
          },
        ],
      });
    expect(trajectoryHash({ interactions: [], checkpoints: [checkpoint(1)], evidence: [first] })).toBe(
      trajectoryHash({
        interactions: [],
        checkpoints: [checkpoint(2)],
        evidence: [firstSnapshot, shiftedOperation],
      }),
    );
  });

  it("normalizes opaque scheduled-event and callback-delivery identities", () => {
    const scheduled = (sequence: number, scheduledEventId: string) =>
      EvidenceEntrySchema.parse({
        schemaVersion: 1,
        kind: "event",
        sequence,
        transactionId: `txn_scheduled${sequence}`,
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 10,
        correlationId: `corr_scheduled${sequence}`,
        event: { packageId: "reservations", eventId: "slot.released" },
        phase: "scheduled",
        payload: { slot: "morning" },
        scheduledEventId,
        scheduledForUs: 20,
      });
    const callback = (sequence: number, deliveryId: string) =>
      EvidenceEntrySchema.parse({
        schemaVersion: 1,
        kind: "callback",
        sequence,
        transactionId: `txn_callback${sequence}`,
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 10,
        correlationId: `corr_callback${sequence}`,
        callback: { packageId: "reservations", callbackId: "notify-release" },
        deliveryId,
        receiverId: "application",
        event: { packageId: "reservations", eventId: "slot.released" },
        phase: "queued",
        idempotencyKey: deliveryId,
        scheduledForUs: 10,
      });

    const first = [scheduled(1, "pending_00000001_0001"), callback(2, "delivery_00000002_0001")];
    const shifted = [scheduled(7, "pending_00000007_0001"), callback(8, "delivery_00000008_0001")];
    expect(semanticHash(first)).not.toBe(semanticHash(shifted));
    expect(trajectoryHash({ interactions: [], checkpoints: [], evidence: first })).toBe(
      trajectoryHash({ interactions: [], checkpoints: [], evidence: shifted }),
    );
  });
});
