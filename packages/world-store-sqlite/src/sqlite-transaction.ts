import {
  ActorIdSchema,
  ActorBindingIdSchema,
  CorrelationIdSchema,
  EventRefSchema,
  EvidenceEntrySchema,
  JsonObjectSchema,
  OperationRefSchema,
  OperationOutcomeSchema,
  PackageIdSchema,
  ScheduledEventIdSchema,
  StableIdSchema,
  VirtualTimeSchema,
  canonicalJson,
} from "@firedrill/contracts";
import type {
  ActorBindingId,
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
} from "@firedrill/contracts";
import type {
  EvidenceDraft,
  IdempotencyReceipt,
  ScheduledEvent,
  StateScanOptions,
  StoredActor,
  StoredStateRecord,
  WorldTransaction,
} from "@firedrill/world-store";
import type Database from "better-sqlite3";
import { decodeObject, decodeStoredCount, encodeJson, hashJson } from "./codec.js";

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

function removeCause(draft: InternalEvidenceDraft): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...draft };
  delete copy.causeSequence;
  return copy;
}

export class SqliteWorldTransaction implements WorldTransaction {
  readonly primarySequence: number;
  private currentVirtualTimeUs: VirtualTime;
  private readonly secondaryEvidence: InternalEvidenceDraft[] = [];
  private scheduledEventCount = 0;

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
    return this.currentVirtualTimeUs;
  }

  getActor(bindingId: ActorBindingId): StoredActor | null {
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
    const owner = PackageIdSchema.parse(packageId);
    const rows = this.database
      .prepare("SELECT fault_id FROM active_faults WHERE package_id = ? ORDER BY fault_id")
      .all(owner) as Array<{ fault_id: string }>;
    return rows.map((row) => StableIdSchema.parse(row.fault_id));
  }

  getIdempotencyReceipt(invocation: OperationInvocation): IdempotencyReceipt | null {
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

  appendEvidence(draft: EvidenceDraft): void {
    this.secondaryEvidence.push(draft);
  }

  scheduleEvent(
    event: ScheduledEvent["event"],
    payload: JsonObject,
    dueUs: VirtualTime,
    actorBindingId: ActorBindingId,
  ): ScheduledEventId {
    const parsedEvent = EventRefSchema.parse(event);
    const parsedPayload = JsonObjectSchema.parse(payload);
    const parsedDue = VirtualTimeSchema.parse(dueUs);
    const parsedActorBindingId = ActorBindingIdSchema.parse(actorBindingId);
    if (parsedDue < this.virtualTimeUs) throw new RangeError("cannot schedule an event in the past");
    this.scheduledEventCount += 1;
    const id = ScheduledEventIdSchema.parse(
      `pending_${this.primarySequence.toString(36).padStart(8, "0")}_${String(this.scheduledEventCount).padStart(4, "0")}`,
    );
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
    const parsed = VirtualTimeSchema.parse(toUs);
    if (parsed < this.currentVirtualTimeUs) throw new RangeError("virtual clock cannot move backward");
    this.setMeta("virtual_time_us", String(parsed));
    this.currentVirtualTimeUs = parsed;
  }

  claimScheduledEvent(id: ScheduledEventId, status: "fired" | "failed"): ScheduledEvent {
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

  finish<T>(value: T, primary: EvidenceDraft): { value: T; evidence: readonly EvidenceEntry[] } {
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
    const row = this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) throw new Error(`world metadata ${key} is missing`);
    return row.value;
  }

  private setMeta(key: string, value: string): void {
    const changed = this.database.prepare("UPDATE world_meta SET value = ? WHERE key = ?").run(value, key);
    if (changed.changes !== 1) throw new Error(`world metadata ${key} is missing`);
  }
}
