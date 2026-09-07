import { describe, expect, it } from "vitest";
import {
  ActorDefinitionSchema,
  AssertionDefinitionSchema,
  AssertionResultSchema,
  DiagnosticSchema,
  DrillDefinitionSchema,
  DrillShardSchema,
  DrillSuiteDefinitionSchema,
  ErrorEnvelopeSchema,
  EvidenceEntrySchema,
  OperationInvocationSchema,
  OperationOutcomeSchema,
  RunResultSchema,
  RunWorldSetupSchema,
  ScenarioDefinitionSchema,
  ToolPackageManifestSchema,
  TargetDescriptorSchema,
  TargetFileAttachmentSchema,
  canonicalJson,
  expandDrillInteractions,
} from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const OPERATION = { packageId: "calendar", operationId: "events.create" } as const;

const error = {
  schemaVersion: 1,
  code: "tool.CONFLICT",
  source: "tool",
  message: "the event overlaps another event",
  retryable: false,
  issues: [],
} as const;

describe("canonical JSON", () => {
  it("normalizes recursively without changing array order", () => {
    const left = canonicalJson({ z: [{ b: 2, a: 1 }], a: -0 });
    const right = canonicalJson({ a: 0, z: [{ a: 1, b: 2 }] });
    expect(left).toBe(right);
    expect(left).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
  });

  it("rejects non-JSON numeric values", () => {
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/non-finite/);
  });

  it("treats an undefined optional object property as absent but rejects it in an array", () => {
    const withUndefined = { present: true, optional: undefined } as unknown as { present: true };
    expect(canonicalJson(withUndefined)).toBe('{"present":true}');
    expect(() => canonicalJson([undefined] as unknown as [])).toThrow(/undefined/);
  });
});

describe("target file attachments", () => {
  it("keeps only portable content metadata and rejects path-shaped names", () => {
    expect(
      TargetFileAttachmentSchema.parse({
        schemaVersion: 1,
        kind: "file",
        id: "attachment-browser-trace",
        name: "trace.zip",
        mediaType: "application/zip",
        bytes: 2048,
        hash: HASH,
        redaction: { status: "not_applied" },
      }),
    ).toMatchObject({
      name: "trace.zip",
      redaction: { status: "not_applied", note: null },
    });
    expect(
      TargetFileAttachmentSchema.safeParse({
        schemaVersion: 1,
        kind: "file",
        id: "attachment-browser-trace",
        name: "../trace.zip",
        mediaType: "application/zip",
        bytes: 2048,
        hash: HASH,
        redaction: { status: "not_applied" },
      }).success,
    ).toBe(false);
  });
});

describe("drill suite contracts", () => {
  it("keeps suite policy repository-owned and validates deterministic sharding", () => {
    expect(
      DrillSuiteDefinitionSchema.parse({
        schemaVersion: 1,
        id: "pull-request",
        drills: ["critical-safety"],
        tags: ["smoke"],
        concurrency: 4,
        retries: 1,
      }),
    ).toMatchObject({ id: "pull-request", concurrency: 4, retries: 1 });
    expect(DrillShardSchema.parse({ index: 3, total: 4 })).toEqual({ index: 3, total: 4 });
    expect(DrillShardSchema.safeParse({ index: 4, total: 4 }).success).toBe(false);
    expect(
      DrillSuiteDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "bad-order",
        drills: ["z-last", "a-first"],
      }).success,
    ).toBe(false);
  });
});

describe("generic Tool contracts", () => {
  it("accepts a package without any Firedrill reference-world name", () => {
    const parsed = ToolPackageManifestSchema.parse({
      schemaVersion: 1,
      id: "calendar",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: ["state.read", "state.write", "event.emit"],
      state: [{ namespace: "events", schema: { type: "object" } }],
      operations: [
        {
          id: "events.create",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          declaredErrors: ["CONFLICT", "TIMEOUT"],
          idempotency: "optional",
          fidelity: "stateful",
        },
      ],
      events: [{ id: "event.created", payloadSchema: { type: "object" } }],
      faults: [
        {
          id: "write-timeout",
          appliesTo: ["events.create"],
          timing: "after_commit",
          error: { code: "TIMEOUT", message: "the response timed out", retryable: true },
        },
      ],
      subscriptions: [
        {
          id: "sync-created-events",
          event: { packageId: "messaging", eventId: "message.received" },
        },
      ],
    });
    expect(parsed.operations[0]?.id).toBe("events.create");
    expect(parsed.events[0]?.id).toBe("event.created");
    expect(parsed.subscriptions[0]?.event.packageId).toBe("messaging");
  });

  it("supports single-segment operation ids because packages already provide the namespace", () => {
    const parsed = ToolPackageManifestSchema.parse({
      schemaVersion: 1,
      id: "search",
      version: "1.0.0+fixture",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "query",
          inputSchema: {},
          outputSchema: {},
          idempotency: "none",
          fidelity: "contract",
        },
      ],
    });
    expect(parsed.operations[0]?.id).toBe("query");
  });

  it("rejects duplicate operations", () => {
    const base = {
      schemaVersion: 1,
      id: "calendar",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "events.create",
          inputSchema: {},
          outputSchema: {},
          idempotency: "none",
          fidelity: "contract",
        },
        {
          id: "events.create",
          inputSchema: {},
          outputSchema: {},
          idempotency: "none",
          fidelity: "contract",
        },
      ],
    };
    const result = ToolPackageManifestSchema.safeParse(base);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain("duplicate operation id");
  });

  it("rejects faults for unknown operations and duplicate event identities", () => {
    const result = ToolPackageManifestSchema.safeParse({
      schemaVersion: 1,
      id: "calendar",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "events.create",
          inputSchema: {},
          outputSchema: {},
          idempotency: "none",
          fidelity: "contract",
        },
      ],
      events: [
        { id: "event.created", payloadSchema: {} },
        { id: "event.created", payloadSchema: {} },
      ],
      faults: [
        {
          id: "missing-operation",
          appliesTo: ["events.delete"],
          timing: "before",
          error: { code: "UNAVAILABLE", message: "calendar unavailable", retryable: true },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "fault references unknown operation events.delete",
        "events must not contain duplicate ids",
      ]),
    );
  });

  it("validates wire HTTP routes against semantic operations and declared errors", () => {
    const manifest = {
      schemaVersion: 1,
      id: "ledger",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "entries.create",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          declaredErrors: ["CONFLICT"],
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
      http: [
        {
          id: "create-entry",
          operationId: "entries.create",
          method: "POST",
          path: "/v2/accounts/{accountId}/entries",
          auth: { kind: "bearer" },
          requestBody: "json",
          response: {
            successStatus: 201,
            errors: [{ code: "CONFLICT", status: 409 }],
          },
        },
      ],
    } as const;
    const parsed = ToolPackageManifestSchema.parse(manifest);
    expect(parsed.http[0]?.path).toBe("/v2/accounts/{accountId}/entries");

    const incomplete = ToolPackageManifestSchema.safeParse({
      ...manifest,
      http: [{ ...manifest.http[0], response: { successStatus: 201, errors: [] } }],
    });
    expect(incomplete.success).toBe(false);
    expect(incomplete.error?.issues.map((issue) => issue.message)).toContain(
      "HTTP route does not map declared error CONFLICT",
    );

    const overlapping = ToolPackageManifestSchema.safeParse({
      ...manifest,
      http: [
        manifest.http[0],
        {
          ...manifest.http[0],
          id: "create-special-entry",
          path: "/v2/accounts/special/entries",
        },
      ],
    });
    expect(overlapping.success).toBe(false);
    expect(overlapping.error?.issues.map((issue) => issue.message)).toContain(
      "HTTP route overlaps POST /v2/accounts/{accountId}/entries",
    );

    const reserved = ToolPackageManifestSchema.safeParse({
      ...manifest,
      http: [
        {
          ...manifest.http[0],
          id: "replace-discovery",
          method: "GET",
          path: "/v1/tools",
        },
      ],
    });
    expect(reserved.success).toBe(false);
    expect(reserved.error?.issues.map((issue) => issue.message)).toContain(
      "HTTP route conflicts with a framework route at GET /v1/tools",
    );
  });

  it("bounds official-client compatibility claims to declared HTTP routes and flows", () => {
    const manifest = {
      schemaVersion: 1,
      id: "issue-tracker",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "issues.get",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "validated",
        },
      ],
      http: [
        {
          id: "get-issue",
          operationId: "issues.get",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues/{issueNumber}",
          auth: { kind: "bearer", schemes: ["Bearer", "token"] },
          requestBody: "none",
          response: { successStatus: 200, errors: [] },
        },
      ],
      compatibility: [
        {
          id: "official-js-client",
          mode: "translated",
          protocol: "http",
          service: "Issue tracker",
          apiVersion: "2026-03-10",
          client: { ecosystem: "npm", name: "@example/client", version: "4.2.0" },
          configuration: { endpoint: "baseUrl", credential: "auth" },
          routes: [{ routeId: "get-issue", clientMethod: "issues.get" }],
          flows: [
            {
              id: "read-one",
              description: "Read one issue through the official client.",
              routeIds: ["get-issue"],
            },
          ],
          limitations: ["Only the listed route is covered."],
        },
      ],
    } as const;
    const parsed = ToolPackageManifestSchema.parse(manifest);
    expect(parsed.compatibility[0]?.routes[0]?.routeId).toBe("get-issue");
    expect(parsed.http[0]?.auth).toEqual({ kind: "bearer", schemes: ["Bearer", "token"] });

    const unknownRoute = ToolPackageManifestSchema.safeParse({
      ...manifest,
      compatibility: [
        {
          ...manifest.compatibility[0],
          routes: [{ routeId: "create-issue", clientMethod: "issues.create" }],
          flows: [
            {
              id: "create-one",
              description: "Create one issue.",
              routeIds: ["create-issue"],
            },
          ],
        },
      ],
    });
    expect(unknownRoute.success).toBe(false);
    expect(unknownRoute.error?.issues.map((issue) => issue.message)).toContain(
      "compatibility profile references unknown HTTP route create-issue",
    );

    const uncoveredFlowRoute = ToolPackageManifestSchema.safeParse({
      ...manifest,
      compatibility: [
        {
          ...manifest.compatibility[0],
          flows: [
            {
              id: "invalid-flow",
              description: "Claims an uncovered route.",
              routeIds: ["create-issue"],
            },
          ],
        },
      ],
    });
    expect(uncoveredFlowRoute.success).toBe(false);
    expect(uncoveredFlowRoute.error?.issues.map((issue) => issue.message)).toContain(
      "flow references uncovered compatibility route create-issue",
    );
  });

  it("accepts the default Bearer scheme and rejects duplicate case-insensitive schemes", () => {
    const base = {
      schemaVersion: 1,
      id: "documents",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: [],
      operations: [
        {
          id: "documents.get",
          inputSchema: {},
          outputSchema: {},
          idempotency: "none",
          fidelity: "contract",
        },
      ],
      http: [
        {
          id: "get-document",
          operationId: "documents.get",
          method: "GET",
          path: "/documents/{documentId}",
          auth: { kind: "bearer" },
          requestBody: "none",
          response: { successStatus: 200, errors: [] },
        },
      ],
    } as const;
    expect(ToolPackageManifestSchema.parse(base).http[0]?.auth).toEqual({
      kind: "bearer",
      schemes: ["Bearer"],
    });
    expect(
      ToolPackageManifestSchema.safeParse({
        ...base,
        http: [{ ...base.http[0], auth: { kind: "bearer", schemes: ["Bearer", "bearer"] } }],
      }).success,
    ).toBe(false);
  });
});

describe("agent target contracts", () => {
  it("requires explicit, unique bindings and rejects direct access for out-of-process targets", () => {
    expect(
      TargetDescriptorSchema.safeParse({
        id: "command-agent",
        kind: "command",
        bindings: ["http", "mcp"],
        executable: "node",
        timeoutMs: 1_000,
      }).success,
    ).toBe(true);
    expect(
      TargetDescriptorSchema.safeParse({
        id: "command-agent",
        kind: "command",
        bindings: ["direct"],
        executable: "node",
        timeoutMs: 1_000,
      }).success,
    ).toBe(false);
    expect(
      TargetDescriptorSchema.safeParse({
        id: "module-agent",
        kind: "module",
        bindings: ["mcp", "mcp"],
        module: "agent.ts",
        timeoutMs: 1_000,
      }).success,
    ).toBe(false);
  });

  it("accepts only aliases backed by a declared world protocol", () => {
    expect(
      TargetDescriptorSchema.parse({
        id: "command-agent",
        kind: "command",
        bindings: ["mcp"],
        bindingEnvironment: {
          AGENT_MCP_URL: "FIREDRILL_MCP_URL",
          AGENT_MCP_TOKEN: "FIREDRILL_MCP_TOKEN",
        },
        executable: "node",
        timeoutMs: 1_000,
      }).bindingEnvironment,
    ).toEqual({
      AGENT_MCP_URL: "FIREDRILL_MCP_URL",
      AGENT_MCP_TOKEN: "FIREDRILL_MCP_TOKEN",
    });
    expect(
      TargetDescriptorSchema.safeParse({
        id: "command-agent",
        kind: "command",
        bindings: ["mcp"],
        bindingEnvironment: { SERVICE_URL: "FIREDRILL_HTTP_URL" },
        executable: "node",
        timeoutMs: 1_000,
      }).success,
    ).toBe(false);
    expect(
      TargetDescriptorSchema.safeParse({
        id: "command-agent",
        kind: "command",
        bindings: ["mcp"],
        bindingEnvironment: { FIREDRILL_MCP_URL: "FIREDRILL_MCP_URL" },
        executable: "node",
        timeoutMs: 1_000,
      }).success,
    ).toBe(false);
    expect(
      TargetDescriptorSchema.safeParse({
        id: "command-agent",
        kind: "command",
        bindings: ["mcp"],
        bindingEnvironment: { SERVICE_TOKEN: "FIREDRILL_MCP_TOKEN" },
        environmentFromHost: { SERVICE_TOKEN: "PRODUCTION_TOKEN" },
        executable: "node",
        timeoutMs: 1_000,
      }).success,
    ).toBe(false);
  });
});

describe("test-local world setup", () => {
  it("normalizes serializable data, Tool, and binding overrides", () => {
    expect(
      RunWorldSetupSchema.parse({
        scenario: {
          state: [
            {
              action: "upsert",
              packageId: "record-store",
              namespace: "records",
              rowId: "primary",
              value: { value: 2 },
            },
          ],
        },
        tools: {
          packages: ["@example/clock-pack"],
          behaviorOverrides: [{ packageId: "record-store", module: "test/records.ts" }],
        },
        bindings: { environment: { SERVICE_URL: "FIREDRILL_HTTP_URL" } },
      }),
    ).toEqual({
      scenario: {
        actors: [],
        state: [
          {
            action: "upsert",
            packageId: "record-store",
            namespace: "records",
            rowId: "primary",
            value: { value: 2 },
          },
        ],
        faults: [],
        initialEvents: [],
      },
      tools: {
        packages: ["@example/clock-pack"],
        behaviorOverrides: [{ packageId: "record-store", module: "test/records.ts", exportName: "default" }],
      },
      bindings: { environment: { SERVICE_URL: "FIREDRILL_HTTP_URL" } },
    });
  });

  it("rejects no-op, duplicate, and anonymous setup", () => {
    expect(RunWorldSetupSchema.safeParse({}).success).toBe(false);
    expect(
      RunWorldSetupSchema.safeParse({
        tools: {
          behaviorOverrides: [
            { packageId: "records", module: "test/a.ts" },
            { packageId: "records", module: "test/b.ts" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      RunWorldSetupSchema.safeParse({ tools: { behaviorOverrides: [{ packageId: "records" }] } }).success,
    ).toBe(false);
  });
});

describe("generic world and drill contracts", () => {
  const scenario = {
    schemaVersion: 1,
    id: "overheated-room",
    virtualTimeUs: 100,
    actors: [
      {
        id: "facility-operator",
        attributes: { shift: "night" },
        grants: [{ packageId: "building-controls", operationId: "targets.set" }],
      },
    ],
    state: [
      {
        action: "upsert",
        packageId: "building-controls",
        namespace: "zones",
        rowId: "north-lab",
        value: { targetCelsius: 27 },
      },
    ],
    initialEvents: [
      {
        event: { packageId: "load-monitor", eventId: "threshold.crossed" },
        payload: { zoneId: "north-lab" },
        atUs: 200,
        actorId: "facility-operator",
      },
    ],
  } as const;

  it("keeps optional actor descriptions separate from attributes and grants without rewriting text", () => {
    const actor = scenario.actors[0];
    const description = "  Handles routine requests during the night shift.  ";
    expect(ActorDefinitionSchema.parse({ ...actor, description })).toEqual({ ...actor, description });
    expect(ActorDefinitionSchema.parse(actor)).toEqual(actor);
    expect(ActorDefinitionSchema.parse({ id: "observer", description })).toEqual({
      id: "observer",
      description,
      attributes: {},
      grants: [],
    });
    for (const length of [1, 500]) {
      expect(ActorDefinitionSchema.safeParse({ ...actor, description: "a".repeat(length) }).success).toBe(
        true,
      );
    }
  });

  it.each(["", " \t\n\u00a0", "a".repeat(501), null, 42, {}, []].map((description) => ({ description })))(
    "rejects invalid actor description %#",
    ({ description }) => {
      const result = ActorDefinitionSchema.safeParse({ ...scenario.actors[0], description });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["description"] }));
    },
  );

  it("addresses state through package-owned namespaces rather than a reference-world entity", () => {
    const assertion = AssertionDefinitionSchema.parse({
      id: "target-lowered",
      kind: "state.value",
      packageId: "building-controls",
      namespace: "zones",
      rowId: "north-lab",
      path: ["targetCelsius"],
      comparison: { operator: "less_than_or_equal", value: 22 },
    });
    expect(assertion).toMatchObject({ packageId: "building-controls", namespace: "zones" });
    expect(
      AssertionDefinitionSchema.safeParse({
        ...assertion,
        entity: "zones",
      }).success,
    ).toBe(false);
  });

  it("rejects assertion kinds that have no executable evaluator", () => {
    expect(
      AssertionDefinitionSchema.safeParse({
        id: "unregistered-rule",
        kind: "invariant",
        invariantId: "never-double-submit",
      }).success,
    ).toBe(false);
  });

  it("requires initial events and drills to bind to a declared actor", () => {
    expect(ScenarioDefinitionSchema.parse(scenario).actors[0]?.id).toBe("facility-operator");
    expect(
      ScenarioDefinitionSchema.safeParse({
        ...scenario,
        initialEvents: [{ ...scenario.initialEvents[0], actorId: "missing-operator" }],
      }).success,
    ).toBe(false);

    const drill = DrillDefinitionSchema.parse({
      schemaVersion: 1,
      id: "stabilize-room",
      targetId: "operations-agent",
      inlineScenario: {
        virtualTimeUs: scenario.virtualTimeUs,
        actors: scenario.actors,
        state: scenario.state,
        initialEvents: scenario.initialEvents,
      },
      timeline: {
        interactions: [
          {
            id: "initial-request",
            afterStartUs: 0,
            actorId: "facility-operator",
            task: { instruction: "Stabilize the room without shutting down the lab." },
          },
        ],
      },
      assertions: [
        {
          id: "target-lowered",
          kind: "state.value",
          packageId: "building-controls",
          namespace: "zones",
          rowId: "north-lab",
          path: ["targetCelsius"],
          comparison: { operator: "less_than_or_equal", value: 22 },
        },
      ],
    });
    expect(drill.timeline.interactions[0]?.actorId).toBe("facility-operator");
    expect(
      DrillDefinitionSchema.safeParse({
        ...drill,
        timeline: {
          ...drill.timeline,
          interactions: [{ ...drill.timeline.interactions[0], actorId: "missing-operator" }],
        },
      }).success,
    ).toBe(false);

    const invalidTimeline = DrillDefinitionSchema.safeParse({
      ...drill,
      timeline: {
        ...drill.timeline,
        horizonUs: 10,
        interactions: [
          { ...drill.timeline.interactions[0], id: "repeated", afterStartUs: 11 },
          { ...drill.timeline.interactions[0], id: "repeated", afterStartUs: 5 },
        ],
      },
    });
    expect(invalidTimeline.success).toBe(false);
    expect(invalidTimeline.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "interaction occurs after the timeline horizon",
        "duplicate interaction id repeated",
        "interactions must be ordered by afterStartUs",
      ]),
    );
  });

  it("expands repeated multi-actor workloads deterministically and rejects unsafe schedules", () => {
    const workloadDrill = DrillDefinitionSchema.parse({
      schemaVersion: 1,
      id: "rotate-operators",
      targetId: "operations-agent",
      inlineScenario: {
        virtualTimeUs: 0,
        actors: [
          { id: "operator-a", grants: [] },
          { id: "operator-b", grants: [] },
        ],
      },
      timeline: {
        horizonUs: 30,
        interactions: [
          {
            id: "opening-check",
            afterStartUs: 0,
            actorId: "operator-a",
            task: { instruction: "Inspect the opening state." },
          },
        ],
        workloads: [
          {
            id: "periodic-review",
            actorIds: ["operator-a", "operator-b"],
            task: { instruction: "Review the current state." },
            startAfterUs: 10,
            everyUs: 20,
            occurrences: 2,
          },
        ],
      },
      assertions: [
        {
          id: "no-unexpected-calls",
          kind: "operation.count",
          operation: { packageId: "building-controls", operationId: "targets.set" },
          comparison: { operator: "equals", value: 0 },
        },
      ],
    });

    expect(expandDrillInteractions(workloadDrill.timeline)).toEqual([
      expect.objectContaining({ id: "opening-check", afterStartUs: 0, actorId: "operator-a" }),
      expect.objectContaining({ id: "periodic-review-1-1", afterStartUs: 10, actorId: "operator-a" }),
      expect.objectContaining({ id: "periodic-review-1-2", afterStartUs: 10, actorId: "operator-b" }),
      expect.objectContaining({ id: "periodic-review-2-1", afterStartUs: 30, actorId: "operator-a" }),
      expect.objectContaining({ id: "periodic-review-2-2", afterStartUs: 30, actorId: "operator-b" }),
    ]);

    const invalid = DrillDefinitionSchema.safeParse({
      ...workloadDrill,
      timeline: {
        ...workloadDrill.timeline,
        horizonUs: 20,
        workloads: [{ ...workloadDrill.timeline.workloads[0], actorIds: ["missing-operator"] }],
      },
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "workload exceeds the timeline horizon",
        "drill workload references unknown inline-scenario actor missing-operator",
      ]),
    );
  });

  it("rejects duplicate actor grants and duplicate active faults", () => {
    const duplicateGrant = ScenarioDefinitionSchema.safeParse({
      ...scenario,
      actors: [
        {
          ...scenario.actors[0],
          grants: [scenario.actors[0].grants[0], scenario.actors[0].grants[0]],
        },
      ],
    });
    expect(duplicateGrant.success).toBe(false);
    expect(duplicateGrant.error?.issues.map((issue) => issue.message)).toContain(
      "actor grants must not contain duplicates",
    );

    const duplicateFault = ScenarioDefinitionSchema.safeParse({
      ...scenario,
      faults: [
        { packageId: "building-controls", faultId: "offline" },
        { packageId: "building-controls", faultId: "offline" },
      ],
    });
    expect(duplicateFault.success).toBe(false);
    expect(duplicateFault.error?.issues.map((issue) => issue.message)).toContain(
      "faults must not contain duplicates",
    );
  });

  it("rejects persona references until deterministic persona execution exists", () => {
    expect(
      ScenarioDefinitionSchema.safeParse({
        ...scenario,
        actors: [{ ...scenario.actors[0], personaId: "night-operator" }],
      }).success,
    ).toBe(false);
  });
});

describe("operation boundary", () => {
  const invocation = {
    schemaVersion: 1,
    callId: "call_abcdef",
    correlationId: "corr_abcdef",
    operation: OPERATION,
    actorBindingId: "actor_abcdef",
    arguments: { title: "Planning" },
  } as const;

  it("accepts only a bound actor reference, not caller-authored privilege", () => {
    expect(OperationInvocationSchema.parse(invocation).actorBindingId).toBe("actor_abcdef");
    expect(OperationInvocationSchema.safeParse({ ...invocation, role: "admin" }).success).toBe(false);
  });

  it("requires value or error according to the outcome", () => {
    expect(OperationOutcomeSchema.parse({ status: "ok", value: { id: "evt_1" } }).status).toBe("ok");
    expect(OperationOutcomeSchema.safeParse({ status: "ok", error }).success).toBe(false);
    expect(OperationOutcomeSchema.safeParse({ status: "denied" }).success).toBe(false);
  });
});

describe("errors and diagnostics", () => {
  it("keeps source and code namespace aligned while tolerating future fields", () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...error, source: "world" }).success).toBe(false);
    const parsed = ErrorEnvelopeSchema.parse({ ...error, futureField: { value: true } });
    expect(parsed.futureField).toEqual({ value: true });
    expect(
      ErrorEnvelopeSchema.safeParse({
        schemaVersion: 1,
        code: "control.AUTH_REQUIRED",
        source: "control",
        message: "sign in to continue",
        retryable: false,
        correlationId: "corr_abcdef",
        issues: [],
      }).success,
    ).toBe(true);
  });

  it("requires repository-relative diagnostic locations", () => {
    const diagnostic = {
      code: "FD1001",
      severity: "error",
      message: "invalid source",
      span: { path: "world/tools/calendar.yaml", start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
    };
    expect(DiagnosticSchema.parse(diagnostic).code).toBe("FD1001");
    expect(
      DiagnosticSchema.safeParse({ ...diagnostic, span: { ...diagnostic.span, path: "../secret.yaml" } })
        .success,
    ).toBe(false);
  });
});

describe("evidence and run results", () => {
  const invocation = {
    schemaVersion: 1,
    callId: "call_abcdef",
    correlationId: "corr_abcdef",
    operation: OPERATION,
    actorBindingId: "actor_abcdef",
    arguments: { title: "Planning" },
  } as const;

  it("records a complete operation outcome in one ordered transaction entry", () => {
    const entry = EvidenceEntrySchema.parse({
      schemaVersion: 1,
      kind: "operation",
      sequence: 7,
      transactionId: "txn_abcdef",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 10,
      correlationId: "corr_abcdef",
      invocation,
      outcome: { status: "tool_error", error },
      idempotency: "not_requested",
    });
    expect(entry.sequence).toBe(7);
    expect(EvidenceEntrySchema.safeParse({ ...entry, causeSequence: 7 }).success).toBe(false);
    expect(EvidenceEntrySchema.safeParse({ ...entry, transactionIndex: 1 }).success).toBe(false);
  });

  it("rejects ambiguous event delivery and idempotency evidence", () => {
    const operation = {
      schemaVersion: 1,
      kind: "operation",
      sequence: 1,
      transactionId: "txn_abcdef",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 10,
      correlationId: "corr_abcdef",
      invocation,
      outcome: { status: "ok", value: {} },
      idempotency: "replayed",
    } as const;
    expect(EvidenceEntrySchema.safeParse(operation).success).toBe(false);

    const event = {
      schemaVersion: 1,
      kind: "event",
      sequence: 2,
      transactionId: "txn_abcdeg",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 10,
      correlationId: "corr_abcdef",
      event: { packageId: "calendar", eventId: "event.created" },
      phase: "handled",
      payload: {},
      handlerPackageId: "search",
    } as const;
    expect(EvidenceEntrySchema.safeParse(event).success).toBe(false);
  });

  it("separates assertion failure from runner failure", () => {
    const assertion = AssertionResultSchema.parse({
      schemaVersion: 1,
      assertionId: "refund-once",
      kind: "operation.count",
      status: "failed",
      gate: true,
      message: "expected one call, observed two",
      expected: { operator: "equals", value: 1 },
      actual: 2,
      location: {
        subject: "operation",
        operations: [{ packageId: "billing", operationId: "refund.create" }],
      },
      diff: { operator: "equals", matched: false, details: {} },
      evidenceSequences: [4, 9],
    });
    const result = RunResultSchema.parse({
      schemaVersion: 1,
      status: "sealed",
      identity: {
        runId: "run_abcdef",
        worldInstanceId: "world_abcdef",
        drillId: "refund-dispute",
        scenarioId: "high-value",
        targetId: "support-agent",
        buildHash: HASH,
        packageLockHash: HASH_B,
        seed: "42",
        trial: 1,
        trialCount: 1,
      },
      startedAtVirtualUs: 10,
      finishedAtVirtualUs: 20,
      bindingEvidence: "observed",
      worldConsistency: "atomic",
      budgetUsage: {
        toolCalls: { limit: 1000, attempted: 2, rejected: 0 },
        scheduledEvents: { limit: 10000, processed: 0, exhausted: false },
      },
      interactions: [
        {
          schemaVersion: 1,
          interactionId: "initial-request",
          actorId: "customer",
          task: { instruction: "Resolve the refund dispute." },
          scheduledAtVirtualUs: 10,
          startedAtVirtualUs: 10,
          finishedAtVirtualUs: 20,
          bindingEvidence: "observed",
          targetResult: { schemaVersion: 1, status: "completed", attachments: [] },
        },
      ],
      checkpoints: [
        {
          schemaVersion: 1,
          checkpointId: "final",
          kind: "final",
          virtualTimeUs: 20,
          verdict: "failed",
          assertionResults: [assertion],
        },
      ],
      evidenceRange: { fromSequence: 1, toSequence: 9 },
      verdict: "failed",
      assertionResults: [assertion],
      stateHash: HASH,
      evidenceHash: HASH_B,
      trajectoryHash: HASH,
      futureField: true,
    });
    expect(result.status).toBe("sealed");
    expect(result.budgetUsage.toolCalls).toEqual({ limit: 1000, attempted: 2, rejected: 0 });
    expect(result.futureField).toBe(true);
  });
});

describe("version behavior", () => {
  it("rejects unknown contract versions instead of guessing", () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...error, schemaVersion: 2 }).success).toBe(false);
  });
});
