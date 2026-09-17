import type {
  ActorBindingId,
  CallbackDeliveryId,
  CallbackErrorEvidence,
  CallbackRequestEvidence,
  CorrelationId,
  EvidenceEntry,
  JsonObject,
  JsonValue,
  OperationInvocation,
  OperationOutcome,
  PackageId,
  ScheduledEventId,
  StableId,
  VirtualTime,
} from "@firedrill-tools/contracts";
import {
  ActorBindingIdSchema,
  ActorIdSchema,
  CallbackDeliveryIdSchema,
  CallbackErrorEvidenceSchema,
  CallbackRefSchema,
  CallbackRequestEvidenceSchema,
  CallbackResponseEvidenceSchema,
  CorrelationIdSchema,
  canonicalJson,
  EventRefSchema,
  EvidenceEntrySchema,
  JsonObjectSchema,
  OperationOutcomeSchema,
  OperationRefSchema,
  PackageIdSchema,
  ScheduledEventIdSchema,
  StableIdSchema,
  VirtualTimeSchema,
} from "@firedrill-tools/contracts";
import type {
  CallbackAttemptSettlement,
  CallbackDelivery,
  CallbackTransition,
  EvidenceDraft,
  IdempotencyReceipt,
  ScheduledEvent,
  StateScanOptions,
  StoredActor,
  StoredStateRecord,
  WorldTransaction,
} from "@firedrill-tools/world-store";
import type Database from "better-sqlite3";
import { decodeObject, decodeStoredCount, encodeJson, hashJson } from "./codec.js";
import { toolOverrideUsageKey } from "./tool-override-usage.js";

interface StateRow {
  package_id: string;
  namespace: string;
  row_id: string;
  value_json: string;
}

interface ActorRow {
  binding_id: string;
  actor_id: string;
  attributes_json: string;
  grants_json: string;
}

interface ReceiptRow {
  request_hash: string;
  outcome_json: string;
  first_sequence: number;
}

interface ScheduledRow {
  id: string;
  package_id: string;
  event_id: string;
  payload_json: string;
  due_us: number;
  correlation_id: string;
  actor_binding_id: string;
  cause_sequence: number;
  status: ScheduledEvent["status"];
}

export interface CallbackRow {
  id: string;
  package_id: string;
  callback_id: string;
  receiver_id: string;
  event_package_id: string;
  event_id: string;
  payload_json: string;
  event_sequence: number;
  due_us: number;
  correlation_id: string;
  actor_binding_id: string;
  status: CallbackDelivery["status"];
  attempt_count: number;
  retry_delays_json: string;
}

type InternalEvidenceDraft =
  | EvidenceDraft
  | {
      readonly kind: "state_change";
      readonly packageId: PackageId;
      readonly namespace: StableId;
      readonly rowId: string;
      readonly change: "insert" | "update" | "delete";
      readonly before: JsonObject | null;
      readonly after: JsonObject | null;
      readonly deltaHash: string;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "random";
      readonly packageId: PackageId;
      readonly draw: number;
      readonly value: string;
      readonly causeSequence?: number;
    };

const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
const SPLITMIX_INCREMENT = 0x9e37_79b9_7f4a_7c15n;
const MIX_1 = 0xbf58_476d_1ce4_e5b9n;
const MIX_2 = 0x94d0_49bb_1331_11ebn;
export const CALLBACK_COLUMNS =
  "id, package_id, callback_id, receiver_id, event_package_id, event_id, payload_json, event_sequence, due_us, correlation_id, actor_binding_id, status, attempt_count, retry_delays_json";

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("state scan limit must be an integer from 1 through 10000");
  }
  return limit;
}

function stateRecord(row: StateRow): StoredStateRecord {
  return {
    packageId: PackageIdSchema.parse(row.package_id),
    namespace: StableIdSchema.parse(row.namespace),
    rowId: row.row_id,
    value: decodeObject(row.value_json),
  };
}

export function scheduledEvent(row: ScheduledRow): ScheduledEvent {
  return {
    id: ScheduledEventIdSchema.parse(row.id),
    event: EventRefSchema.parse({ packageId: row.package_id, eventId: row.event_id }),
    payload: decodeObject(row.payload_json),
    dueUs: VirtualTimeSchema.parse(row.due_us),
    correlationId: CorrelationIdSchema.parse(row.correlation_id),
    actorBindingId: ActorBindingIdSchema.parse(row.actor_binding_id),
    causeSequence: row.cause_sequence,
    status: row.status,
  };
}

function retryDelays(value: string): readonly VirtualTime[] {
  const decoded = JSON.parse(value) as unknown;
  if (!Array.isArray(decoded) || decoded.length > 9) {
    throw new TypeError("stored callback retry delays are invalid");
  }
  return Object.freeze(decoded.map((delay) => VirtualTimeSchema.parse(delay)));
}

export function callbackDelivery(row: CallbackRow): CallbackDelivery {
  if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence < 1) {
    throw new TypeError("stored callback event sequence is invalid");
  }
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > 10) {
    throw new TypeError("stored callback attempt count is invalid");
  }
  return {
    id: CallbackDeliveryIdSchema.parse(row.id),
    callback: CallbackRefSchema.parse({ packageId: row.package_id, callbackId: row.callback_id }),
    receiverId: StableIdSchema.parse(row.receiver_id),
    event: EventRefSchema.parse({ packageId: row.event_package_id, eventId: row.event_id }),
    payload: decodeObject(row.payload_json),
    eventSequence: row.event_sequence,
    dueUs: VirtualTimeSchema.parse(row.due_us),
    correlationId: CorrelationIdSchema.parse(row.correlation_id),
    actorBindingId: ActorBindingIdSchema.parse(row.actor_binding_id),
    status: row.status,
    attemptCount: row.attempt_count,
    retryDelaysUs: retryDelays(row.retry_delays_json),
  };
}

function removeCause(draft: InternalEvidenceDraft): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...draft };
  delete copy.causeSequence;
  return copy;
}

export class SqliteWorldTransaction implements WorldTransaction {
  readonly primarySequence: number;
  private active = true;
  private currentVirtualTimeUs: VirtualTime;
  private readonly secondaryEvidence: InternalEvidenceDraft[] = [];
  private savepointCount = 0;

  constructor(
    private readonly database: Database.Database,
    private readonly correlationId: CorrelationId,
  ) {
    const row = database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM evidence").get() as {
      next: number;
    };
    this.primarySequence = row.next;
    this.currentVirtualTimeUs = VirtualTimeSchema.parse(Number(this.meta("virtual_time_us")));
  }

  get virtualTimeUs(): VirtualTime {
    this.assertActive();
    return this.currentVirtualTimeUs;
  }

  revoke(): void {
    this.active = false;
  }

  withSavepoint<T>(execute: () => T): T {
    this.assertActive();
    const name = `firedrill_effects_${++this.savepointCount}`;
    const evidenceLength = this.secondaryEvidence.length;
    const virtualTimeUs = this.currentVirtualTimeUs;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = execute();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        throw new TypeError("world savepoints must be synchronous and deterministic");
      }
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      this.secondaryEvidence.length = evidenceLength;
      this.currentVirtualTimeUs = virtualTimeUs;
      throw error;
    }
  }

  toolOverrideMatchCount(packageId: PackageId, overrideId: StableId): number {
    this.assertActive();
    const row = this.database
      .prepare("SELECT value FROM world_meta WHERE key = ?")
      .get(toolOverrideUsageKey(packageId, overrideId)) as { value: string } | undefined;
    return row === undefined ? 0 : decodeStoredCount(row.value, "Tool override match count");
  }

  consumeToolOverride(packageId: PackageId, overrideId: StableId): number {
    this.assertActive();
    const next = this.toolOverrideMatchCount(packageId, overrideId) + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError("Tool override match count overflow");
    this.database
      .prepare(
        "INSERT INTO world_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(toolOverrideUsageKey(packageId, overrideId), String(next));
    return next;
  }

  getActor(bindingId: ActorBindingId): StoredActor | null {
    this.assertActive();
    const parsedBinding = ActorBindingIdSchema.parse(bindingId);
    const row = this.database
      .prepare("SELECT binding_id, actor_id, attributes_json, grants_json FROM actors WHERE binding_id = ?")
      .get(parsedBinding) as ActorRow | undefined;
    if (row === undefined) return null;
    const grants = JSON.parse(row.grants_json) as unknown;
    if (!Array.isArray(grants)) throw new TypeError("stored actor grants are not an array");
    return {
      bindingId: row.binding_id as ActorBindingId,
      actorId: ActorIdSchema.parse(row.actor_id),
      attributes: decodeObject(row.attributes_json),
      grants: grants.map((grant) => {
        if (typeof grant !== "object" || grant === null) throw new TypeError("stored actor grant is invalid");
        return OperationRefSchema.parse(grant);
      }),
    };
  }

  getState(packageId: PackageId, namespace: StableId, rowId: string): StoredStateRecord | null {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const stateNamespace = StableIdSchema.parse(namespace);
    if (rowId.length === 0 || rowId.length > 512) throw new RangeError("state row id length is invalid");
    const row = this.database
      .prepare(
        "SELECT package_id, namespace, row_id, value_json FROM world_state WHERE package_id = ? AND namespace = ? AND row_id = ?",
      )
      .get(owner, stateNamespace, rowId) as StateRow | undefined;
    return row === undefined ? null : stateRecord(row);
  }

  scanState(
    packageId: PackageId,
    namespace: StableId,
    options: StateScanOptions = {},
  ): readonly StoredStateRecord[] {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const stateNamespace = StableIdSchema.parse(namespace);
    const limit = normalizeLimit(options.limit);
    const rows = options.afterRowId
      ? (this.database
          .prepare(
            "SELECT package_id, namespace, row_id, value_json FROM world_state WHERE package_id = ? AND namespace = ? AND row_id > ? ORDER BY row_id LIMIT ?",
          )
          .all(owner, stateNamespace, options.afterRowId, limit) as StateRow[])
      : (this.database
          .prepare(
            "SELECT package_id, namespace, row_id, value_json FROM world_state WHERE package_id = ? AND namespace = ? ORDER BY row_id LIMIT ?",
          )
          .all(owner, stateNamespace, limit) as StateRow[]);
    return rows.map(stateRecord);
  }

  putState(packageId: PackageId, namespace: StableId, rowId: string, value: JsonObject): void {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const stateNamespace = StableIdSchema.parse(namespace);
    const normalized = JsonObjectSchema.parse(JSON.parse(canonicalJson(JsonObjectSchema.parse(value))));
    const before = this.getState(owner, stateNamespace, rowId)?.value ?? null;
    if (before !== null && canonicalJson(before) === canonicalJson(normalized)) return;
    this.database
      .prepare(
        `INSERT INTO world_state (package_id, namespace, row_id, value_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(package_id, namespace, row_id) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(owner, stateNamespace, rowId, encodeJson(normalized));
    const after = normalized;
    this.secondaryEvidence.push({
      kind: "state_change",
      packageId: owner,
      namespace: stateNamespace,
      rowId,
      change: before === null ? "insert" : "update",
      before,
      after,
      deltaHash: hashJson({ packageId: owner, namespace: stateNamespace, rowId, before, after }),
    });
  }

  deleteState(packageId: PackageId, namespace: StableId, rowId: string): boolean {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const stateNamespace = StableIdSchema.parse(namespace);
    const before = this.getState(owner, stateNamespace, rowId)?.value ?? null;
    if (before === null) return false;
    this.database
      .prepare("DELETE FROM world_state WHERE package_id = ? AND namespace = ? AND row_id = ?")
      .run(owner, stateNamespace, rowId);
    this.secondaryEvidence.push({
      kind: "state_change",
      packageId: owner,
      namespace: stateNamespace,
      rowId,
      change: "delete",
      before,
      after: null,
      deltaHash: hashJson({ packageId: owner, namespace: stateNamespace, rowId, before, after: null }),
    });
    return true;
  }

  nextRandomU64(packageId: PackageId): bigint {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    let state = BigInt(this.meta("random_state"));
    state = (state + SPLITMIX_INCREMENT) & UINT64_MASK;
    let value = state;
    value = ((value ^ (value >> 30n)) * MIX_1) & UINT64_MASK;
    value = ((value ^ (value >> 27n)) * MIX_2) & UINT64_MASK;
    value = (value ^ (value >> 31n)) & UINT64_MASK;
    const previousDraws = decodeStoredCount(this.meta("random_draws"), "random draw count");
    if (previousDraws === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("random draw count cannot advance beyond the safe integer range");
    }
    const draw = previousDraws + 1;
    this.setMeta("random_state", state.toString());
    this.setMeta("random_draws", String(draw));
    this.secondaryEvidence.push({ kind: "random", packageId: owner, draw, value: value.toString() });
    return value;
  }

  activeFaultIds(packageId: PackageId): readonly StableId[] {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const rows = this.database
      .prepare("SELECT fault_id FROM active_faults WHERE package_id = ? ORDER BY fault_id")
      .all(owner) as Array<{ fault_id: string }>;
    return rows.map((row) => StableIdSchema.parse(row.fault_id));
  }

  setFaultActive(packageId: PackageId, faultId: StableId, active: boolean): boolean {
    this.assertActive();
    const owner = PackageIdSchema.parse(packageId);
    const id = StableIdSchema.parse(faultId);
    if (typeof active !== "boolean") throw new TypeError("fault active must be a boolean");
    const previous =
      this.database
        .prepare("SELECT 1 FROM active_faults WHERE package_id = ? AND fault_id = ?")
        .get(owner, id) !== undefined;
    if (active) {
      this.database
        .prepare("INSERT OR IGNORE INTO active_faults (package_id, fault_id) VALUES (?, ?)")
        .run(owner, id);
    } else {
      this.database.prepare("DELETE FROM active_faults WHERE package_id = ? AND fault_id = ?").run(owner, id);
    }
    return previous;
  }

  getIdempotencyReceipt(invocation: OperationInvocation): IdempotencyReceipt | null {
    this.assertActive();
    if (invocation.idempotencyKey === undefined) return null;
    const row = this.database
      .prepare(
        `SELECT request_hash, outcome_json, first_sequence FROM idempotency_receipts
         WHERE package_id = ? AND operation_id = ? AND actor_binding_id = ? AND idempotency_key = ?`,
      )
      .get(
        invocation.operation.packageId,
        invocation.operation.operationId,
        invocation.actorBindingId,
        invocation.idempotencyKey,
      ) as ReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      requestHash: row.request_hash,
      outcome: OperationOutcomeSchema.parse(JSON.parse(row.outcome_json)),
      firstSequence: row.first_sequence,
    };
  }

  putIdempotencyReceipt(
    invocation: OperationInvocation,
    requestHash: string,
    outcome: OperationOutcome,
  ): void {
    this.assertActive();
    if (invocation.idempotencyKey === undefined) {
      throw new TypeError("cannot store an idempotency receipt without a key");
    }
    this.database
      .prepare(
        `INSERT INTO idempotency_receipts
         (package_id, operation_id, actor_binding_id, idempotency_key, request_hash, outcome_json, first_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invocation.operation.packageId,
        invocation.operation.operationId,
        invocation.actorBindingId,
        invocation.idempotencyKey,
        requestHash,
        encodeJson(OperationOutcomeSchema.parse(outcome) as JsonValue),
        this.primarySequence,
      );
  }

  appendEvidence(draft: EvidenceDraft): number {
    this.assertActive();
    this.secondaryEvidence.push(draft);
    return this.primarySequence + this.secondaryEvidence.length;
  }

  scheduleEvent(
    event: ScheduledEvent["event"],
    payload: JsonObject,
    dueUs: VirtualTime,
    actorBindingId: ActorBindingId,
  ): ScheduledEventId {
    this.assertActive();
    const parsedEvent = EventRefSchema.parse(event);
    const parsedPayload = JsonObjectSchema.parse(payload);
    const parsedDue = VirtualTimeSchema.parse(dueUs);
    const parsedActorBindingId = ActorBindingIdSchema.parse(actorBindingId);
    if (parsedDue < this.virtualTimeUs) throw new RangeError("cannot schedule an event in the past");
    const identity = this.nextRuntimeIdentity("scheduled_event_id_counter", "scheduled event");
    const id = ScheduledEventIdSchema.parse(`pending_world_${identity.toString(36).padStart(13, "0")}`);
    this.database
      .prepare(
        `INSERT INTO scheduled_events
         (id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        parsedEvent.packageId,
        parsedEvent.eventId,
        encodeJson(parsedPayload),
        parsedDue,
        this.correlationId,
        parsedActorBindingId,
        this.primarySequence,
      );
    this.secondaryEvidence.push({
      kind: "event",
      event: parsedEvent,
      phase: "scheduled",
      payload: parsedPayload,
      scheduledEventId: id,
      scheduledForUs: parsedDue,
    });
    return id;
  }

  setVirtualTime(toUs: VirtualTime): void {
    this.assertActive();
    const parsed = VirtualTimeSchema.parse(toUs);
    if (parsed < this.currentVirtualTimeUs) throw new RangeError("virtual clock cannot move backward");
    this.setMeta("virtual_time_us", String(parsed));
    this.currentVirtualTimeUs = parsed;
  }

  claimScheduledEvent(id: ScheduledEventId, status: "fired" | "failed"): ScheduledEvent {
    this.assertActive();
    const row = this.database
      .prepare(
        "SELECT id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status FROM scheduled_events WHERE id = ?",
      )
      .get(id) as ScheduledRow | undefined;
    if (row === undefined) throw new Error(`scheduled event ${id} does not exist`);
    if (row.status !== "pending") throw new Error(`scheduled event ${id} is already ${row.status}`);
    this.database
      .prepare("UPDATE scheduled_events SET status = ? WHERE id = ? AND status = 'pending'")
      .run(status, id);
    return scheduledEvent({ ...row, status });
  }

  enqueueCallback(input: {
    readonly callback: CallbackDelivery["callback"];
    readonly receiverId: StableId;
    readonly event: CallbackDelivery["event"];
    readonly payload: JsonObject;
    readonly eventSequence: number;
    readonly dueUs: VirtualTime;
    readonly actorBindingId: ActorBindingId;
    readonly retryDelaysUs: readonly VirtualTime[];
  }): CallbackDeliveryId {
    this.assertActive();
    const callback = CallbackRefSchema.parse(input.callback);
    const receiverId = StableIdSchema.parse(input.receiverId);
    const event = EventRefSchema.parse(input.event);
    const payload = JsonObjectSchema.parse(input.payload);
    const dueUs = VirtualTimeSchema.parse(input.dueUs);
    const actorBindingId = ActorBindingIdSchema.parse(input.actorBindingId);
    const retryDelaysUs = input.retryDelaysUs.map((delay) => VirtualTimeSchema.parse(delay));
    if (retryDelaysUs.length > 9) throw new RangeError("a callback supports at most nine retries");
    if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 1) {
      throw new RangeError("callback event sequence must be a positive safe integer");
    }
    const evidenceSequence = this.primarySequence + this.secondaryEvidence.length + 1;
    if (input.eventSequence >= evidenceSequence) {
      throw new RangeError("callback event evidence must precede callback queue evidence");
    }
    if (dueUs < this.virtualTimeUs) throw new RangeError("cannot queue a callback in the past");

    const identity = this.nextRuntimeIdentity("callback_delivery_id_counter", "callback delivery");
    const id = CallbackDeliveryIdSchema.parse(`delivery_world_${identity.toString(36).padStart(13, "0")}`);
    this.database
      .prepare(
        `INSERT INTO callback_deliveries
         (id, package_id, callback_id, receiver_id, event_package_id, event_id, payload_json,
          event_sequence, due_us, correlation_id, actor_binding_id, status, attempt_count,
          retry_delays_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        id,
        callback.packageId,
        callback.callbackId,
        receiverId,
        event.packageId,
        event.eventId,
        encodeJson(payload),
        input.eventSequence,
        dueUs,
        this.correlationId,
        actorBindingId,
        encodeJson(retryDelaysUs),
      );
    this.secondaryEvidence.push({
      kind: "callback",
      callback,
      deliveryId: id,
      receiverId,
      event,
      phase: "queued",
      idempotencyKey: id,
      scheduledForUs: dueUs,
      causeSequence: input.eventSequence,
    });
    return id;
  }

  startCallbackAttempt(id: CallbackDeliveryId, request: CallbackRequestEvidence): CallbackTransition {
    this.assertActive();
    const deliveryId = CallbackDeliveryIdSchema.parse(id);
    const parsedRequest = CallbackRequestEvidenceSchema.parse(request);
    const delivery = this.requireCallback(deliveryId);
    if (delivery.status !== "pending") {
      throw new Error(`callback delivery ${deliveryId} is already ${delivery.status}`);
    }
    if (delivery.dueUs > this.virtualTimeUs) {
      throw new Error(`callback delivery ${deliveryId} is not due`);
    }
    const attempt = delivery.attemptCount + 1;
    if (attempt > delivery.retryDelaysUs.length + 1) {
      throw new Error(`callback delivery ${deliveryId} has exhausted its attempts`);
    }
    const changed = this.database
      .prepare(
        "UPDATE callback_deliveries SET status = 'in_flight', attempt_count = ? WHERE id = ? AND status = 'pending'",
      )
      .run(attempt, deliveryId);
    if (changed.changes !== 1) throw new Error(`callback delivery ${deliveryId} could not be claimed`);
    const evidence = {
      kind: "callback",
      callback: delivery.callback,
      deliveryId,
      receiverId: delivery.receiverId,
      event: delivery.event,
      phase: "attempt_started",
      attempt,
      idempotencyKey: deliveryId,
      request: parsedRequest,
      causeSequence: delivery.eventSequence,
    } as const;
    return { delivery: { ...delivery, status: "in_flight", attemptCount: attempt }, evidence };
  }

  failCallbackDelivery(id: CallbackDeliveryId, error: CallbackErrorEvidence): CallbackTransition {
    this.assertActive();
    const deliveryId = CallbackDeliveryIdSchema.parse(id);
    const delivery = this.requireCallback(deliveryId);
    if (delivery.status !== "pending") {
      throw new Error(`callback delivery ${deliveryId} is ${delivery.status}, not pending`);
    }
    const parsedError = CallbackErrorEvidenceSchema.parse(error);
    const attempt = delivery.attemptCount + 1;
    const changed = this.database
      .prepare(
        "UPDATE callback_deliveries SET status = 'failed', attempt_count = ? WHERE id = ? AND status = 'pending'",
      )
      .run(attempt, deliveryId);
    if (changed.changes !== 1) throw new Error(`callback delivery ${deliveryId} could not be failed`);
    const evidence = {
      kind: "callback",
      callback: delivery.callback,
      deliveryId,
      receiverId: delivery.receiverId,
      event: delivery.event,
      phase: "failed",
      attempt,
      idempotencyKey: deliveryId,
      error: parsedError,
      durationMs: 0,
      causeSequence: delivery.eventSequence,
    } as const;
    return { delivery: { ...delivery, status: "failed", attemptCount: attempt }, evidence };
  }

  settleCallbackAttempt(id: CallbackDeliveryId, settlement: CallbackAttemptSettlement): CallbackTransition {
    this.assertActive();
    const deliveryId = CallbackDeliveryIdSchema.parse(id);
    const delivery = this.requireCallback(deliveryId);
    if (delivery.status !== "in_flight") {
      throw new Error(`callback delivery ${deliveryId} is ${delivery.status}, not in flight`);
    }
    if (settlement.attempt !== delivery.attemptCount) {
      throw new Error(`callback delivery ${deliveryId} attempt does not match the active attempt`);
    }
    if (
      !Number.isFinite(settlement.durationMs) ||
      settlement.durationMs < 0 ||
      settlement.durationMs > 60_000
    ) {
      throw new RangeError("callback duration must be from 0 through 60000 milliseconds");
    }

    if (settlement.status === "delivered") {
      const response = CallbackResponseEvidenceSchema.parse(settlement.response);
      if (response.status < 200 || response.status > 299) {
        throw new TypeError("only a 2xx callback response can be marked delivered");
      }
      this.updateCallbackStatus(deliveryId, "in_flight", "delivered");
      const evidence = {
        kind: "callback",
        callback: delivery.callback,
        deliveryId,
        receiverId: delivery.receiverId,
        event: delivery.event,
        phase: "delivered",
        attempt: settlement.attempt,
        idempotencyKey: deliveryId,
        response,
        durationMs: settlement.durationMs,
        causeSequence: delivery.eventSequence,
      } as const;
      return { delivery: { ...delivery, status: "delivered" }, evidence };
    }

    const response =
      settlement.response === undefined
        ? undefined
        : CallbackResponseEvidenceSchema.parse(settlement.response);
    const error =
      settlement.error === undefined ? undefined : CallbackErrorEvidenceSchema.parse(settlement.error);
    if (response === undefined && error === undefined) {
      throw new TypeError("a failed callback attempt requires a response or an error");
    }

    if (settlement.status === "retry_scheduled") {
      const retryDelay = delivery.retryDelaysUs[settlement.attempt - 1];
      if (retryDelay === undefined) {
        throw new Error(`callback delivery ${deliveryId} has no retry remaining`);
      }
      const expectedNextAttemptUs = VirtualTimeSchema.parse(this.virtualTimeUs + retryDelay);
      const nextAttemptUs = VirtualTimeSchema.parse(settlement.nextAttemptUs);
      if (nextAttemptUs !== expectedNextAttemptUs) {
        throw new Error(
          `callback delivery ${deliveryId} retry must be scheduled for ${String(expectedNextAttemptUs)}`,
        );
      }
      const changed = this.database
        .prepare(
          "UPDATE callback_deliveries SET status = 'pending', due_us = ? WHERE id = ? AND status = 'in_flight'",
        )
        .run(nextAttemptUs, deliveryId);
      if (changed.changes !== 1) throw new Error(`callback delivery ${deliveryId} could not be retried`);
      const evidence = {
        kind: "callback",
        callback: delivery.callback,
        deliveryId,
        receiverId: delivery.receiverId,
        event: delivery.event,
        phase: "retry_scheduled",
        attempt: settlement.attempt,
        idempotencyKey: deliveryId,
        scheduledForUs: nextAttemptUs,
        ...(response === undefined ? {} : { response }),
        ...(error === undefined ? {} : { error }),
        durationMs: settlement.durationMs,
        causeSequence: delivery.eventSequence,
      } as const;
      return { delivery: { ...delivery, status: "pending", dueUs: nextAttemptUs }, evidence };
    }

    this.updateCallbackStatus(deliveryId, "in_flight", "failed");
    const evidence = {
      kind: "callback",
      callback: delivery.callback,
      deliveryId,
      receiverId: delivery.receiverId,
      event: delivery.event,
      phase: "failed",
      attempt: settlement.attempt,
      idempotencyKey: deliveryId,
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error }),
      durationMs: settlement.durationMs,
      causeSequence: delivery.eventSequence,
    } as const;
    return { delivery: { ...delivery, status: "failed" }, evidence };
  }

  recoverCallbackAttempt(id: CallbackDeliveryId): CallbackTransition {
    this.assertActive();
    const deliveryId = CallbackDeliveryIdSchema.parse(id);
    const delivery = this.requireCallback(deliveryId);
    if (delivery.status !== "in_flight") {
      throw new Error(`callback delivery ${deliveryId} is ${delivery.status}, not in flight`);
    }
    const retryDelay = delivery.retryDelaysUs[delivery.attemptCount - 1];
    if (retryDelay !== undefined) {
      const dueUs = VirtualTimeSchema.parse(this.virtualTimeUs + retryDelay);
      const changed = this.database
        .prepare(
          "UPDATE callback_deliveries SET status = 'pending', due_us = ? WHERE id = ? AND status = 'in_flight'",
        )
        .run(dueUs, deliveryId);
      if (changed.changes !== 1) throw new Error(`callback delivery ${deliveryId} could not be recovered`);
      const evidence = {
        kind: "callback",
        callback: delivery.callback,
        deliveryId,
        receiverId: delivery.receiverId,
        event: delivery.event,
        phase: "recovered",
        attempt: delivery.attemptCount,
        idempotencyKey: deliveryId,
        scheduledForUs: dueUs,
        causeSequence: delivery.eventSequence,
      } as const;
      return { delivery: { ...delivery, status: "pending", dueUs }, evidence };
    }

    this.updateCallbackStatus(deliveryId, "in_flight", "failed");
    const error = CallbackErrorEvidenceSchema.parse({
      code: "framework.CALLBACK_OUTCOME_UNKNOWN",
      message: "callback outcome is unknown after the local process stopped during its final attempt",
      retryable: false,
    });
    const evidence = {
      kind: "callback",
      callback: delivery.callback,
      deliveryId,
      receiverId: delivery.receiverId,
      event: delivery.event,
      phase: "failed",
      attempt: delivery.attemptCount,
      idempotencyKey: deliveryId,
      error,
      durationMs: 0,
      causeSequence: delivery.eventSequence,
    } as const;
    return { delivery: { ...delivery, status: "failed" }, evidence };
  }

  finish<T>(value: T, primary: EvidenceDraft): { value: T; evidence: readonly EvidenceEntry[] } {
    this.assertActive();
    const drafts: readonly InternalEvidenceDraft[] = [primary, ...this.secondaryEvidence];
    const transactionId = `txn_${this.primarySequence.toString(36).padStart(8, "0")}`;
    const entries = drafts.map((draft, index) => {
      const explicitCause = draft.causeSequence;
      const causeSequence = index === 0 ? explicitCause : (explicitCause ?? this.primarySequence);
      return EvidenceEntrySchema.parse({
        schemaVersion: 1,
        ...removeCause(draft),
        sequence: this.primarySequence + index,
        transactionId,
        transactionIndex: index,
        transactionSize: drafts.length,
        virtualTimeUs: this.virtualTimeUs,
        ...(causeSequence === undefined ? {} : { causeSequence }),
        correlationId: this.correlationId,
      });
    });
    const insert = this.database.prepare(
      `INSERT INTO evidence
       (sequence, transaction_id, transaction_index, transaction_size, virtual_time_us, cause_sequence, correlation_id, kind, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      insert.run(
        entry.sequence,
        entry.transactionId,
        entry.transactionIndex,
        entry.transactionSize,
        entry.virtualTimeUs,
        entry.causeSequence ?? null,
        entry.correlationId,
        entry.kind,
        encodeJson(entry as JsonValue),
      );
    }
    return { value, evidence: entries };
  }

  private meta(key: string): string {
    this.assertActive();
    const row = this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) throw new Error(`world metadata ${key} is missing`);
    return row.value;
  }

  private setMeta(key: string, value: string): void {
    this.assertActive();
    const changed = this.database.prepare("UPDATE world_meta SET value = ? WHERE key = ?").run(value, key);
    if (changed.changes !== 1) throw new Error(`world metadata ${key} is missing`);
  }

  private nextRuntimeIdentity(key: string, label: string): bigint {
    this.assertActive();
    this.database.prepare("INSERT OR IGNORE INTO world_meta (key, value) VALUES (?, '0')").run(key);
    const encoded = this.meta(key);
    if (!/^(0|[1-9]\d*)$/.test(encoded)) {
      throw new Error(`world metadata ${key} is not a valid counter`);
    }
    const current = BigInt(encoded);
    if (current >= 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(`${label} identity space is exhausted`);
    }
    const next = current + 1n;
    this.setMeta(key, next.toString());
    return next;
  }

  private requireCallback(id: CallbackDeliveryId): CallbackDelivery {
    const row = this.database
      .prepare(`SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries WHERE id = ?`)
      .get(id) as CallbackRow | undefined;
    if (row === undefined) throw new Error(`callback delivery ${id} does not exist`);
    return callbackDelivery(row);
  }

  private updateCallbackStatus(
    id: CallbackDeliveryId,
    expected: CallbackDelivery["status"],
    status: CallbackDelivery["status"],
  ): void {
    const changed = this.database
      .prepare("UPDATE callback_deliveries SET status = ? WHERE id = ? AND status = ?")
      .run(status, id, expected);
    if (changed.changes !== 1) {
      throw new Error(`callback delivery ${id} did not transition from ${expected} to ${status}`);
    }
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error("world transaction is no longer active");
    }
  }
}
