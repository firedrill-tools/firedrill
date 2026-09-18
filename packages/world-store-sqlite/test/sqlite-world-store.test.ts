import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CallbackDeliveryId,
  OperationInvocation,
  OperationOutcome,
  VirtualTime,
} from "@firedrill-run/contracts";
import type { CallbackTransition, WorldTransaction } from "@firedrill-run/world-store";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorldReader, SqliteWorldStore } from "../src/index.js";

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

function createScopedResetStore(directory: string) {
  return SqliteWorldStore.create({
    filePath: join(directory, "scoped-world.sqlite"),
    worldInstanceId: "world_scoped01",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "73",
    virtualTimeUs: 1_000,
    correlationId: "corr_scoped_create",
    actors: [
      {
        bindingId: "actor_primary",
        actorId: "developer",
        attributes: {},
        grants: [
          { packageId: "calendar", operationId: "events.create" },
          { packageId: "messaging", operationId: "messages.send" },
        ],
      },
    ],
    state: [
      {
        packageId: "calendar",
        namespace: "events",
        rowId: "event_0",
        value: { title: "Baseline calendar" },
      },
      {
        packageId: "messaging",
        namespace: "messages",
        rowId: "message_0",
        value: { text: "Baseline message" },
      },
    ],
    activeFaults: [
      { packageId: "calendar", faultId: "slow-write" },
      { packageId: "messaging", faultId: "delayed-send" },
    ],
  });
}

function enqueuePackageCallback(
  store: SqliteWorldStore,
  packageId: "calendar" | "messaging",
): CallbackDeliveryId {
  return store.transact(`corr_${packageId}_callback`, (transaction) => {
    const payload = { itemId: `${packageId}_1` };
    const deliveryId = transaction.enqueueCallback({
      callback: { packageId, callbackId: "notify-application" },
      receiverId: "application",
      event: { packageId, eventId: "item.changed" },
      payload,
      eventSequence: transaction.primarySequence,
      dueUs: transaction.virtualTimeUs,
      actorBindingId: "actor_primary",
      retryDelaysUs: [1_000],
    });
    return {
      value: deliveryId,
      primary: {
        kind: "event",
        event: { packageId, eventId: "item.changed" },
        phase: "emitted",
        payload,
      },
    };
  }).value;
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
  it("rolls back a savepoint's SQL, clock and buffered evidence without losing outer usage", () => {
    const store = createStore(temporaryDirectory());
    try {
      const committed = store.transact(CORRELATION, (transaction) => {
        expect(transaction.consumeToolOverride("calendar", "bounded-rule")).toBe(1);
        expect(() =>
          transaction.withSavepoint(() => {
            transaction.consumeToolOverride("calendar", "bounded-rule");
            transaction.putState("calendar", "events", "rolled-back", { title: "discard" });
            transaction.setVirtualTime(2_000);
            transaction.nextRandomU64("calendar");
            transaction.setFaultActive("calendar", "slow-write", false);
            transaction.putIdempotencyReceipt(INVOCATION, "request-hash", SUCCESS);
            transaction.scheduleEvent(
              { packageId: "calendar", eventId: "created" },
              {},
              3_000,
              "actor_primary",
            );
            throw new Error("rollback effects");
          }),
        ).toThrow("rollback effects");
        expect(transaction.virtualTimeUs).toBe(1_000);
        expect(transaction.toolOverrideMatchCount("calendar", "bounded-rule")).toBe(1);
        expect(transaction.getIdempotencyReceipt(INVOCATION)).toBeNull();
        expect(transaction.activeFaultIds("calendar")).toEqual(["slow-write"]);
        transaction.putState("calendar", "events", "kept", { title: "kept" });
        return {
          value: undefined,
          primary: {
            kind: "operation",
            invocation: INVOCATION,
            outcome: SUCCESS,
            idempotency: "not_recorded",
            toolOverride: {
              id: "bounded-rule",
              scope: { kind: "baseline" },
              outcome: "original",
              matchIndex: 1,
            },
          },
        };
      });
      expect(committed.evidence.map((entry) => entry.kind)).toEqual(["operation", "state_change"]);
      expect(store.readState("calendar", "events", "rolled-back")).toBeNull();
      expect(store.readState("calendar", "events", "kept")?.value).toEqual({ title: "kept" });
      expect(store.metadata()).toMatchObject({ virtualTimeUs: 1_000, randomDraws: 0 });
      expect(store.listScheduledEvents()).toEqual([]);
      store.transact(CORRELATION, (transaction) => {
        expect(() => transaction.withSavepoint(() => Promise.resolve(true))).toThrow("synchronous");
        expect(transaction.toolOverrideMatchCount("calendar", "bounded-rule")).toBe(1);
        return {
          value: undefined,
          primary: {
            kind: "operation",
            invocation: INVOCATION,
            outcome: SUCCESS,
            idempotency: "not_recorded",
          },
        };
      });
    } finally {
      store.close();
    }
  });

  it("package reset restores snapshot counters without clearing other packages", () => {
    const directory = temporaryDirectory();
    const store = createScopedResetStore(directory);
    const count = (packageId: string, consume = false) =>
      store.transact(CORRELATION, (transaction) => ({
        value: consume
          ? transaction.consumeToolOverride(packageId, "same-id")
          : transaction.toolOverrideMatchCount(packageId, "same-id"),
        primary: { kind: "lifecycle", action: "world_reset", worldInstanceId: "world_scoped01" },
      })).value;
    try {
      const empty = join(directory, "zero-counts.sqlite");
      store.createSnapshot(empty, CORRELATION);
      expect(count("calendar", true)).toBe(1);
      expect(count("messaging", true)).toBe(1);
      const snapshot = join(directory, "used-counts.sqlite");
      store.createSnapshot(snapshot, CORRELATION);
      expect(count("calendar", true)).toBe(2);
      expect(count("messaging", true)).toBe(2);
      store.resetPackagesFromSnapshot(snapshot, ["calendar"], CORRELATION);
      expect(count("calendar")).toBe(1);
      expect(count("messaging")).toBe(2);
      store.resetPackagesFromSnapshot(empty, ["calendar"], CORRELATION);
      expect(count("calendar")).toBe(0);
      expect(count("messaging")).toBe(2);
      expect(count("calendar", true)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("provides a query-only concurrent reader for live inspection", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    const reader = SqliteWorldReader.open(store.filePath);

    expect(reader.metadata().worldInstanceId).toBe("world_store01");
    expect(reader.listActiveFaults()).toEqual([{ packageId: "calendar", faultId: "slow-write" }]);
    expect(reader.scanState("calendar", "events")[0]?.value.title).toBe("Existing");
    expect(reader.listStateNamespaces()).toEqual([
      { packageId: "calendar", namespace: "events", records: 1 },
    ]);
    expect("transact" in reader).toBe(false);

    store.transact("corr_reader_update", (transaction) => {
      transaction.putState("calendar", "events", "event_1", {
        id: "event_1",
        title: "Visible while writer remains open",
      });
      return {
        value: undefined,
        primary: {
          kind: "lifecycle",
          action: "world_reset",
          worldInstanceId: "world_store01",
          details: { scope: "reader-test" },
        },
      };
    });

    expect(reader.readState("calendar", "events", "event_1")?.value.title).toBe(
      "Visible while writer remains open",
    );
    expect(reader.readEvidence().at(-1)?.kind).toBe("state_change");
    expect(reader.latestEvidenceSequence()).toBe(store.latestEvidenceSequence());

    reader.close();
    expect(() => reader.metadata()).toThrow(/reader is closed/);
    store.close();
  });

  it("reads bounded per-kind journal heads without letting operation receipts advance a state revision", () => {
    const store = createStore(temporaryDirectory());
    const reader = SqliteWorldReader.open(store.filePath);
    try {
      const initial = store.latestEvidenceSequence(["state_change", "lifecycle"]);
      store.transact(CORRELATION, () => ({
        value: undefined,
        primary: {
          kind: "operation",
          invocation: INVOCATION,
          outcome: SUCCESS,
          idempotency: "not_requested",
        },
      }));
      expect(store.latestEvidenceSequence()).toBeGreaterThan(initial);
      expect(store.latestEvidenceSequence(["state_change", "lifecycle"])).toBe(initial);
      expect(reader.latestEvidenceSequence(["state_change", "lifecycle"])).toBe(initial);
      store.transact(CORRELATION, (transaction) => {
        transaction.putState("calendar", "events", "event_0", { id: "event_0", title: "Changed" });
        return {
          value: undefined,
          primary: {
            kind: "operation",
            invocation: INVOCATION,
            outcome: SUCCESS,
            idempotency: "not_requested",
          },
        };
      });
      const changed = store.latestEvidenceSequence(["state_change"]);
      expect(changed).toBeGreaterThan(initial);
      expect(reader.latestEvidenceSequence(["state_change"])).toBe(changed);
      expect(store.latestEvidenceSequence(["state_change", "state_change"])).toBe(changed);
      expect(reader.latestEvidenceSequence([])).toBe(0);
      expect(reader.latestEvidenceSequence(["callback"])).toBe(0);
      expect(() => store.latestEvidenceSequence(["not-a-kind"] as never)).toThrow(/evidence kinds/);
      expect(() => reader.latestEvidenceSequence(Array(100).fill("operation"))).toThrow(/evidence kinds/);
      expect(() => reader.latestEvidenceSequence(null as never)).toThrow(/evidence kinds/);
      const inspect = new Database(store.filePath, { readonly: true });
      try {
        const plan = inspect
          .prepare(
            "EXPLAIN QUERY PLAN SELECT COALESCE(MAX(sequence), 0) AS sequence FROM evidence WHERE kind = ?",
          )
          .all("state_change") as Array<{ detail: string }>;
        expect(
          plan.some((row) => row.detail.includes("evidence_kind_idx") && row.detail.includes("SEARCH")),
        ).toBe(true);
      } finally {
        inspect.close();
      }
    } finally {
      reader.close();
      store.close();
    }
  });

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

  it("keeps scheduled and callback identities independent of lifecycle evidence", () => {
    const directory = temporaryDirectory();
    const direct = createStore(directory, "direct.sqlite");
    const lifecycleShifted = createStore(directory, "lifecycle-shifted.sqlite");
    lifecycleShifted.createSnapshot(
      join(directory, "lifecycle-shifted.snapshot.sqlite"),
      "corr_snapshot_shift",
    );

    const exercise = (store: SqliteWorldStore, correlationId: `corr_${string}`) =>
      store.transact(correlationId, (transaction) => {
        const payload = { itemId: "event_1" };
        const scheduledEventId = transaction.scheduleEvent(
          { packageId: "calendar", eventId: "reminder.due" },
          payload,
          2_000,
          "actor_primary",
        );
        const callbackDeliveryId = transaction.enqueueCallback({
          callback: { packageId: "calendar", callbackId: "notify-application" },
          receiverId: "application",
          event: { packageId: "calendar", eventId: "item.changed" },
          payload,
          eventSequence: transaction.primarySequence,
          dueUs: transaction.virtualTimeUs,
          actorBindingId: "actor_primary",
          retryDelaysUs: [],
        });
        return {
          value: { callbackDeliveryId, scheduledEventId },
          primary: {
            kind: "event" as const,
            event: { packageId: "calendar", eventId: "item.changed" },
            phase: "emitted" as const,
            payload,
          },
        };
      }).value;

    expect(lifecycleShifted.latestEvidenceSequence()).toBe(direct.latestEvidenceSequence() + 1);
    expect(exercise(direct, "corr_direct_identity")).toEqual(
      exercise(lifecycleShifted, "corr_shifted_identity"),
    );

    direct.close();
    lifecycleShifted.close();
  });

  it("rolls runtime identity counters back with a failed transaction", () => {
    const directory = temporaryDirectory();
    const store = createStore(directory);
    expect(() =>
      store.transact("corr_identity_rollback", (transaction) => {
        transaction.scheduleEvent(
          { packageId: "calendar", eventId: "reminder.due" },
          { itemId: "discarded" },
          2_000,
          "actor_primary",
        );
        throw new Error("discard scheduled identity");
      }),
    ).toThrow(/discard scheduled identity/);

    const scheduledEventId = store.transact("corr_identity_commit", (transaction) => {
      const id = transaction.scheduleEvent(
        { packageId: "calendar", eventId: "reminder.due" },
        { itemId: "committed" },
        2_000,
        "actor_primary",
      );
      return {
        value: id,
        primary: {
          kind: "lifecycle" as const,
          action: "world_reset" as const,
          worldInstanceId: "world_store01" as const,
          details: { scope: "identity-test" },
        },
      };
    }).value;

    expect(scheduledEventId).toBe("pending_world_0000000000001");
    store.close();
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

  it("restores selected Tool-owned runtime state without rewinding unrelated Tools or global time", () => {
    const directory = temporaryDirectory();
    const store = createScopedResetStore(directory);
    const scheduled = store.transact("corr_scoped_baseline", (transaction) => {
      const calendarEvent = transaction.scheduleEvent(
        { packageId: "calendar", eventId: "reminder.due" },
        { id: "calendar_1" },
        5_000,
        "actor_primary",
      );
      const messagingEvent = transaction.scheduleEvent(
        { packageId: "messaging", eventId: "delivery.due" },
        { id: "message_1" },
        6_000,
        "actor_primary",
      );
      transaction.putIdempotencyReceipt(INVOCATION, "sha256:calendar-baseline", SUCCESS);
      transaction.putIdempotencyReceipt(
        {
          ...INVOCATION,
          callId: "call_message01",
          operation: { packageId: "messaging", operationId: "messages.send" },
          idempotencyKey: "message-request-1",
        },
        "sha256:message-baseline",
        { status: "ok", value: { id: "message_1" } },
      );
      return {
        value: { calendarEvent, messagingEvent },
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      };
    }).value;
    const calendarCallback = enqueuePackageCallback(store, "calendar");
    const messagingCallback = enqueuePackageCallback(store, "messaging");
    const snapshotPath = join(directory, "scoped-baseline.sqlite");
    store.createSnapshot(snapshotPath, "corr_scoped_snapshot");

    store.transact("corr_scoped_mutate", (transaction) => {
      transaction.putState("calendar", "events", "event_0", { title: "Changed calendar" });
      transaction.putState("calendar", "events", "runtime-only", { title: "Remove me" });
      transaction.putState("messaging", "messages", "message_0", { text: "Changed message" });
      transaction.claimScheduledEvent(scheduled.calendarEvent, "fired");
      transaction.claimScheduledEvent(scheduled.messagingEvent, "fired");
      transaction.nextRandomU64("calendar");
      transaction.setVirtualTime(9_000);
      transaction.putIdempotencyReceipt(
        { ...INVOCATION, callId: "call_store02", idempotencyKey: "request-runtime" },
        "sha256:calendar-runtime",
        { status: "ok", value: { id: "event_runtime" } },
      );
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 9_000, reason: "explicit" },
      };
    });
    store.transact("corr_calendar_started", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(calendarCallback, CALLBACK_REQUEST)),
    );
    store.transact("corr_calendar_failed", (transaction) =>
      callbackResult(
        transaction.settleCallbackAttempt(calendarCallback, {
          status: "failed",
          attempt: 1,
          error: { code: "framework.CALLBACK_REJECTED", message: "rejected", retryable: false },
          durationMs: 1,
        }),
      ),
    );
    store.transact("corr_message_started", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(messagingCallback, CALLBACK_REQUEST)),
    );
    store.transact("corr_message_done", (transaction) =>
      callbackResult(
        transaction.settleCallbackAttempt(messagingCallback, {
          status: "delivered",
          attempt: 1,
          response: CALLBACK_RESPONSE,
          durationMs: 1,
        }),
      ),
    );

    const summary = store.resetPackagesFromSnapshot(
      snapshotPath,
      ["calendar", "calendar"],
      "corr_scoped_reset",
    );

    expect(summary).toEqual({
      packages: ["calendar"],
      stateChanges: 2,
      activeFaultsRestored: 1,
      scheduledEventsRestored: 1,
      callbacksRestored: 1,
      idempotencyReceiptsRestored: 1,
    });
    expect(store.readState("calendar", "events", "event_0")?.value.title).toBe("Baseline calendar");
    expect(store.readState("calendar", "events", "runtime-only")).toBeNull();
    expect(store.readState("messaging", "messages", "message_0")?.value.text).toBe("Changed message");
    expect(store.listScheduledEvents("pending").map((event) => event.id)).toEqual([scheduled.calendarEvent]);
    expect(store.listScheduledEvents("fired").map((event) => event.id)).toEqual([scheduled.messagingEvent]);
    expect(store.listCallbackDeliveries("pending").map((delivery) => delivery.id)).toEqual([
      calendarCallback,
    ]);
    expect(store.listCallbackDeliveries("delivered").map((delivery) => delivery.id)).toEqual([
      messagingCallback,
    ]);
    expect(store.metadata()).toMatchObject({ virtualTimeUs: 9_000, randomDraws: 1 });
    const receipts = store.transact("corr_scoped_inspect", (transaction) => ({
      value: {
        baseline: transaction.getIdempotencyReceipt(INVOCATION),
        runtime: transaction.getIdempotencyReceipt({
          ...INVOCATION,
          callId: "call_store02",
          idempotencyKey: "request-runtime",
        }),
        faults: transaction.activeFaultIds("calendar"),
      },
      primary: { kind: "clock", fromUs: 9_000, toUs: 9_000, reason: "explicit" },
    })).value;
    expect(receipts).toMatchObject({
      baseline: { requestHash: "sha256:calendar-baseline" },
      runtime: null,
      faults: ["slow-write"],
    });
    expect(
      store
        .readEvidence()
        .filter((entry) => entry.kind === "lifecycle" && entry.action === "world_reset")
        .at(-1),
    ).toMatchObject({
      details: { scope: "packages", packages: ["calendar"], stateChanges: 2 },
    });
    store.close();
  });

  it("rejects package reset from another world or while a selected callback is in flight", () => {
    const directory = temporaryDirectory();
    const store = createScopedResetStore(directory);
    const callback = enqueuePackageCallback(store, "calendar");
    const snapshotPath = join(directory, "scoped-safe.sqlite");
    store.createSnapshot(snapshotPath, "corr_scoped_safe");
    store.transact("corr_scoped_started", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(callback, CALLBACK_REQUEST)),
    );
    const stateHash = store.stateHash();
    const evidenceHash = store.evidenceHash();
    expect(() => store.resetPackagesFromSnapshot(snapshotPath, ["calendar"], "corr_scoped_inflight")).toThrow(
      /while callback .* is in flight/,
    );
    expect(store.stateHash()).toBe(stateHash);
    expect(store.evidenceHash()).toBe(evidenceHash);
    store.transact("corr_scoped_recover", (transaction) =>
      callbackResult(transaction.recoverCallbackAttempt(callback)),
    );

    const other = createStore(directory, "other.sqlite");
    const otherSnapshot = join(directory, "other-baseline.sqlite");
    other.createSnapshot(otherSnapshot, "corr_other_snapshot");
    other.close();
    expect(() => store.resetPackagesFromSnapshot(otherSnapshot, ["calendar"], "corr_scoped_other")).toThrow(
      /different world instance/,
    );
    store.close();
  });

  it("rejects a whole-world reset while a callback outcome is unknown", () => {
    const directory = temporaryDirectory();
    const store = createScopedResetStore(directory);
    const callback = enqueuePackageCallback(store, "calendar");
    const snapshotPath = join(directory, "whole-world-safe.sqlite");
    store.createSnapshot(snapshotPath, "corr_whole_safe");
    store.transact("corr_whole_started", (transaction) =>
      callbackResult(transaction.startCallbackAttempt(callback, CALLBACK_REQUEST)),
    );
    const stateHash = store.stateHash();
    const evidenceHash = store.evidenceHash();

    expect(() => store.resetFromSnapshot(snapshotPath, "corr_whole_inflight")).toThrow(
      /while callback .* is in flight/,
    );
    expect(store.stateHash()).toBe(stateHash);
    expect(store.evidenceHash()).toBe(evidenceHash);
    expect(store.listCallbackDeliveries("in_flight")).toHaveLength(1);
    store.close();
  });

  it("rolls back every selected resource when a scoped restore cannot commit", () => {
    const directory = temporaryDirectory();
    const store = createScopedResetStore(directory);
    const calendarCallback = enqueuePackageCallback(store, "calendar");
    const messagingCallback = enqueuePackageCallback(store, "messaging");
    const snapshotPath = join(directory, "conflicting-scoped-baseline.sqlite");
    store.createSnapshot(snapshotPath, "corr_conflict_snapshot");
    store.transact("corr_conflict_mutate", (transaction) => {
      transaction.putState("calendar", "events", "event_0", { title: "Must survive failure" });
      return {
        value: undefined,
        primary: { kind: "clock", fromUs: 1_000, toUs: 1_000, reason: "explicit" },
      };
    });

    const baseline = new Database(snapshotPath);
    baseline.prepare("DELETE FROM callback_deliveries WHERE id = ?").run(messagingCallback);
    baseline
      .prepare("UPDATE callback_deliveries SET id = ? WHERE id = ?")
      .run(messagingCallback, calendarCallback);
    baseline.close();
    const beforeState = store.stateHash();
    const beforeEvidence = store.evidenceHash();

    expect(() => store.resetPackagesFromSnapshot(snapshotPath, ["calendar"], "corr_conflict_reset")).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(store.stateHash()).toBe(beforeState);
    expect(store.evidenceHash()).toBe(beforeEvidence);
    expect(store.readState("calendar", "events", "event_0")?.value).toEqual({
      title: "Must survive failure",
    });
    expect(store.listCallbackDeliveries().map((delivery) => delivery.id)).toEqual([
      calendarCallback,
      messagingCallback,
    ]);
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
