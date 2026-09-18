import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AssertionDefinitionSchema,
  DrillTimelineSchema,
  RunResultSchema,
  type ToolOverride,
} from "@firedrill-run/contracts";
import { writeLocalReport } from "@firedrill-run/reporters";
import { afterEach, describe, expect, it } from "vitest";
import {
  SimulationProjectSchema,
  SimulationReportAttachmentsSchema,
  SimulationRunComparisonSchema,
} from "../src/contracts.js";
import type { LocalSimulationServer } from "../src/index.js";
import { startLocalSimulationServer } from "../src/index.js";

const directories: string[] = [];
const servers: LocalSimulationServer[] = [];

interface TestApiValue {
  readonly error: { readonly code: string };
  readonly world: {
    readonly id: string;
    readonly buildHash: string;
    readonly baseline: {
      readonly virtualTimeUs: number;
      readonly actors: ReadonlyArray<{
        readonly id: string;
        readonly grants: ReadonlyArray<{ readonly packageId: string; readonly operationId: string }>;
      }>;
      readonly state: readonly unknown[];
      readonly faults: readonly unknown[];
      readonly initialEvents: readonly unknown[];
    };
  };
  readonly scenarios: ReadonlyArray<{
    readonly id: string;
    readonly virtualTimeUs: number;
    readonly state: readonly unknown[];
    readonly source?: { readonly path: string };
  }>;
  readonly tools: ReadonlyArray<{
    readonly id: string;
    readonly stateNamespaces: readonly string[];
  }>;
  readonly targets: ReadonlyArray<{
    readonly id: string;
    readonly runAvailability: "ready" | "agent_callback_required";
  }>;
  readonly status: string;
  readonly verdict?: string;
  readonly requestId: string;
  readonly selection: { readonly kind: "drill" | "suite"; readonly id: string };
  readonly runIds: readonly string[];
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly requestId?: string;
    readonly drillId: string;
    readonly status: string;
    readonly evidenceSequence: number;
    readonly reportAvailable: boolean;
    readonly verdict?: string;
  }>;
  readonly entries: readonly unknown[];
  readonly nextSequence: number;
  readonly records: ReadonlyArray<{
    readonly rowId: string;
    readonly value: { readonly value: number };
  }>;
  readonly summary: TestApiValue["runs"][number];
  readonly result: { readonly identity: { readonly runId: string } };
  readonly compatibility: {
    readonly status: "exact_inputs" | "descriptive_only" | "incompatible";
    readonly canAttributeBehaviorChange: boolean;
  };
  readonly outcome: "unchanged" | "changed" | "not_comparable";
  readonly baseline: { readonly runId: string; readonly reportDirectory?: string };
  readonly candidate: { readonly runId: string; readonly reportDirectory?: string };
  readonly kind: string;
  readonly path: string;
  readonly language: string;
  readonly content: string;
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-simulation-"));
  directories.push(root);
  const quickstart = resolve(import.meta.dirname, "../../../examples/quickstart");
  cpSync(join(quickstart, "firedrill.json"), join(root, "firedrill.json"));
  cpSync(join(quickstart, "firedrill"), join(root, "firedrill"), { recursive: true });
  const agent = readFileSync(join(quickstart, "agent.mjs"), "utf8").replace(
    "const result = await response.json();",
    "const result = await response.json();\nawait new Promise((resolve) => setTimeout(resolve, 300));",
  );
  writeFileSync(join(root, "agent.mjs"), agent);
  writeFileSync(
    join(root, "slow-agent.mjs"),
    [
      "process.stdin.resume();",
      "await new Promise((resolve) => setTimeout(resolve, 5_000));",
      "process.stdout.write(JSON.stringify({ completed: true }));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "firedrill", "slow.target.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target: {
        id: "slow-agent",
        kind: "command",
        bindings: ["http"],
        executable: "node",
        arguments: ["slow-agent.mjs"],
        workingDirectory: ".",
        timeoutMs: 10_000,
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "firedrill", "cancel.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "cancel-slow-agent",
      targetId: "slow-agent",
      scenarioId: "empty",
      actorId: "agent",
      task: { instruction: "Wait until cancelled." },
      assertions: [
        {
          id: "record-unchanged",
          kind: "state.value",
          packageId: "workspace",
          namespace: "records",
          rowId: "primary",
          path: ["value"],
          comparison: { operator: "equals", value: 0 },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(root, "firedrill", "external.target.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target: {
        id: "caller-owned-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 10_000,
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "firedrill", "external.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "caller-owned-drill",
      targetId: "caller-owned-agent",
      scenarioId: "empty",
      actorId: "agent",
      task: { instruction: "Use the caller-owned agent." },
      assertions: [
        {
          id: "record-visible",
          kind: "state.value",
          packageId: "workspace",
          namespace: "records",
          rowId: "primary",
          path: ["value"],
          comparison: { operator: "equals", value: 0 },
        },
      ],
    })}\n`,
  );
  mkdirSync(join(root, ".firedrill"), { recursive: true });
  return root;
}

async function api(
  server: LocalSimulationServer,
  path: string,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly value: TestApiValue }> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  return { response, value: (await response.json()) as TestApiValue };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for local simulation state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForRequest(server: LocalSimulationServer, requestId: string): Promise<TestApiValue> {
  return waitFor(async () => {
    const { value } = await api(server, `/api/v1/run-requests/${requestId}`);
    return ["completed", "failed", "cancelled"].includes(value.status) ? value : undefined;
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local simulation server", () => {
  it("compares verified reports with runtime fault controls through the public API", async () => {
    const root = repository();
    const control = {
      schemaVersion: 1 as const,
      sequence: 1,
      transactionId: "txn_control001",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 0,
      correlationId: "corr_control001",
      kind: "fault_control" as const,
      packageId: "workspace",
      faultId: "unavailable",
      previouslyActive: false,
      active: true,
    };
    for (const [suffix, controlled] of [
      ["baseline001", false],
      ["controlled001", true],
      ["controlled002", true],
    ] as const) {
      const runId = `run_${suffix}`;
      const result = RunResultSchema.parse({
        schemaVersion: 1,
        status: "cancelled",
        reason: "The test harness stopped this fixture run.",
        identity: {
          runId,
          worldInstanceId: `world_${suffix}`,
          drillId: "set-record",
          scenarioId: "empty",
          targetId: "example-agent",
          buildHash: `sha256:${"a".repeat(64)}`,
          packageLockHash: `sha256:${"b".repeat(64)}`,
          seed: "1",
          trial: 1,
          trialCount: 1,
        },
        startedAtVirtualUs: 0,
        finishedAtVirtualUs: 0,
        bindingEvidence: "not_checked",
        worldConsistency: "atomic",
        interactions: [],
        checkpoints: [],
        assertionResults: [],
        budgetUsage: {
          toolCalls: { limit: 100, attempted: 0, rejected: 0 },
          scheduledEvents: { limit: 100, processed: 0, exhausted: false },
        },
      });
      writeLocalReport(
        { result, evidence: controlled ? [control] : [] },
        join(root, ".firedrill", "reports", runId),
      );
    }
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    for (const [baselineRunId, candidateRunId, differences] of [
      ["run_baseline001", "run_controlled001", ["runtime_controls"]],
      ["run_controlled001", "run_baseline001", ["runtime_controls"]],
      ["run_controlled001", "run_controlled002", []],
    ] as const) {
      const comparison = await api(server, "/api/v1/comparisons", {
        method: "POST",
        body: JSON.stringify({ baselineRunId, candidateRunId }),
      });
      expect(comparison.response.status).toBe(200);
      const value = SimulationRunComparisonSchema.parse(comparison.value);
      expect(value.compatibility).toMatchObject({
        status: "descriptive_only",
        canAttributeBehaviorChange: false,
        differences,
      });
      expect(value.baseline.runId).toBe(baselineRunId);
      expect(value.candidate.runId).toBe(candidateRunId);
      expect(value.baseline).not.toHaveProperty("reportDirectory");
      expect(value.changes.stateChanged).toBeUndefined();
    }
  });

  it("reopens custom report and world directories without accepting browser path overrides", async () => {
    const root = repository();
    const runDirectory = ".firedrill/review/runs";
    const reportDirectory = join(root, ".firedrill", "review", "reports");
    const first = await startLocalSimulationServer({ root, runDirectory, reportDirectory });
    servers.push(first);
    expect(first.supervisor.runDirectory).toBe(join(root, runDirectory));
    expect(first.supervisor.reportDirectory).toBe(reportDirectory);
    const start = await api(first, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record" }),
    });
    const completed = await waitForRequest(first, start.value.requestId);
    expect(completed.verdict).toBe("passed");
    const runId = completed.runIds[0];
    expect(runId).toBeDefined();
    const worldPath = join(root, runDirectory, `${runId}.sqlite`);
    expect(existsSync(worldPath)).toBe(true);
    expect(existsSync(join(reportDirectory, runId ?? "", "index.html"))).toBe(true);
    expect(existsSync(join(root, ".firedrill", "runs"))).toBe(false);
    expect(existsSync(join(root, ".firedrill", "reports"))).toBe(false);
    await first.close();

    const reopened = await startLocalSimulationServer({ root, runDirectory, reportDirectory });
    servers.push(reopened);
    const listed = await api(reopened, "/api/v1/runs");
    expect(listed.value.runs).toContainEqual(expect.objectContaining({ runId, reportAvailable: true }));
    const stateRoute = `/api/v1/runs/${runId}/state?packageId=workspace&namespace=records`;
    expect((await api(reopened, stateRoute)).value.records).toEqual([
      { rowId: "primary", value: { value: 7 } },
    ]);
    const override = await api(reopened, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record", reportDirectory: "../elsewhere" }),
    });
    expect(override.response.status).toBe(400);

    renameSync(worldPath, `${worldPath}.saved`);
    const missingWorld = await api(reopened, stateRoute);
    expect(missingWorld.response.status).toBe(404);
    expect(missingWorld.value.error.code).toBe("framework.WORLD_ARTIFACT_NOT_FOUND");
    const detail = await api(reopened, `/api/v1/runs/${runId}`);
    expect(detail.response.status).toBe(200);
    expect(detail.value.result.identity.runId).toBe(runId);
    const report = await fetch(`${reopened.baseUrl}/api/v1/runs/${runId}/report`, {
      headers: { authorization: `Bearer ${reopened.token}` },
    });
    expect(report.status).toBe(200);
    expect(await report.text()).toContain("set-record");
  });

  it("serves only verified attachments by ID with safe download headers", async () => {
    const root = repository();
    mkdirSync(join(root, "test-results"));
    writeFileSync(join(root, "test-results", "result.html"), "<script>never execute me</script>");
    const server = await startLocalSimulationServer({
      root,
      agent: (invocation) => {
        invocation.attach({ path: "test-results/result.html", mediaType: "text/plain" });
        return { schemaVersion: 1, status: "completed", attachments: [] };
      },
    });
    servers.push(server);
    const start = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "caller-owned-drill" }),
    });
    const completed = await waitForRequest(server, start.value.requestId);
    const runId = completed.runIds[0];
    expect(runId).toBeDefined();
    const base = `/api/v1/runs/${runId}/report/attachments`;
    const unauthorized = await fetch(`${server.baseUrl}${base}`);
    expect(unauthorized.status).toBe(401);
    const listed = await api(server, base);
    expect(listed.response.status).toBe(200);
    const attachments = SimulationReportAttachmentsSchema.parse(listed.value);
    const file = attachments.attachments[0];
    expect(file).toBeDefined();
    expect(file?.mediaType).toBe("text/plain");
    expect(file?.path).toBe(`attachments/${file?.id}/result.html`);
    expect(JSON.stringify(attachments)).not.toContain(root);

    const unauthorizedFile = await fetch(`${server.baseUrl}${base}/${file?.id}`);
    expect(unauthorizedFile.status).toBe(401);
    const response = await fetch(`${server.baseUrl}${base}/${file?.id}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="result.html"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<script>never execute me</script>");
    expect((await api(server, `${base}/missing`)).response.status).toBe(404);
    expect((await api(server, `${base}/%2E%2E%2Fmanifest.json`)).response.status).toBe(400);

    writeFileSync(join(root, ".firedrill", "reports", runId ?? "", file?.path ?? ""), "tampered");
    const tampered = await api(server, `${base}/${file?.id}`);
    expect(tampered.response.status).toBe(422);
    expect(tampered.value.error.code).toBe("framework.REPORT_INVALID");
    expect((await api(server, base)).response.status).toBe(422);
  });

  it("preserves authored schema meaning without inventing fields or relationships", async () => {
    const root = repository();
    const stateSchema = {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "integer", minimum: 0 },
        customer_id: { type: "string", description: "An opaque external identifier." },
        detail: { $ref: "#/$defs/detail" },
      },
      $defs: {
        detail: {
          type: "object",
          properties: { label: { type: ["string", "null"] } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const inputSchema = {
      type: "object",
      required: ["value"],
      properties: { value: { type: "integer" }, mode: { enum: ["replace", "append"] } },
      additionalProperties: false,
    };
    const outputSchema = {
      type: "object",
      required: ["value"],
      properties: { value: { type: "integer" }, note: { type: ["string", "null"] } },
      additionalProperties: false,
    };
    writeFileSync(
      join(root, "firedrill", "tools", "workspace", "workspace.tool.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        module: "./behavior.js",
        manifest: {
          schemaVersion: 1,
          id: "workspace",
          version: "1.0.0",
          engine: ">=0.1.0 <0.2.0",
          capabilities: ["state.read", "state.write"],
          state: [{ namespace: "records", description: "Stored test records.", schema: stateSchema }],
          operations: [
            {
              id: "records.set",
              description: "Replace the record value.",
              inputSchema,
              outputSchema,
              idempotency: "required",
              fidelity: "stateful",
            },
          ],
        },
      }),
    );
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    const { response, value } = await api(server, "/api/v1/project");
    expect(response.status).toBe(200);
    const project = SimulationProjectSchema.parse(value);
    const tool = project.tools[0];
    expect(tool?.stateDefinitions).toEqual([
      { namespace: "records", description: "Stored test records.", schema: stateSchema },
    ]);
    expect(tool?.operations[0]).toEqual({
      id: "records.set",
      description: "Replace the record value.",
      inputSchema,
      outputSchema,
      declaredErrors: [],
      idempotency: "required",
      fidelity: "stateful",
    });

    // Older project-view clients can still provide a catalog without the additive schema fields.
    const legacy = {
      ...project,
      tools: project.tools.map(({ stateDefinitions: _stateDefinitions, ...entry }) => ({
        ...entry,
        operations: entry.operations.map(
          ({ inputSchema: _input, outputSchema: _output, ...operation }) => operation,
        ),
      })),
    };
    expect(SimulationProjectSchema.safeParse(legacy).success).toBe(true);
    expect(
      SimulationProjectSchema.safeParse({
        ...project,
        tools: [{ ...tool, stateDefinitions: [{ namespace: "records", schema: "guessed" }] }],
      }).success,
    ).toBe(false);
  });

  it("preserves Tool override scopes and effective priority in baseline, scenario and drill views", async () => {
    const root = repository();
    const rule = (id: string, value: number): ToolOverride => ({
      id,
      operation: { packageId: "workspace", operationId: "records.set" },
      outcome: { kind: "return", value: { value } },
    });
    const appendOverrides = (path: string, toolOverrides: readonly ToolOverride[]) => {
      const file = join(root, "firedrill", path);
      writeFileSync(file, `${readFileSync(file, "utf8")}\ntoolOverrides: ${JSON.stringify(toolOverrides)}\n`);
    };
    appendOverrides("world.yaml", [rule("baseline-only", 1), rule("shared", 2)]);
    appendOverrides("scenarios/empty.scenario.yaml", [rule("shared", 3), rule("scenario-only", 4)]);
    appendOverrides("drills/set-record.drill.yaml", [
      { ...rule("shared", 5), outcome: { kind: "original" } },
    ]);
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    const { response, value } = await api(server, "/api/v1/project");
    expect(response.status).toBe(200);
    const project = SimulationProjectSchema.parse(value);
    const baseline = project.world.baseline.toolOverrides;
    const scenario = project.scenarios.find((item) => item.id === "empty")?.toolOverrides;
    const drill = project.drills.find((item) => item.id === "set-record")?.toolOverrides;
    expect(baseline?.map((item) => [item.id, item.scope])).toEqual([
      ["baseline-only", { kind: "baseline" }],
      ["shared", { kind: "baseline" }],
    ]);
    expect(scenario?.map((item) => [item.id, item.scope])).toEqual([
      ["baseline-only", { kind: "baseline" }],
      ["shared", { kind: "scenario", scenarioId: "empty" }],
      ["scenario-only", { kind: "scenario", scenarioId: "empty" }],
    ]);
    expect(drill?.map((item) => [item.id, item.scope, item.outcome.kind])).toEqual([
      ["baseline-only", { kind: "baseline" }, "return"],
      ["scenario-only", { kind: "scenario", scenarioId: "empty" }, "return"],
      ["shared", { kind: "drill", drillId: "set-record" }, "original"],
    ]);
    const { toolOverrides: _baseline, ...legacyBaseline } = project.world.baseline;
    const legacy = {
      ...project,
      world: { ...project.world, baseline: legacyBaseline },
      scenarios: project.scenarios.map(({ toolOverrides: _rules, ...item }) => item),
      drills: project.drills.map(({ toolOverrides: _rules, ...item }) => item),
    };
    expect(SimulationProjectSchema.safeParse(legacy).success).toBe(true);
    expect(
      SimulationProjectSchema.safeParse({
        ...project,
        world: {
          ...project.world,
          baseline: { ...project.world.baseline, toolOverrides: [rule("missing-scope", 0)] },
        },
      }).success,
    ).toBe(false);
  });

  it("exposes exact drill tasks, workload timing, and invariant and final assertion definitions", async () => {
    const root = repository();
    const invariant = {
      id: "value-stays-valid",
      kind: "state.value",
      packageId: "workspace",
      namespace: "records",
      rowId: "primary",
      path: ["value"],
      comparison: { operator: "greater_than_or_equal", value: 0 },
    };
    const assertions = [
      {
        id: "requested-arguments",
        kind: "operation.arguments",
        gate: false,
        operation: { packageId: "workspace", operationId: "records.set" },
        actorId: "agent",
        outcomes: ["ok"],
        idempotency: ["recorded"],
        occurrence: 2,
        contains: { value: 7 },
      },
      {
        id: "one-requested-record",
        kind: "state.count",
        packageId: "workspace",
        namespace: "records",
        where: { value: 7 },
        comparison: { operator: "equals", value: 1 },
      },
    ];
    const timeline = {
      horizonUs: 5000,
      maxToolCalls: 100,
      maxEvents: 20,
      stopOnInvariantFailure: false,
      stopOnTargetFailure: false,
      interactions: [
        {
          id: "kick-off",
          afterStartUs: 0,
          actorId: "agent",
          task: {
            instruction: "Perform the requested record update.",
            input: { value: 7, context: { labels: ["urgent", "review"], optional: null } },
          },
        },
      ],
      workloads: [
        {
          id: "recheck",
          actorIds: ["agent"],
          task: { instruction: "Repeat the same request.", input: { value: 7, retry: true } },
          startAfterUs: 1000,
          everyUs: 1000,
          occurrences: 3,
        },
      ],
      invariants: [invariant],
    };
    writeFileSync(
      join(root, "firedrill", "inspect-workload.drill.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inspect-workload",
        targetId: "local-agent",
        scenarioId: "empty",
        timeline,
        assertions,
      }),
    );
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    const response = await api(server, "/api/v1/project");
    expect(response.response.status).toBe(200);
    const project = SimulationProjectSchema.parse(response.value);
    const drill = project.drills.find((entry) => entry.id === "inspect-workload");
    expect(drill?.title).toBeUndefined();
    expect(drill?.execution).toEqual(DrillTimelineSchema.parse(timeline));
    expect(drill?.timeline).toEqual({
      interactions: 1,
      workloads: 1,
      horizonUs: 5000,
      maxToolCalls: 100,
      maxEvents: 20,
    });
    expect(drill?.expectations).toEqual(
      [invariant, ...assertions].map((definition, index) => {
        const parsed = AssertionDefinitionSchema.parse(definition);
        return {
          id: parsed.id,
          kind: parsed.kind,
          gate: parsed.gate,
          checkpoint: index === 0 ? "invariant" : "final",
          definition: parsed,
        };
      }),
    );

    // Catalogs created before execution details remain readable.
    const legacy = {
      ...project,
      drills: project.drills.map(({ execution: _execution, ...entry }) => ({
        ...entry,
        expectations: entry.expectations.map(({ definition: _definition, ...expectation }) => expectation),
      })),
    };
    expect(SimulationProjectSchema.safeParse(legacy).success).toBe(true);
  });

  it("preserves each supported assertion payload in the additive catalog contract", async () => {
    const server = await startLocalSimulationServer({ root: repository() });
    servers.push(server);
    const response = await api(server, "/api/v1/project");
    const project = SimulationProjectSchema.parse(response.value);
    const operation = { packageId: "workspace", operationId: "records.set" };
    const definitions = [
      {
        id: "state-value",
        kind: "state.value",
        packageId: "workspace",
        namespace: "records",
        rowId: "primary",
        path: ["nested", 0, "value"],
        comparison: { operator: "one_of", value: [7, null, { status: "ready" }] },
      },
      {
        id: "state-count",
        kind: "state.count",
        packageId: "workspace",
        namespace: "records",
        where: { value: 7 },
        comparison: { operator: "less_than_or_equal", value: 2 },
      },
      {
        id: "operation-count",
        kind: "operation.count",
        operation,
        actorId: "agent",
        outcomes: ["ok", "tool_error"],
        idempotency: ["recorded", "replayed"],
        comparison: { operator: "equals", value: 2 },
      },
      {
        id: "operation-order",
        kind: "operation.order",
        sequence: [
          { anyOf: [operation], outcomes: ["ok"], actorId: "agent" },
          { anyOf: [operation], outcomes: ["denied"], idempotency: ["not_recorded"] },
        ],
      },
      {
        id: "operation-arguments",
        kind: "operation.arguments",
        operation,
        occurrence: 2,
        contains: { value: 7, details: { labels: ["a", "b"] } },
      },
      {
        id: "operation-denied",
        kind: "operation.denied",
        operation,
        errorCode: "tool.ACCESS_DENIED",
        outcomes: ["denied"],
        attemptRequired: false,
      },
      {
        id: "event-count",
        kind: "event.count",
        event: { packageId: "workspace", eventId: "record.changed" },
        phase: "scheduled",
        comparison: { operator: "greater_than_or_equal", value: 1 },
      },
      {
        id: "callback-count",
        kind: "callback.count",
        gate: false,
        callback: { packageId: "workspace", callbackId: "record-notice" },
        phase: "retry_scheduled",
        comparison: { operator: "equals", value: 1 },
      },
    ].map((definition) => AssertionDefinitionSchema.parse(definition));
    const base = project.drills[0];
    if (base === undefined) throw new Error("fixture has no drill");
    const withDefinitions = {
      ...project,
      drills: [
        {
          ...base,
          assertions: definitions.length,
          expectations: definitions.map((definition) => ({
            id: definition.id,
            kind: definition.kind,
            gate: definition.gate,
            checkpoint: "final",
            definition,
          })),
        },
      ],
    };
    expect(
      SimulationProjectSchema.parse(withDefinitions).drills[0]?.expectations.map((entry) => entry.definition),
    ).toEqual(definitions);
    expect(
      SimulationProjectSchema.safeParse({
        ...withDefinitions,
        drills: [
          {
            ...withDefinitions.drills[0],
            expectations: [
              { ...withDefinitions.drills[0]?.expectations[0], definition: { kind: "state.value" } },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tokens that are unsafe to place in an authorization header", async () => {
    await expect(
      startLocalSimulationServer({ root: repository(), token: `${"x".repeat(23)}\n` }),
    ).rejects.toThrow(/HTTP-header-safe/);
  });

  it("serves only regular compiled repository source files", async () => {
    const root = repository();
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    const sourcePath = join(root, "firedrill", "world.yaml");
    const replacement = join(root, "replacement.yaml");
    writeFileSync(replacement, "private: not-a-world\n");
    rmSync(sourcePath);
    symlinkSync(replacement, sourcePath);

    const response = await api(server, "/api/v1/sources/world/quickstart-world");
    expect(response.response.status).toBe(404);
    expect(response.value.error.code).toBe("framework.SOURCE_NOT_FOUND");

    const directoryRoot = repository();
    const directoryServer = await startLocalSimulationServer({ root: directoryRoot });
    servers.push(directoryServer);
    const compiledDirectory = join(directoryRoot, "firedrill");
    const replacementDirectory = join(directoryRoot, "compiled-source");
    renameSync(compiledDirectory, replacementDirectory);
    symlinkSync(replacementDirectory, compiledDirectory, "dir");

    const directoryResponse = await api(directoryServer, "/api/v1/sources/world/quickstart-world");
    expect(directoryResponse.response.status).toBe(404);
    expect(directoryResponse.value.error.code).toBe("framework.SOURCE_NOT_FOUND");
  });

  it("runs, follows, inspects, cancels, and seals drills through the authenticated loopback API", async () => {
    const root = repository();
    const server = await startLocalSimulationServer({ root, maxConcurrency: 2 });
    servers.push(server);

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    const unauthorized = await fetch(`${server.baseUrl}/api/v1/project`);
    expect(unauthorized.status).toBe(401);
    const foreignOrigin = await fetch(`${server.baseUrl}/api/v1/project`, {
      headers: { authorization: `Bearer ${server.token}`, origin: "https://example.test" },
    });
    expect(foreignOrigin.status).toBe(421);

    const { response: projectResponse, value: project } = await api(server, "/api/v1/project");
    expect(projectResponse.status).toBe(200);
    expect(project.world.id).toBe("quickstart-world");
    expect(project.world.baseline).toMatchObject({
      virtualTimeUs: 0,
      actors: [{ id: "agent", grants: [{ packageId: "workspace", operationId: "records.set" }] }],
      state: [],
      faults: [],
      initialEvents: [],
    });
    expect(project.scenarios).toContainEqual(
      expect.objectContaining({
        id: "empty",
        virtualTimeUs: 0,
        state: [
          {
            action: "upsert",
            packageId: "workspace",
            namespace: "records",
            rowId: "primary",
            value: { value: 0 },
          },
        ],
        source: expect.objectContaining({ path: "firedrill/scenarios/empty.scenario.yaml" }),
      }),
    );
    expect(project.tools[0]).toMatchObject({
      id: "workspace",
      stateNamespaces: ["records"],
      stateDefinitions: [
        {
          namespace: "records",
          schema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "integer" } },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "records.set",
          inputSchema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "integer" } },
            additionalProperties: false,
          },
        },
      ],
    });
    expect(
      project.targets.find((target: { id: string }) => target.id === "caller-owned-agent")?.runAvailability,
    ).toBe("agent_callback_required");

    const worldSource = await api(server, "/api/v1/sources/world/quickstart-world");
    expect(worldSource.response.status).toBe(200);
    expect(worldSource.value).toMatchObject({
      kind: "world",
      path: "firedrill/world.yaml",
      language: "yaml",
    });
    expect(worldSource.value.content).toContain("id: quickstart-world");
    const targetSource = await api(server, "/api/v1/sources/target/local-agent");
    expect(targetSource.response.status).toBe(200);
    expect(targetSource.value).toMatchObject({
      kind: "target",
      path: "firedrill/targets/local-agent.target.yaml",
      language: "yaml",
    });
    expect(targetSource.value.content).toContain("id: local-agent");
    const missingSource = await api(server, "/api/v1/sources/scenario/unknown");
    expect(missingSource.response.status).toBe(404);
    expect(missingSource.value.error.code).toBe("framework.SOURCE_NOT_FOUND");
    const malformedSource = await api(server, "/api/v1/sources/world/BAD%20ID");
    expect(malformedSource.response.status).toBe(400);
    expect(malformedSource.value.error.code).toBe("framework.INVALID_ARGUMENT");

    const external = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "caller-owned-drill" }),
    });
    expect(external.response.status).toBe(409);
    expect(external.value.error.code).toBe("framework.EXTERNAL_HANDLER_REQUIRED");

    const cancelStart = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "cancel-slow-agent" }),
    });
    expect(cancelStart.response.status).toBe(202);
    const activeSlow = await waitFor(async () => {
      const { value } = await api(server, "/api/v1/runs");
      return value.runs.find(
        (run: { drillId: string; status: string; evidenceSequence: number }) =>
          run.drillId === "cancel-slow-agent" && run.status === "running",
      );
    });
    const refreshBlocked = await api(server, "/api/v1/project/refresh", { method: "POST" });
    expect(refreshBlocked.response.status).toBe(409);
    const aggregateConcurrency = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "cancel-slow-agent", concurrency: 2 }),
    });
    expect(aggregateConcurrency.response.status).toBe(429);
    expect(aggregateConcurrency.value.error.code).toBe("framework.LOCAL_CONCURRENCY_LIMIT");
    const cancelled = await api(server, `/api/v1/run-requests/${cancelStart.value.requestId}/cancel`, {
      method: "POST",
    });
    expect(cancelled.response.status).toBe(202);
    expect(cancelled.value.status).toBe("cancelling");
    const cancelledRequest = await waitForRequest(server, cancelStart.value.requestId);
    expect(cancelledRequest.status).toBe("cancelled");
    expect(cancelledRequest.runIds).toContain(activeSlow.runId);

    const start = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record", seed: "41" }),
    });
    expect(start.response.status).toBe(202);
    const active = await waitFor(async () => {
      const { value } = await api(server, "/api/v1/runs");
      return value.runs.find(
        (run: { drillId: string; status: string; evidenceSequence: number }) =>
          run.drillId === "set-record" && run.status === "running",
      );
    });
    expect(active.requestId).toBe(start.value.requestId);
    const liveEvidence = await api(server, `/api/v1/runs/${active.runId}/evidence?from=1&limit=1`);
    expect(liveEvidence.response.status).toBe(200);
    expect(liveEvidence.value.entries).toHaveLength(1);
    expect(liveEvidence.value.nextSequence).toBe(2);
    const liveState = await waitFor(async () => {
      const state = await api(
        server,
        `/api/v1/runs/${active.runId}/state?packageId=workspace&namespace=records`,
      );
      return state.value.records[0]?.value?.value === 7 ? state : undefined;
    });
    expect(liveState.value.records).toEqual([{ rowId: "primary", value: { value: 7 } }]);

    const finished = await waitForRequest(server, start.value.requestId);
    expect(finished).toMatchObject({ status: "completed", verdict: "passed" });
    expect(finished.runIds).toEqual([active.runId]);

    const runs = await api(server, "/api/v1/runs");
    const sealed = runs.value.runs.find((run: { runId: string }) => run.runId === active.runId);
    expect(sealed).toMatchObject({ status: "sealed", verdict: "passed", reportAvailable: true });
    const detail = await api(server, `/api/v1/runs/${active.runId}`);
    expect(detail.value.summary).toEqual(sealed);
    expect(detail.value.result.identity.runId).toBe(active.runId);
    const report = await fetch(`${server.baseUrl}/api/v1/runs/${active.runId}/report`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await report.text()).toContain("set-record");
    const completedState = await api(
      server,
      `/api/v1/runs/${active.runId}/state?packageId=workspace&namespace=records`,
    );
    expect(completedState.value.records[0]?.value).toEqual({ value: 7 });

    const invalidNamespace = await api(
      server,
      `/api/v1/runs/${active.runId}/state?packageId=workspace&namespace=missing`,
    );
    expect(invalidNamespace.response.status).toBe(404);
    const invalidCursor = await api(
      server,
      `/api/v1/runs/${active.runId}/state?packageId=workspace&namespace=records&after=${"x".repeat(513)}`,
    );
    expect(invalidCursor.response.status).toBe(400);
    const traversal = await api(server, "/api/v1/runs/%2E%2E%2Foutside");
    expect(traversal.response.status).toBe(400);
    const invalidBody = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record", unexpected: true }),
    });
    expect(invalidBody.response.status).toBe(400);

    const repeatStart = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record", seed: "41" }),
    });
    const repeatFinished = await waitForRequest(server, repeatStart.value.requestId);
    expect(repeatFinished).toMatchObject({ status: "completed", verdict: "passed" });
    const repeatRunId = repeatFinished.runIds[0];
    expect(repeatRunId).toBeDefined();
    const comparison = await api(server, "/api/v1/comparisons", {
      method: "POST",
      body: JSON.stringify({ baselineRunId: active.runId, candidateRunId: repeatRunId }),
    });
    expect(comparison.response.status).toBe(200);
    expect(comparison.value).toMatchObject({
      compatibility: { status: "exact_inputs", canAttributeBehaviorChange: true },
      outcome: "unchanged",
      baseline: { runId: active.runId },
      candidate: { runId: repeatRunId },
    });
    expect(comparison.value.baseline.reportDirectory).toBeUndefined();
    expect(comparison.value.candidate.reportDirectory).toBeUndefined();
    const selfComparison = await api(server, "/api/v1/comparisons", {
      method: "POST",
      body: JSON.stringify({ baselineRunId: active.runId, candidateRunId: active.runId }),
    });
    expect(selfComparison.response.status).toBe(400);

    const refreshed = await api(server, "/api/v1/project/refresh", { method: "POST" });
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.value.world.buildHash).toBe(project.world.buildHash);

    const suiteStart = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ suiteId: "workspace-conformance", seed: "42" }),
    });
    expect(suiteStart.response.status).toBe(202);
    expect(suiteStart.value.selection).toEqual({ kind: "suite", id: "workspace-conformance" });
    const suiteFinished = await waitForRequest(server, suiteStart.value.requestId);
    expect(suiteFinished).toMatchObject({
      selection: { kind: "suite", id: "workspace-conformance" },
      status: "completed",
      verdict: "passed",
    });
    expect(suiteFinished.runIds).toHaveLength(1);
  }, 20_000);

  it("uses an agent callback only for external targets", async () => {
    const root = repository();
    const server = await startLocalSimulationServer({
      root,
      agent: () => {
        throw new Error("the external agent callback must not run for a command target");
      },
    });
    servers.push(server);

    const project = await api(server, "/api/v1/project");
    expect(
      project.value.targets.find((target: { id: string }) => target.id === "caller-owned-agent")
        ?.runAvailability,
    ).toBe("ready");

    const start = await api(server, "/api/v1/runs", {
      method: "POST",
      body: JSON.stringify({ drillId: "set-record" }),
    });
    expect(start.response.status).toBe(202);
    const completed = await waitForRequest(server, start.value.requestId);
    expect(completed).toMatchObject({ status: "completed", verdict: "passed" });
  }, 20_000);
});
