import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CallbackDeliveryId,
  OperationInvocation,
  OperationOutcome,
  VirtualTime,
} from "@firedrill/contracts";
import type { CallbackTransition, WorldTransaction } from "@firedrill/world-store";
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

function enqueueReminder(
  store: SqliteWorldStore,
  retryDelaysUs: readonly VirtualTime[] = [1_000],
): CallbackDeliveryId {
  return store.transact("corr_callback", (transaction) => {
    const payload = { reminderId: "reminder_1" };
    const deliveryId = transaction.enqueueCallback({
      callback: { packageId: "calendar", callbackId: "send-reminder" },
      receiverId: "application",
      event: { packageId: "calendar", eventId: "reminder.due" },
      payload,
      eventSequence: transaction.primarySequence,
      dueUs: transaction.virtualTimeUs,
      actorBindingId: "actor_primary",
      retryDelaysUs,
    });
    return {
      value: deliveryId,
      primary: {
        kind: "event",
        event: { packageId: "calendar", eventId: "reminder.due" },
        phase: "emitted",
        payload,
      },
    };
  }).value;
}

const CALLBACK_REQUEST = {
  method: "POST",
  path: "/callbacks/reminders",
  bodyHash: HASH_A,
  bodyBytes: 37,
  signature: { kind: "none" },
} as const;

const CALLBACK_RESPONSE = {
  status: 204,
  body: "",
  bodyHash: HASH_B,
  bodyBytes: 0,
} as const;

function callbackResult(transition: CallbackTransition) {
  return { value: transition.delivery, primary: transition.evidence };
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

  it("revokes retained transaction contexts after commit and rollback", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    let committed!: WorldTransaction;
    store.transact(CORRELATION, (transaction) => {
      committed = transaction;
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      };
    });
    expect(() =>
      committed.putState("calendar", "events", "event_2", { id: "event_2", title: "Late write" }),
    ).toThrow(/no longer active/);
    expect(store.readState("calendar", "events", "event_2")).toBeNull();

    let rolledBack!: WorldTransaction;
    expect(() =>
      store.transact("corr_retained", (transaction) => {
        rolledBack = transaction;
        throw new Error("stop");
      }),
    ).toThrow(/stop/);
    expect(() => rolledBack.getState("calendar", "events", "event_0")).toThrow(/no longer active/);
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

describe("SQLite callback outbox", () => {
  it("commits callback intent with its event and advances through a deterministic retry", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const deliveryId = enqueueReminder(store);

    expect(store.nextCallbackDelivery(1_000)).toMatchObject({
      id: deliveryId,
      status: "pending",
      attemptCount: 0,
      retryDelaysUs: [1_000],
    });
    expect(
      store
        .readEvidence()
        .slice(-2)
        .map((entry) => entry.kind),
    ).toEqual(["event", "callback"]);

    store.transact("corr_attempt1", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(deliveryId, CALLBACK_REQUEST)),
    );
    expect(store.listCallbackDeliveries("in_flight")).toHaveLength(1);

    store.transact("corr_retry01", (transaction) =>
      callbackResult(
        transaction.settleCallbackAttempt(deliveryId, {
          status: "retry_scheduled",
          attempt: 1,
          nextAttemptUs: 2_000,
          response: { ...CALLBACK_RESPONSE, status: 503 },
          durationMs: 12,
        }),
      ),
    );
    expect(store.nextCallbackDelivery(1_999)).toBeNull();
    expect(store.nextCallbackDelivery(2_000)).toMatchObject({
      id: deliveryId,
      status: "pending",
      attemptCount: 1,
      dueUs: 2_000,
    });

    store.transact("corr_attempt2", (transaction) => {
      transaction.setVirtualTime(2_000);
      const transition = transaction.startCallbackAttempt(deliveryId, CALLBACK_REQUEST);
      transaction.appendEvidence(transition.evidence);
      return {
        value: transition.delivery,
        primary: { kind: "clock", fromUs: 1_000, toUs: 2_000, reason: "scheduled_work" },
      };
    });
    store.transact("corr_deliver1", (transaction) =>
      callbackResult(
        transaction.settleCallbackAttempt(deliveryId, {
          status: "delivered",
          attempt: 2,
          response: CALLBACK_RESPONSE,
          durationMs: 8,
        }),
      ),
    );
    expect(store.listCallbackDeliveries("delivered")).toMatchObject([{ id: deliveryId, attemptCount: 2 }]);
    expect(
      store
        .readEvidence()
        .filter((entry) => entry.kind === "callback")
        .map((entry) => entry.phase),
    ).toEqual(["queued", "attempt_started", "retry_scheduled", "attempt_started", "delivered"]);
    store.close();
  });

  it("rolls callback intent back with the transaction that emitted it", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const evidenceBefore = store.readEvidence().length;
    expect(() =>
      store.transact("corr_rollback", (transaction) => {
        transaction.enqueueCallback({
          callback: { packageId: "calendar", callbackId: "send-reminder" },
          receiverId: "application",
          event: { packageId: "calendar", eventId: "reminder.due" },
          payload: { reminderId: "reminder_1" },
          eventSequence: transaction.primarySequence,
          dueUs: transaction.virtualTimeUs,
          actorBindingId: "actor_primary",
          retryDelaysUs: [],
        });
        throw new Error("crash before commit");
      }),
    ).toThrow(/crash before commit/);
    expect(store.listCallbackDeliveries()).toEqual([]);
    expect(store.readEvidence()).toHaveLength(evidenceBefore);
    store.close();
  });

  it("recovers an interrupted attempt without ever claiming it was delivered", () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "world.sqlite");
    let store = createStore(directory);
    const retryingId = enqueueReminder(store, [500]);
    store.transact("corr_started1", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(retryingId, CALLBACK_REQUEST)),
    );
    store.close();

    store = SqliteWorldStore.open(filePath);
    store.transact("corr_recover1", (transaction) =>
      callbackResult(transaction.recoverCallbackAttempt(retryingId)),
    );
    expect(store.nextCallbackDelivery(1_500)).toMatchObject({
      id: retryingId,
      status: "pending",
      attemptCount: 1,
    });
    expect(store.readEvidence().at(-1)).toMatchObject({
      kind: "callback",
      phase: "recovered",
      deliveryId: retryingId,
    });

    const finalId = enqueueReminder(store, []);
    store.transact("corr_started2", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(finalId, CALLBACK_REQUEST)),
    );
    store.transact("corr_recover2", (transaction) =>
      callbackResult(transaction.recoverCallbackAttempt(finalId)),
    );
    expect(store.listCallbackDeliveries("failed")).toMatchObject([{ id: finalId }]);
    expect(store.readEvidence().at(-1)).toMatchObject({
      kind: "callback",
      phase: "failed",
      deliveryId: finalId,
      error: { code: "framework.CALLBACK_OUTCOME_UNKNOWN" },
    });
    store.close();
  });

  it("snapshots and restores pending callbacks with world state and virtual time", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const deliveryId = enqueueReminder(store, [500]);
    const snapshotPath = join(directory, "callback-baseline.sqlite");
    store.createSnapshot(snapshotPath, "corr_cb_snap");

    store.transact("corr_cb_fail", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(deliveryId, CALLBACK_REQUEST)),
    );
    store.transact("corr_cb_done", (transaction) =>
      callbackResult(
        transaction.settleCallbackAttempt(deliveryId, {
          status: "failed",
          attempt: 1,
          error: {
            code: "framework.CALLBACK_REJECTED",
            message: "receiver rejected request",
            retryable: false,
          },
          durationMs: 5,
        }),
      ),
    );
    expect(store.listCallbackDeliveries("failed")).toHaveLength(1);

    store.resetFromSnapshot(snapshotPath, "corr_cb_reset");
    expect(store.nextCallbackDelivery(1_000)).toMatchObject({
      id: deliveryId,
      status: "pending",
      attemptCount: 0,
    });
    expect(store.listCallbackDeliveries("failed")).toEqual([]);
    store.close();
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
