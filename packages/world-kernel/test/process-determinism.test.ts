import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("./process-runner.mjs", import.meta.url));
const idempotencyWorker = fileURLToPath(new URL("./idempotency-worker.mjs", import.meta.url));
const crashWorker = fileURLToPath(new URL("./crash-worker.mjs", import.meta.url));
const scheduledEventWorker = fileURLToPath(new URL("./scheduled-event-worker.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface ProcessResult {
  readonly outcome: unknown;
  readonly stateHash: string;
  readonly evidenceHash: string;
  readonly evidenceCount: number;
}

function runInFreshProcess(name: string, seed: string): ProcessResult {
  const directory = mkdtempSync(join(tmpdir(), `firedrill-process-${name}-`));
  temporaryDirectories.push(directory);
  const output = execFileSync(process.execPath, [runner, join(directory, "world.sqlite"), seed], {
    encoding: "utf8",
  });
  return JSON.parse(output) as ProcessResult;
}

function runIdempotencyWorker(filePath: string, workerId: string): Promise<{ readonly idempotency: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [idempotencyWorker, filePath, workerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`idempotency worker exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { readonly idempotency: string });
    });
  });
}

async function waitForFile(path: string, childExited: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (childExited()) throw new Error("crash worker exited before opening its transaction");
    if (Date.now() >= deadline) throw new Error("timed out waiting for crash worker transaction");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("cross-process determinism", () => {
  it("produces equal semantic hashes for the same seed and diverges for a different seed", () => {
    const left = runInFreshProcess("left", "2026");
    const right = runInFreshProcess("right", "2026");
    const changedSeed = runInFreshProcess("changed", "2027");

    expect(right).toEqual(left);
    expect(left.evidenceCount).toBeGreaterThan(0);
    expect(changedSeed.stateHash).not.toBe(left.stateHash);
    expect(changedSeed.evidenceHash).not.toBe(left.evidenceHash);
  });

  it("serializes equal idempotency keys across competing processes into one effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "firedrill-process-idempotency-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "world.sqlite");
    const store = SqliteWorldStore.create({
      filePath,
      worldInstanceId: "world_process02",
      buildHash: `sha256:${"e".repeat(64)}`,
      packageLockHash: `sha256:${"f".repeat(64)}`,
      seed: "2026",
      virtualTimeUs: 0,
      correlationId: "corr_processcreate",
      actors: [
        {
          bindingId: "actor_process01",
          actorId: "developer",
          grants: [{ packageId: "atomic-counter", operationId: "counters.increment" }],
        },
      ],
      state: [{ packageId: "atomic-counter", namespace: "counters", rowId: "main", value: { value: 0 } }],
    });
    store.close();

    const results = await Promise.all([
      runIdempotencyWorker(filePath, "1"),
      runIdempotencyWorker(filePath, "2"),
    ]);
    expect(results.map((result) => result.idempotency).sort()).toEqual(["recorded", "replayed"]);

    const reopened = SqliteWorldStore.open(filePath);
    expect(reopened.readState("atomic-counter", "counters", "main")?.value).toEqual({ value: 1 });
    expect(
      reopened
        .readEvidence()
        .filter((entry) => entry.kind === "operation")
        .map((entry) => entry.idempotency)
        .sort(),
    ).toEqual(["recorded", "replayed"]);
    reopened.close();
  });

  it("recovers an abruptly killed process without committing partial state, random progress, timers, or evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "firedrill-process-crash-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "world.sqlite");
    const signalPath = join(directory, "transaction-open");
    const store = SqliteWorldStore.create({
      filePath,
      worldInstanceId: "world_process03",
      buildHash: `sha256:${"e".repeat(64)}`,
      packageLockHash: `sha256:${"f".repeat(64)}`,
      seed: "2026",
      virtualTimeUs: 5_000,
      correlationId: "corr_processcreate",
      actors: [
        {
          bindingId: "actor_process01",
          actorId: "developer",
          grants: [{ packageId: "crash-probe", operationId: "effects.apply" }],
        },
      ],
      state: [
        {
          packageId: "crash-probe",
          namespace: "records",
          rowId: "main",
          value: { value: "baseline" },
        },
      ],
    });
    const evidenceBefore = store.readEvidence();
    const stateHashBefore = store.stateHash();
    store.close();

    const child = spawn(process.execPath, [crashWorker, filePath, signalPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let exited = false;
    let stderr = "";
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        exited = true;
        resolve(code);
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForFile(signalPath, () => exited);
    expect(child.kill("SIGKILL")).toBe(true);
    const exit = await exitPromise;
    if (exit === 0) throw new Error(`crash worker unexpectedly completed: ${stderr}`);

    const recovered = SqliteWorldStore.open(filePath);
    expect(recovered.stateHash()).toBe(stateHashBefore);
    expect(recovered.readState("crash-probe", "records", "main")?.value).toEqual({
      value: "baseline",
    });
    expect(recovered.metadata()).toMatchObject({ randomDraws: 0, virtualTimeUs: 5_000 });
    expect(recovered.listScheduledEvents()).toHaveLength(0);
    expect(recovered.readEvidence()).toEqual(evidenceBefore);
    recovered.close();
  }, 10_000);

  it("leaves scheduled work pending when its handler dies and completes it exactly once after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "firedrill-process-timer-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "world.sqlite");
    const signalPath = join(directory, "event-transaction-open");
    const store = SqliteWorldStore.create({
      filePath,
      worldInstanceId: "world_process04",
      buildHash: `sha256:${"e".repeat(64)}`,
      packageLockHash: `sha256:${"f".repeat(64)}`,
      seed: "2026",
      virtualTimeUs: 0,
      correlationId: "corr_processcreate",
      actors: [
        {
          bindingId: "actor_process01",
          actorId: "developer",
          grants: [{ packageId: "timer-source", operationId: "status.read" }],
        },
      ],
    });
    store.transact("corr_timersetup", (transaction) => {
      transaction.scheduleEvent(
        { packageId: "timer-source", eventId: "task.due" },
        { taskId: "task-1" },
        1_000,
        "actor_process01",
      );
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 0, toUs: 0, reason: "explicit" },
      };
    });
    store.close();

    const child = spawn(process.execPath, [scheduledEventWorker, filePath, "crash", signalPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let exited = false;
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        exited = true;
        resolve(code);
      });
    });
    await waitForFile(signalPath, () => exited);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await exitPromise).not.toBe(0);

    const afterCrash = SqliteWorldStore.open(filePath);
    expect(afterCrash.metadata().virtualTimeUs).toBe(1_000);
    expect(afterCrash.listScheduledEvents()).toEqual([
      expect.objectContaining({ status: "pending", actorBindingId: "actor_process01" }),
    ]);
    expect(afterCrash.readState("timer-consumer", "completed", "task-1")).toBeNull();
    afterCrash.close();

    execFileSync(process.execPath, [scheduledEventWorker, filePath, "complete"], {
      encoding: "utf8",
    });
    const recovered = SqliteWorldStore.open(filePath);
    expect(recovered.listScheduledEvents()).toEqual([expect.objectContaining({ status: "fired" })]);
    expect(recovered.readState("timer-consumer", "completed", "task-1")?.value).toEqual({
      taskId: "task-1",
      completed: true,
    });
    expect(
      recovered
        .readEvidence()
        .filter(
          (entry) =>
            entry.kind === "event" &&
            entry.phase === "handled" &&
            entry.handlerPackageId === "timer-consumer",
        ),
    ).toHaveLength(1);
    recovered.close();
  }, 10_000);
});
