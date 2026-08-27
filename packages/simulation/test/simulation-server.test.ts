import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("rejects tokens that are unsafe to place in an authorization header", async () => {
    await expect(
      startLocalSimulationServer({ root: repository(), token: `${"x".repeat(23)}\n` }),
    ).rejects.toThrow(/HTTP-header-safe/);
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
        source: expect.objectContaining({ path: "firedrill/empty.scenario.yaml" }),
      }),
    );
    expect(project.tools[0]).toMatchObject({
      id: "workspace",
      stateNamespaces: ["records"],
    });
    expect(
      project.targets.find((target: { id: string }) => target.id === "caller-owned-agent")?.runAvailability,
    ).toBe("agent_callback_required");

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
