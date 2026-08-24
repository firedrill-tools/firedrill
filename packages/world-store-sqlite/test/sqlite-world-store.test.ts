import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationInvocation, OperationOutcome } from "@firedrill/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorldStore } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;
const CORRELATION = "corr_store01" as const;
const INVOCATION: OperationInvocation = {
  schemaVersion: 1,
  callId: "call_store01",
  correlationId: CORRELATION,
  operation: { packageId: "calendar", operationId: "events.create" },
  actorBindingId: "actor_primary",
  arguments: { title: "Planning" },
  idempotencyKey: "request-1",
};
const SUCCESS: OperationOutcome = { status: "ok", value: { id: "event_1" } };

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-store-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createStore(
  directory: string,
  file = "world.sqlite",
  buildHash: typeof HASH_A | typeof HASH_C = HASH_A,
) {
  return SqliteWorldStore.create({
    filePath: join(directory, file),
    worldInstanceId: "world_store01",
    buildHash,
    packageLockHash: HASH_B,
    seed: "42",
    virtualTimeUs: 1_000,
    correlationId: CORRELATION,
    actors: [
      {
        bindingId: "actor_primary",
        actorId: "developer",
        attributes: { tier: "pro" },
        grants: [INVOCATION.operation],
      },
    ],
    state: [
      {
        packageId: "calendar",
        namespace: "events",
        rowId: "event_0",
        value: { id: "event_0", title: "Existing" },
      },
    ],
    activeFaults: [{ packageId: "calendar", faultId: "slow-write" }],
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite world transactions", () => {
  it("atomically commits state, random progress, pending work, receipts, and ordered evidence", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const committed = store.transact(CORRELATION, (transaction) => {
      expect(transaction.getActor("actor_primary")?.actorId).toBe("developer");
      expect(transaction.activeFaultIds("calendar")).toEqual(["slow-write"]);
      transaction.putState("calendar", "events", "event_1", { id: "event_1", title: "Planning" });
      const random = transaction.nextRandomU64("calendar");
      const scheduledId = transaction.scheduleEvent(
        { packageId: "calendar", eventId: "reminder.due" },
        { eventId: "event_1" },
        2_000,
        "actor_primary",
      );
      transaction.putIdempotencyReceipt(INVOCATION, "sha256:request", SUCCESS);
      return {
        value: { random, scheduledId },
        primary: {
          kind: "operation",
          invocation: INVOCATION,
          outcome: SUCCESS,
          idempotency: "recorded",
        },
      };
    });

    expect(committed.evidence.map((entry) => entry.kind)).toEqual([
      "operation",
      "state_change",
      "random",
      "event",
    ]);
    expect(new Set(committed.evidence.map((entry) => entry.transactionId)).size).toBe(1);
    expect(committed.evidence.map((entry) => entry.sequence)).toEqual([3, 4, 5, 6]);
    expect(store.readState("calendar", "events", "event_1")?.value.title).toBe("Planning");
    expect(store.nextScheduledEvent()?.id).toBe(committed.value.scheduledId);
    expect(store.metadata().randomDraws).toBe(1);
    store.close();

    const reopened = SqliteWorldStore.open(join(directory, "world.sqlite"));
    expect(reopened.readEvidence().map((entry) => entry.kind)).toEqual([
      "lifecycle",
      "state_change",
      "operation",
      "state_change",
      "random",
      "event",
    ]);
    expect(reopened.nextScheduledEvent()?.status).toBe("pending");
    reopened.close();
  });

  it("rolls back state and secondary evidence when transaction behavior crashes", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const evidenceBefore = store.readEvidence().length;
    expect(() =>
      store.transact(CORRELATION, (transaction) => {
        transaction.putState("calendar", "events", "event_0", { id: "event_0", title: "Corrupt" });
        throw new Error("crash after mutation");
      }),
    ).toThrow(/crash after mutation/);
    expect(store.readState("calendar", "events", "event_0")?.value.title).toBe("Existing");
    expect(store.readEvidence()).toHaveLength(evidenceBefore);
    store.close();
  });

  it("rejects corrupt or exhausted random draw metadata instead of losing determinism", () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "world.sqlite");
    const store = createStore(directory);
    store.close();

    const corrupt = new Database(filePath);
    corrupt.prepare("UPDATE world_meta SET value = ? WHERE key = 'random_draws'").run("not-a-count");
    corrupt.close();
    expect(() => SqliteWorldStore.open(filePath)).toThrow(/random draw count/);

    const exhausted = new Database(filePath);
    exhausted
      .prepare("UPDATE world_meta SET value = ? WHERE key = 'random_draws'")
      .run(String(Number.MAX_SAFE_INTEGER));
    exhausted.close();
    const reopened = SqliteWorldStore.open(filePath);
    expect(() =>
      reopened.transact("corr_rnglimit", (transaction) => ({
        value: transaction.nextRandomU64("calendar"),
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      })),
    ).toThrow(/cannot advance/);
    expect(reopened.metadata().randomDraws).toBe(Number.MAX_SAFE_INTEGER);
    reopened.close();
  });

  it("produces equal state and evidence for the same seed and input program", () => {
    const directory = temporaryDirectory();
    const left = createStore(directory, "left.sqlite");
    const right = createStore(directory, "right.sqlite");
    const execute = (store: SqliteWorldStore) =>
      store.transact(CORRELATION, (transaction) => {
        const value = transaction.nextRandomU64("calendar").toString();
        transaction.putState("calendar", "events", "event_1", { id: "event_1", random: value });
        transaction.scheduleEvent(
          { packageId: "calendar", eventId: "reminder.due" },
          { eventId: "event_1" },
          2_000,
          "actor_primary",
        );
        return {
          value,
          primary: {
            kind: "operation" as const,
            invocation: INVOCATION,
            outcome: { status: "ok" as const, value: { random: value } },
            idempotency: "recorded" as const,
          },
        };
      });
    expect(execute(left).value).toBe(execute(right).value);
    expect(left.stateHash()).toBe(right.stateHash());
    expect(left.evidenceHash()).toBe(right.evidenceHash());
    left.close();
    right.close();
  });
});

describe("SQLite snapshots, reset, and fork", () => {
  it("restores state, history, clock, pending events, and creates collision-safe snapshot ids", () => {
    const directory = temporaryDirectory();
    let store = createStore(directory);
    store.transact(CORRELATION, (transaction) => {
      transaction.scheduleEvent(
        { packageId: "calendar", eventId: "reminder.due" },
        { eventId: "event_0" },
        5_000,
        "actor_primary",
      );
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      };
    });
    const snapshotPath = join(directory, "baseline.sqlite");
    const firstSnapshotId = store.createSnapshot(snapshotPath, "corr_snap001");
    expect(existsSync(snapshotPath)).toBe(true);
    expect(existsSync(`${snapshotPath}-wal`)).toBe(false);
    store.close();
    store = SqliteWorldStore.open(join(directory, "world.sqlite"));

    store.transact("corr_mutate1", (transaction) => {
      transaction.putState("calendar", "events", "event_0", { id: "event_0", title: "Changed" });
      transaction.setVirtualTime(4_000);
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 4_000, reason: "explicit" },
      };
    });
    expect(store.metadata().virtualTimeUs).toBe(4_000);
    store.resetFromSnapshot(snapshotPath, "corr_reset01");
    expect(store.metadata().virtualTimeUs).toBe(1_000);
    expect(store.readState("calendar", "events", "event_0")?.value.title).toBe("Existing");
    expect(store.nextScheduledEvent()?.dueUs).toBe(5_000);
    expect(store.readEvidence().at(-1)).toMatchObject({ kind: "lifecycle", action: "world_reset" });

    const secondSnapshotId = store.createSnapshot(join(directory, "after-reset.sqlite"), "corr_snap002");
    expect(secondSnapshotId).not.toBe(firstSnapshotId);
    store.close();
  });

  it("rejects an incompatible snapshot before replacing the active world", () => {
    const directory = temporaryDirectory();
    const target = createStore(directory, "target.sqlite");
    const targetStateHash = target.stateHash();
    const targetEvidenceHash = target.evidenceHash();
    const incompatible = createStore(directory, "incompatible.sqlite", HASH_C);
    const snapshotPath = join(directory, "incompatible-snapshot.sqlite");
    incompatible.createSnapshot(snapshotPath, "corr_snap004");
    incompatible.close();

    expect(() => target.resetFromSnapshot(snapshotPath, "corr_reset02")).toThrow(
      /does not match world build/,
    );
    expect(target.stateHash()).toBe(targetStateHash);
    expect(target.evidenceHash()).toBe(targetEvidenceHash);
    expect(target.metadata().worldInstanceId).toBe("world_store01");
    target.close();
  });

  it("rejects a corrupt snapshot while leaving the active world open and unchanged", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const stateHash = store.stateHash();
    const evidenceHash = store.evidenceHash();
    const corruptPath = join(directory, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a sqlite database");

    expect(() => store.resetFromSnapshot(corruptPath, "corr_reset04")).toThrow();
    expect(store.stateHash()).toBe(stateHash);
    expect(store.evidenceHash()).toBe(evidenceHash);
    expect(store.metadata().worldInstanceId).toBe("world_store01");
    store.close();
  });

  it("forks a snapshot without allowing child writes to affect its parent", () => {
    const directory = temporaryDirectory();
    const parent = createStore(directory);
    const snapshotPath = join(directory, "fork-base.sqlite");
    const snapshotId = parent.createSnapshot(snapshotPath, "corr_snap003");
    const child = SqliteWorldStore.forkFromSnapshot({
      snapshotPath,
      destinationPath: join(directory, "child.sqlite"),
      snapshotId,
      worldInstanceId: "world_child01",
      correlationId: "corr_fork001",
    });
    expect(child.metadata()).toMatchObject({
      worldInstanceId: "world_child01",
      parentWorldInstanceId: "world_store01",
      parentSnapshotId: snapshotId,
    });
    child.transact("corr_child01", (transaction) => {
      transaction.putState("calendar", "events", "event_0", { id: "event_0", title: "Child" });
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      };
    });
    expect(child.readState("calendar", "events", "event_0")?.value.title).toBe("Child");
    expect(parent.readState("calendar", "events", "event_0")?.value.title).toBe("Existing");
    child.resetFromSnapshot(snapshotPath, "corr_reset03");
    expect(child.metadata()).toMatchObject({
      worldInstanceId: "world_child01",
      parentWorldInstanceId: "world_store01",
      parentSnapshotId: snapshotId,
    });
    expect(child.readState("calendar", "events", "event_0")?.value.title).toBe("Existing");
    expect(child.readEvidence().at(-1)).toMatchObject({
      kind: "lifecycle",
      action: "world_reset",
      worldInstanceId: "world_child01",
    });
    child.close();
    parent.close();
  });
});
