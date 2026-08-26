import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ActorBindingIdSchema,
  ActorIdSchema,
  CorrelationIdSchema,
  EvidenceEntrySchema,
  JsonObjectSchema,
  OperationRefSchema,
  PackageIdSchema,
  SeedSchema,
  Sha256Schema,
  SnapshotIdSchema,
  StableIdSchema,
  VirtualTimeSchema,
  WorldInstanceIdSchema,
  canonicalJson,
} from "@firedrill/contracts";
import type {
  CorrelationId,
  EvidenceEntry,
  JsonValue,
  PackageId,
  SnapshotId,
  StableId,
  VirtualTime,
} from "@firedrill/contracts";
import type {
  CallbackDelivery,
  CommittedWorldTransaction,
  ScheduledEvent,
  StateScanOptions,
  StoredStateRecord,
  WorldMetadata,
  WorldStore,
  WorldTransaction,
  WorldTransactionResult,
} from "@firedrill/world-store";
import Database from "better-sqlite3";
import { decodeObject, decodeStoredCount, encodeJson, hashFile, hashJson } from "./codec.js";
import { assertIntegrity, assertSupportedSchema, configureDatabase, installSchema } from "./schema.js";
import {
  CALLBACK_COLUMNS,
  SqliteWorldTransaction,
  callbackDelivery,
  scheduledEvent,
} from "./sqlite-transaction.js";
import type { CallbackRow } from "./sqlite-transaction.js";
import type { CreateSqliteWorldOptions, ForkSqliteWorldOptions } from "./types.js";

interface EvidenceRow {
  payload_json: string;
}

interface StateRow {
  package_id: string;
  namespace: string;
  row_id: string;
  value_json: string;
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

function safeRemoveDatabase(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function requireNewDestination(path: string): string {
  const destination = resolve(path);
  if (existsSync(destination) || existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) {
    throw new Error(`refusing to overwrite existing SQLite destination ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  return destination;
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class SqliteWorldStore implements WorldStore {
  readonly filePath: string;
  private database: Database.Database;
  private closed = false;

  private constructor(filePath: string, database: Database.Database) {
    this.filePath = resolve(filePath);
    this.database = database;
  }

  static create(options: CreateSqliteWorldOptions): SqliteWorldStore {
    const filePath = requireNewDestination(options.filePath);
    const worldInstanceId = WorldInstanceIdSchema.parse(options.worldInstanceId);
    const buildHash = Sha256Schema.parse(options.buildHash);
    const packageLockHash = Sha256Schema.parse(options.packageLockHash);
    const seed = SeedSchema.parse(options.seed);
    const virtualTimeUs = VirtualTimeSchema.parse(options.virtualTimeUs);
    const correlationId = CorrelationIdSchema.parse(options.correlationId);
    let database: Database.Database | undefined;
    try {
      database = new Database(filePath);
      configureDatabase(database);
      installSchema(database);
      const insertMeta = database.prepare("INSERT INTO world_meta (key, value) VALUES (?, ?)");
      const metaTransaction = database.transaction(() => {
        for (const [key, value] of [
          ["world_instance_id", worldInstanceId],
          ["build_hash", buildHash],
          ["package_lock_hash", packageLockHash],
          ["seed", seed],
          ["virtual_time_us", String(virtualTimeUs)],
          ["random_state", seed],
          ["random_draws", "0"],
        ] as const) {
          insertMeta.run(key, value);
        }
      });
      metaTransaction();
      const store = new SqliteWorldStore(filePath, database);
      store.transact(correlationId, (transaction) => {
        const insertActor = database?.prepare(
          "INSERT INTO actors (binding_id, actor_id, attributes_json, grants_json) VALUES (?, ?, ?, ?)",
        );
        if (insertActor === undefined) throw new Error("SQLite database was not initialized");
        for (const actor of options.actors ?? []) {
          const bindingId = ActorBindingIdSchema.parse(actor.bindingId);
          const actorId = ActorIdSchema.parse(actor.actorId);
          const attributes = JsonObjectSchema.parse(actor.attributes ?? {});
          const grants = actor.grants.map((grant) => OperationRefSchema.parse(grant));
          insertActor.run(bindingId, actorId, encodeJson(attributes), canonicalJson(grants));
        }
        const insertFault = database?.prepare(
          "INSERT INTO active_faults (package_id, fault_id) VALUES (?, ?)",
        );
        if (insertFault === undefined) throw new Error("SQLite database was not initialized");
        for (const fault of options.activeFaults ?? []) {
          insertFault.run(PackageIdSchema.parse(fault.packageId), StableIdSchema.parse(fault.faultId));
        }
        for (const record of options.state ?? []) {
          transaction.putState(record.packageId, record.namespace, record.rowId, record.value);
        }
        for (const event of options.scheduledEvents ?? []) {
          transaction.scheduleEvent(event.event, event.payload, event.dueUs, event.actorBindingId);
        }
        return {
          value: undefined,
          primary: {
            kind: "lifecycle",
            action: "world_created",
            worldInstanceId,
            details: {
              actorCount: options.actors?.length ?? 0,
              activeFaultCount: options.activeFaults?.length ?? 0,
              stateRecordCount: options.state?.length ?? 0,
              scheduledEventCount: options.scheduledEvents?.length ?? 0,
            },
          },
        };
      });
      return store;
    } catch (error) {
      database?.close();
      safeRemoveDatabase(filePath);
      throw error;
    }
  }

  static open(filePath: string): SqliteWorldStore {
    const resolved = resolve(filePath);
    const database = new Database(resolved, { fileMustExist: true });
    try {
      configureDatabase(database);
      assertSupportedSchema(database);
      assertIntegrity(database);
      const store = new SqliteWorldStore(resolved, database);
      store.metadata();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static forkFromSnapshot(options: ForkSqliteWorldOptions): SqliteWorldStore {
    const source = resolve(options.snapshotPath);
    const destination = requireNewDestination(options.destinationPath);
    if (source === destination) throw new Error("a fork requires a different destination file");
    const snapshotId = SnapshotIdSchema.parse(options.snapshotId);
    const childId = WorldInstanceIdSchema.parse(options.worldInstanceId);
    const correlationId = CorrelationIdSchema.parse(options.correlationId);
    copyFileSync(source, destination);
    let child: SqliteWorldStore | undefined;
    try {
      child = SqliteWorldStore.open(destination);
      const parentId = child.metadata().worldInstanceId;
      child.transact(correlationId, () => {
        child?.setMeta("parent_world_instance_id", parentId);
        child?.setMeta("parent_snapshot_id", snapshotId);
        child?.setMeta("world_instance_id", childId);
        return {
          value: undefined,
          primary: {
            kind: "lifecycle",
            action: "world_forked",
            worldInstanceId: childId,
            snapshotId,
            details: { parentWorldInstanceId: parentId },
          },
        };
      });
      return child;
    } catch (error) {
      child?.close();
      safeRemoveDatabase(destination);
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

  transact<T>(
    correlationId: CorrelationId,
    execute: (transaction: WorldTransaction) => WorldTransactionResult<T>,
  ): CommittedWorldTransaction<T> {
    this.assertOpen();
    const parsedCorrelation = CorrelationIdSchema.parse(correlationId);
    const run = this.database.transaction(() => {
      const transaction = new SqliteWorldTransaction(this.database, parsedCorrelation);
      try {
        const result = execute(transaction);
        if (
          typeof result === "object" &&
          result !== null &&
          "then" in result &&
          typeof result.then === "function"
        ) {
          throw new TypeError("world transactions must be synchronous and deterministic");
        }
        return transaction.finish(result.value, result.primary);
      } finally {
        transaction.revoke();
      }
    });
    return run.immediate();
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

  nextScheduledEvent(atOrBeforeUs?: VirtualTime): ScheduledEvent | null {
    this.assertOpen();
    const row =
      atOrBeforeUs === undefined
        ? (this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status
             FROM scheduled_events WHERE status = 'pending' ORDER BY due_us, id LIMIT 1`,
            )
            .get() as ScheduledRow | undefined)
        : (this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status
             FROM scheduled_events WHERE status = 'pending' AND due_us <= ? ORDER BY due_us, id LIMIT 1`,
            )
            .get(VirtualTimeSchema.parse(atOrBeforeUs)) as ScheduledRow | undefined);
    return row === undefined ? null : scheduledEvent(row);
  }

  listScheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[] {
    this.assertOpen();
    const rows =
      status === undefined
        ? (this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status
             FROM scheduled_events ORDER BY due_us, id`,
            )
            .all() as ScheduledRow[])
        : (this.database
            .prepare(
              `SELECT id, package_id, event_id, payload_json, due_us, correlation_id, actor_binding_id, cause_sequence, status
             FROM scheduled_events WHERE status = ? ORDER BY due_us, id`,
            )
            .all(status) as ScheduledRow[]);
    return rows.map(scheduledEvent);
  }

  nextCallbackDelivery(atOrBeforeUs?: VirtualTime): CallbackDelivery | null {
    this.assertOpen();
    const row =
      atOrBeforeUs === undefined
        ? (this.database
            .prepare(
              `SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries
               WHERE status = 'pending' ORDER BY due_us, id LIMIT 1`,
            )
            .get() as CallbackRow | undefined)
        : (this.database
            .prepare(
              `SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries
               WHERE status = 'pending' AND due_us <= ? ORDER BY due_us, id LIMIT 1`,
            )
            .get(VirtualTimeSchema.parse(atOrBeforeUs)) as CallbackRow | undefined);
    return row === undefined ? null : callbackDelivery(row);
  }

  listCallbackDeliveries(status?: CallbackDelivery["status"]): readonly CallbackDelivery[] {
    this.assertOpen();
    const rows =
      status === undefined
        ? (this.database
            .prepare(`SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries ORDER BY due_us, id`)
            .all() as CallbackRow[])
        : (this.database
            .prepare(
              `SELECT ${CALLBACK_COLUMNS} FROM callback_deliveries WHERE status = ? ORDER BY due_us, id`,
            )
            .all(status) as CallbackRow[]);
    return rows.map(callbackDelivery);
  }

  stateHash(): string {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT package_id, namespace, row_id, value_json FROM world_state ORDER BY package_id, namespace, row_id",
      )
      .all() as StateRow[];
    return hashJson(
      rows.map((row) => ({
        packageId: row.package_id,
        namespace: row.namespace,
        rowId: row.row_id,
        value: decodeObject(row.value_json),
      })),
    );
  }

  evidenceHash(): string {
    this.assertOpen();
    const values = (
      this.database.prepare("SELECT payload_json FROM evidence ORDER BY sequence").all() as EvidenceRow[]
    ).map((row) => JSON.parse(row.payload_json) as JsonValue);
    return hashJson(values);
  }

  createSnapshot(destinationPath: string, correlationId: CorrelationId): SnapshotId {
    this.assertOpen();
    const destination = requireNewDestination(destinationPath);
    if (resolve(this.filePath) === destination)
      throw new Error("snapshot destination must differ from the active database");
    const parsedCorrelation = CorrelationIdSchema.parse(correlationId);
    const snapshotId = SnapshotIdSchema.parse(`snap_${randomUUID()}`);
    try {
      this.database.pragma("wal_checkpoint(TRUNCATE)");
      this.database.exec(`VACUUM INTO ${quoteSqliteString(destination)}`);
      const snapshotDatabase = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        assertSupportedSchema(snapshotDatabase);
        assertIntegrity(snapshotDatabase);
      } finally {
        snapshotDatabase.close();
      }
      const artifactHash = hashFile(destination);
      this.transact(parsedCorrelation, (transaction) => {
        this.database
          .prepare(
            "INSERT INTO snapshots (snapshot_id, artifact_hash, created_sequence, created_virtual_time_us) VALUES (?, ?, ?, ?)",
          )
          .run(snapshotId, artifactHash, transaction.primarySequence, transaction.virtualTimeUs);
        return {
          value: undefined,
          primary: {
            kind: "lifecycle",
            action: "snapshot_created",
            worldInstanceId: this.metadata().worldInstanceId,
            snapshotId,
            details: { artifactHash },
          },
        };
      });
      return snapshotId;
    } catch (error) {
      safeRemoveDatabase(destination);
      throw error;
    }
  }

  resetFromSnapshot(sourcePath: string, correlationId: CorrelationId): void {
    this.assertOpen();
    const source = resolve(sourcePath);
    if (source === this.filePath) throw new Error("reset source must differ from the active database");
    const parsedCorrelation = CorrelationIdSchema.parse(correlationId);
    const currentMetadata = this.metadata();
    const sourceArtifactHash = hashFile(source);
    const temporary = `${this.filePath}.reset-${randomUUID()}.tmp`;
    const backup = `${this.filePath}.reset-${randomUUID()}.backup`;
    copyFileSync(source, temporary);
    let candidate: SqliteWorldStore | undefined;
    try {
      candidate = SqliteWorldStore.open(temporary);
      const candidateMetadata = candidate.metadata();
      if (candidateMetadata.buildHash !== currentMetadata.buildHash) {
        throw new Error(
          `reset snapshot build ${candidateMetadata.buildHash} does not match world build ${currentMetadata.buildHash}`,
        );
      }
      if (candidateMetadata.packageLockHash !== currentMetadata.packageLockHash) {
        throw new Error(
          `reset snapshot package lock ${candidateMetadata.packageLockHash} does not match world package lock ${currentMetadata.packageLockHash}`,
        );
      }
      candidate.transact(parsedCorrelation, () => {
        candidate?.setMeta("world_instance_id", currentMetadata.worldInstanceId);
        if (currentMetadata.parentWorldInstanceId === undefined) {
          candidate?.deleteMeta("parent_world_instance_id");
        } else {
          candidate?.setMeta("parent_world_instance_id", currentMetadata.parentWorldInstanceId);
        }
        if (currentMetadata.parentSnapshotId === undefined) {
          candidate?.deleteMeta("parent_snapshot_id");
        } else {
          candidate?.setMeta("parent_snapshot_id", currentMetadata.parentSnapshotId);
        }
        return {
          value: undefined,
          primary: {
            kind: "lifecycle",
            action: "world_reset",
            worldInstanceId: currentMetadata.worldInstanceId,
            details: { sourceArtifactHash },
          },
        };
      });
      candidate.close();
      candidate = undefined;

      this.database.pragma("wal_checkpoint(TRUNCATE)");
      this.database.close();
      this.closed = true;
      rmSync(`${this.filePath}-wal`, { force: true });
      rmSync(`${this.filePath}-shm`, { force: true });
      copyFileSync(this.filePath, backup);
      renameSync(temporary, this.filePath);
      this.database = new Database(this.filePath, { fileMustExist: true });
      configureDatabase(this.database);
      assertSupportedSchema(this.database);
      assertIntegrity(this.database);
      this.closed = false;
      safeRemoveDatabase(backup);
    } catch (error) {
      candidate?.close();
      if (this.closed) {
        try {
          try {
            this.database.close();
          } catch {
            // The previous handle may already be closed; recovery below opens a verified replacement.
          }
          if (existsSync(backup)) {
            safeRemoveDatabase(this.filePath);
            renameSync(backup, this.filePath);
          }
          this.database = new Database(this.filePath, { fileMustExist: true });
          configureDatabase(this.database);
          assertSupportedSchema(this.database);
          assertIntegrity(this.database);
          this.closed = false;
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "reset failed and the previous world could not be reopened",
          );
        }
      }
      throw error;
    } finally {
      safeRemoveDatabase(temporary);
      if (!this.closed) safeRemoveDatabase(backup);
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.close();
    this.closed = true;
  }

  private meta(key: string): string {
    this.assertOpen();
    const row = this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) throw new Error(`world metadata ${key} is missing`);
    return row.value;
  }

  private optionalMeta(key: string): string | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT INTO world_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private deleteMeta(key: string): void {
    this.assertOpen();
    this.database.prepare("DELETE FROM world_meta WHERE key = ?").run(key);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite world store is closed");
  }
}
