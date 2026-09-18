import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunResultSchema } from "@firedrill-run/contracts";
import { verifyLocalReport, writeLocalReport } from "@firedrill-run/reporters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationRunListSchema } from "../src/contracts.js";
import { type LocalSimulationServer, startLocalSimulationServer } from "../src/server.js";
import { LocalSimulationSupervisor } from "../src/supervisor.js";

// Instrument the real verifier: every selected report still undergoes full verification.
vi.mock("@firedrill-run/reporters", async (importOriginal) => {
  const original = await importOriginal<typeof import("@firedrill-run/reporters")>();
  return { ...original, verifyLocalReport: vi.fn(original.verifyLocalReport) };
});

const directories: string[] = [];
const servers: LocalSimulationServer[] = [];
const supervisors: LocalSimulationSupervisor[] = [];
const releaseAgents: (() => void)[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-run-pages-"));
  directories.push(root);
  mkdirSync(join(root, "world"));
  const save = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
  save("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  save("world/world.json", {
    schemaVersion: 1,
    id: "sensor-ledger",
    seed: "3",
    actors: [{ id: "operator", attributes: {}, grants: [] }],
    state: [
      { action: "upsert", packageId: "sensor", namespace: "readings", rowId: "room", value: { value: 4 } },
    ],
  });
  save("world/sensor.tool.json", {
    schemaVersion: 1,
    module: "./sensor.ts",
    manifest: {
      schemaVersion: 1,
      id: "sensor",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read"],
      state: [
        {
          namespace: "readings",
          schema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "number" } },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "reading.get",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "number" },
          declaredErrors: [],
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
    },
  });
  writeFileSync(
    join(root, "world/sensor.ts"),
    `import { defineToolBehavior } from '@firedrill-run/tool-sdk';
export default defineToolBehavior({ operations: {
  'reading.get': (_input, context) => context.state.get('readings', 'room')?.value ?? 0,
} });
`,
  );
  save("world/observer.target.json", {
    schemaVersion: 1,
    target: { id: "observer", kind: "external", bindings: ["direct"], timeoutMs: 5_000 },
  });
  save("world/retained.scenario.json", { schemaVersion: 1, id: "retained" });
  save("world/record-visible.drill.json", {
    schemaVersion: 1,
    id: "record-visible",
    targetId: "observer",
    actorId: "operator",
    scenarioId: "retained",
    task: { instruction: "Inspect the retained reading." },
    assertions: [
      {
        id: "reading-retained",
        kind: "state.count",
        packageId: "sensor",
        namespace: "readings",
        comparison: { operator: "equals", value: 1 },
      },
    ],
  });
  return root;
}

function reportPath(root: string, runId: string): string {
  return join(root, ".firedrill", "reports", runId);
}

function continuation(page: { readonly nextCursor?: string | undefined }): string {
  expect(page.nextCursor).toBeDefined();
  if (page.nextCursor === undefined) throw new Error("expected another saved-report page");
  return page.nextCursor;
}

function savedReport(root: string, suffix: string, modified = 1_000): string {
  const runId = `run_${suffix}`;
  const result = RunResultSchema.parse({
    schemaVersion: 1,
    status: "cancelled",
    reason: "The local fixture retained this run for review.",
    identity: {
      runId,
      worldInstanceId: `world_${suffix}`,
      drillId: "record-visible",
      targetId: "observer",
      buildHash: `sha256:${"a".repeat(64)}`,
      packageLockHash: `sha256:${"b".repeat(64)}`,
      seed: "3",
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
  writeLocalReport({ result, evidence: [] }, reportPath(root, runId));
  utimesSync(reportPath(root, runId), modified, modified);
  return runId;
}

function invalidReport(root: string, suffix: string, modified = 1_000): string {
  const runId = `run_${suffix}`;
  mkdirSync(reportPath(root, runId), { recursive: true });
  utimesSync(reportPath(root, runId), modified, modified);
  return runId;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the deterministic local agent");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const release of releaseAgents.splice(0)) release();
  for (const server of servers.splice(0)) await server.close();
  for (const supervisor of supervisors.splice(0)) await supervisor.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("saved-run continuation", () => {
  it("reaches a valid report behind more than 500 invalid directories, verifying only each page", async () => {
    const root = repository();
    const oldest = savedReport(root, "oldest000", 1);
    const invalidIds = Array.from({ length: 505 }, (_, index) =>
      invalidReport(root, `invalid${String(index).padStart(4, "0")}`, 2 + index),
    );
    const supervisor = await LocalSimulationSupervisor.create({ root });
    supervisors.push(supervisor);
    vi.mocked(verifyLocalReport).mockClear();
    let page = supervisor.listRuns();
    expect(page.runs).toEqual([]);
    expect(page.unavailable).toHaveLength(100);
    expect(page.nextCursor).toBeDefined();
    expect(verifyLocalReport).toHaveBeenCalledTimes(100);
    const unavailable = page.unavailable.map((report) => report.runId);
    const runs = page.runs.map((run) => run.runId);
    while (page.nextCursor !== undefined) {
      page = supervisor.listRuns({ cursor: page.nextCursor, limit: 100 });
      unavailable.push(...page.unavailable.map((report) => report.runId));
      runs.push(...page.runs.map((run) => run.runId));
    }
    expect(runs).toEqual([oldest]);
    expect(new Set(unavailable)).toEqual(new Set(invalidIds));
    expect(unavailable).toHaveLength(505);
    expect(verifyLocalReport).toHaveBeenCalledTimes(506);
    expect(SimulationRunListSchema.parse(page)).not.toHaveProperty("nextCursor");
  });

  it("uses stable tied-timestamp cursors across new reports, source refresh, and removed cursor rows", async () => {
    const root = repository();
    const oldest = savedReport(root, "stable001");
    const middle = savedReport(root, "stable002");
    const newest = savedReport(root, "stable003");
    const supervisor = await LocalSimulationSupervisor.create({ root });
    supervisors.push(supervisor);
    const first = supervisor.listRuns({ limit: 1 });
    expect(first.runs.map((run) => run.runId)).toEqual([newest]);
    expect(first.nextCursor).toBeDefined();
    rmSync(reportPath(root, newest), { recursive: true });
    const inserted = savedReport(root, "inserted001", 2_000);
    await supervisor.refreshProject();
    const second = supervisor.listRuns({ cursor: continuation(first), limit: 1 });
    expect(second.runs.map((run) => run.runId)).toEqual([middle]);
    const third = supervisor.listRuns({ cursor: continuation(second), limit: 1 });
    expect(third.runs.map((run) => run.runId)).toEqual([oldest]);
    expect(third.nextCursor).toBeUndefined();
    expect(supervisor.listRuns({ limit: 1 }).runs[0]?.runId).toBe(inserted);
  });

  it("returns active attempts on each saved page without double-counting overlapping report directories", async () => {
    const root = repository();
    const firstSaved = savedReport(root, "saved002");
    const secondSaved = savedReport(root, "saved001");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseAgents.push(release);
    let activeRunId: string | undefined;
    const supervisor = await LocalSimulationSupervisor.create({
      root,
      agent: async ({ runId }) => {
        activeRunId = runId;
        await gate;
        return { completed: true };
      },
    });
    supervisors.push(supervisor);
    supervisor.startRun({ drillId: "record-visible" });
    await waitFor(() => activeRunId !== undefined);
    if (activeRunId === undefined) throw new Error("expected the local agent to start");
    // A partial report for an active run is neither a second run nor an unavailable saved-report slot.
    const overlap = invalidReport(root, activeRunId.slice(4), 2_000);
    try {
      const first = supervisor.listRuns({ limit: 1 });
      const active = first.runs.filter((run) => run.requestId !== undefined);
      expect(active).toHaveLength(1);
      expect(active[0]?.status).toBe("running");
      expect(first.runs.filter((run) => run.runId === activeRunId)).toHaveLength(1);
      expect(first.unavailable).toEqual([]);
      expect(first.runs.filter((run) => run.reportAvailable).map((run) => run.runId)).toEqual([firstSaved]);
      const second = supervisor.listRuns({ cursor: continuation(first), limit: 1 });
      expect(second.runs.filter((run) => run.requestId !== undefined).map((run) => run.runId)).toEqual(
        active.map((run) => run.runId),
      );
      expect(second.runs.filter((run) => run.reportAvailable).map((run) => run.runId)).toEqual([secondSaved]);
      expect(second.unavailable).toEqual([]);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      rmSync(reportPath(root, overlap), { recursive: true });
      release();
    }
  });

  it("validates HTTP page inputs and rejects cursors from another report directory", async () => {
    const root = repository();
    savedReport(root, "http001");
    savedReport(root, "http002");
    const server = await startLocalSimulationServer({ root });
    servers.push(server);
    const get = async (query: string) =>
      fetch(`${server.baseUrl}/api/v1/runs${query}`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
    const first = await get("?limit=1");
    expect(first.status).toBe(200);
    const page = SimulationRunListSchema.parse(await first.json());
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const next = await get(`?limit=1&cursor=${page.nextCursor}`);
    expect(next.status).toBe(200);
    expect(SimulationRunListSchema.parse(await next.json()).nextCursor).toBeUndefined();
    for (const query of [
      "?limit=0",
      "?limit=501",
      "?limit=-1",
      "?limit=1.5",
      "?limit=Infinity",
      "?limit=1e2",
      "?limit=1&limit=2",
      "?cursor=x&cursor=y",
      "?cursor=",
      "?cursor=garbage",
      "?cursor=../outside",
      `?cursor=${"a".repeat(513)}`,
      "?offset=1",
    ]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "framework.INVALID_ARGUMENT" } });
    }
    const otherRoot = repository();
    const other = await LocalSimulationSupervisor.create({ root: otherRoot });
    supervisors.push(other);
    expect(() => other.listRuns({ cursor: continuation(page) })).toThrow("invalid for this report directory");
    expect(() => server.supervisor.listRuns({ limit: Number.NaN })).toThrow("integer from 1 through 500");
    const tampered = Buffer.from(
      JSON.stringify({ version: 1, runId: "../outside", modified: 1, directory: "x" }),
    ).toString("base64url");
    expect(() => server.supervisor.listRuns({ cursor: tampered })).toThrow(
      "invalid for this report directory",
    );
  });
});
