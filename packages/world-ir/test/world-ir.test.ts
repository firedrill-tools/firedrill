import { describe, expect, it } from "vitest";
import {
  BuildIdentitySchema,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  semanticHash,
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
  });
});
