import { resolve } from "node:path";
import {
  EvidenceEntrySchema,
  PackageIdSchema,
  SeedSchema,
  Sha256Schema,
  SnapshotIdSchema,
  StableIdSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
} from "@firedrill/contracts";
import type { EvidenceEntry, PackageId, StableId } from "@firedrill/contracts";
import type {
  ActiveFault,
  CallbackDelivery,
  ScheduledEvent,
  StateNamespaceSummary,
  StateScanOptions,
  StoredStateRecord,
  WorldMetadata,
  WorldReader,
} from "@firedrill/world-store";
import Database from "better-sqlite3";
import { decodeObject, decodeStoredCount } from "./codec.js";
import { latestEvidenceSequence } from "./evidence-head.js";
import { assertSupportedSchema } from "./schema.js";
import { CALLBACK_COLUMNS, callbackDelivery, scheduledEvent } from "./sqlite-transaction.js";
import type { CallbackRow } from "./sqlite-transaction.js";

interface EvidenceRow {
  payload_json: string;
}

interface StateRow {
  package_id: string;
  namespace: string;
  row_id: string;
  value_json: string;
}

interface FaultRow {
  package_id: string;
  fault_id: string;
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

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("limit must be an integer from 1 through 10000");
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

/**
 * Opens a query-only view of a live or sealed Firedrill world.
 * It cannot transact, reset, advance time, or invoke Tool behavior.
 */
export class SqliteWorldReader implements WorldReader {
  readonly filePath: string;
  private readonly database: Database.Database;
  private closed = false;

  private constructor(filePath: string, database: Database.Database) {
    this.filePath = resolve(filePath);
    this.database = database;
  }

  static open(filePath: string): SqliteWorldReader {
    const resolved = resolve(filePath);
    const database = new Database(resolved, { readonly: true, fileMustExist: true });
    try {
      database.pragma("query_only = ON");
      database.pragma("busy_timeout = 5000");
      assertSupportedSchema(database);
      const reader = new SqliteWorldReader(resolved, database);
      reader.metadata();
      return reader;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  metadata(): WorldMetadata {
    this.assertOpen();
    const parentWorldInstanceId = this.optionalMeta("parent_world_instance_id");
    const parentSnapshotId = this.optionalMeta("parent_snapshot_id");
    return {
      schemaVersion: 1,
      worldInstanceId: WorldInstanceIdSchema.parse(this.meta("world_instance_id")),
      buildHash: Sha256Schema.parse(this.meta("build_hash")),
      packageLockHash: Sha256Schema.parse(this.meta("package_lock_hash")),
      seed: SeedSchema.parse(this.meta("seed")),
      virtualTimeUs: VirtualTimeSchema.parse(Number(this.meta("virtual_time_us"))),
      randomState: SeedSchema.parse(this.meta("random_state")),
      randomDraws: decodeStoredCount(this.meta("random_draws"), "random draw count"),
      ...(parentWorldInstanceId === undefined
        ? {}
        : { parentWorldInstanceId: WorldInstanceIdSchema.parse(parentWorldInstanceId) }),
      ...(parentSnapshotId === undefined
        ? {}
        : { parentSnapshotId: SnapshotIdSchema.parse(parentSnapshotId) }),
    };
  }

  listActiveFaults(packageId?: PackageId): readonly ActiveFault[] {
    this.assertOpen();
    const rows =
      packageId === undefined
        ? (this.database
            .prepare("SELECT package_id, fault_id FROM active_faults ORDER BY package_id, fault_id")
            .all() as FaultRow[])
        : (this.database
            .prepare("SELECT package_id, fault_id FROM active_faults WHERE package_id = ? ORDER BY fault_id")
            .all(PackageIdSchema.parse(packageId)) as FaultRow[]);
    return rows.map((row) => ({
      packageId: PackageIdSchema.parse(row.package_id),
      faultId: StableIdSchema.parse(row.fault_id),
    }));
  }

  readState(packageId: PackageId, namespace: StableId, rowId: string): StoredStateRecord | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        "SELECT package_id, namespace, row_id, value_json FROM world_state WHERE package_id = ? AND namespace = ? AND row_id = ?",
      )
      .get(PackageIdSchema.parse(packageId), StableIdSchema.parse(namespace), rowId) as StateRow | undefined;
    return row === undefined ? null : stateRecord(row);
  }

  listStateNamespaces(): readonly StateNamespaceSummary[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT package_id, namespace, COUNT(*) AS records FROM world_state GROUP BY package_id, namespace ORDER BY package_id, namespace",
      )
      .all() as Array<{ package_id: string; namespace: string; records: number }>;
    return rows.map((row) => ({
      packageId: PackageIdSchema.parse(row.package_id),
      namespace: StableIdSchema.parse(row.namespace),
      records: decodeStoredCount(String(row.records), "state record count"),
    }));
  }

  scanState(
    packageId: PackageId,
    namespace: StableId,
    options: StateScanOptions = {},
  ): readonly StoredStateRecord[] {
    this.assertOpen();
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

  readEvidence(fromSequence = 1, limit = 1_000): readonly EvidenceEntry[] {
    this.assertOpen();
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 1) {
      throw new RangeError("evidence sequence must be a positive integer");
    }
    const parsedLimit = normalizeLimit(limit);
    const rows = this.database
      .prepare("SELECT payload_json FROM evidence WHERE sequence >= ? ORDER BY sequence LIMIT ?")
      .all(fromSequence, parsedLimit) as EvidenceRow[];
    return rows.map((row) => EvidenceEntrySchema.parse(JSON.parse(row.payload_json)));
  }

  latestEvidenceSequence(kinds?: readonly EvidenceEntry["kind"][]): number {
    this.assertOpen();
    return latestEvidenceSequence(this.database, kinds);
  }

  listScheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[] {
    this.assertOpen();
    const rows = (
      status === undefined
        ? this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id,
                    actor_binding_id, cause_sequence, status
             FROM scheduled_events ORDER BY due_us, id`,
            )
            .all()
        : this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id,
                    actor_binding_id, cause_sequence, status
             FROM scheduled_events WHERE status = ? ORDER BY due_us, id`,
            )
            .all(status)
    ) as ScheduledRow[];
    return rows.map(scheduledEvent);
  }

  listCallbackDeliveries(status?: CallbackDelivery["status"]): readonly CallbackDelivery[] {
    this.assertOpen();
    const rows = (
      status === undefined
        ? this.database
            .prepare(`SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries ORDER BY due_us, id`)
            .all()
        : this.database
            .prepare(
              `SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries WHERE status = ? ORDER BY due_us, id`,
            )
            .all(status)
    ) as CallbackRow[];
    return rows.map(callbackDelivery);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private meta(key: string): string {
    const row = this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) throw new Error(`world metadata ${key} is missing`);
    return row.value;
  }

  private optionalMeta(key: string): string | undefined {
    return (
      this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite world reader is closed");
  }
}
