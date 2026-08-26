import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function configureDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
}

export function installSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true });
  if (version !== 0) throw new Error(`refusing to initialize SQLite schema at version ${String(version)}`);

  database.exec(`
    CREATE TABLE world_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE actors (
      binding_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      grants_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE world_state (
      package_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      row_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (package_id, namespace, row_id)
    ) STRICT;

    CREATE TABLE active_faults (
      package_id TEXT NOT NULL,
      fault_id TEXT NOT NULL,
      PRIMARY KEY (package_id, fault_id)
    ) STRICT;

    CREATE TABLE evidence (
      sequence INTEGER PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      transaction_index INTEGER NOT NULL,
      transaction_size INTEGER NOT NULL,
      virtual_time_us INTEGER NOT NULL,
      cause_sequence INTEGER,
      correlation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      CHECK (sequence > 0),
      CHECK (transaction_index >= 0 AND transaction_index < transaction_size),
      CHECK (cause_sequence IS NULL OR cause_sequence < sequence)
    ) STRICT;

    CREATE INDEX evidence_correlation_idx ON evidence (correlation_id, sequence);
    CREATE INDEX evidence_kind_idx ON evidence (kind, sequence);

    CREATE TABLE scheduled_events (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      due_us INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      actor_binding_id TEXT NOT NULL,
      cause_sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'failed', 'cancelled')),
      CHECK (due_us >= 0),
      CHECK (cause_sequence > 0)
    ) STRICT;

    CREATE INDEX scheduled_due_idx ON scheduled_events (status, due_us, id);

    CREATE TABLE callback_deliveries (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      callback_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      event_package_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      due_us INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      actor_binding_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_delays_json TEXT NOT NULL,
      CHECK (event_sequence > 0),
      CHECK (due_us >= 0),
      CHECK (attempt_count >= 0 AND attempt_count <= 10)
    ) STRICT;

    CREATE INDEX callback_due_idx ON callback_deliveries (status, due_us, id);

    CREATE TABLE idempotency_receipts (
      package_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      actor_binding_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      PRIMARY KEY (package_id, operation_id, actor_binding_id, idempotency_key),
      CHECK (first_sequence > 0)
    ) STRICT;

    CREATE TABLE snapshots (
      snapshot_id TEXT PRIMARY KEY,
      artifact_hash TEXT NOT NULL,
      created_sequence INTEGER NOT NULL,
      created_virtual_time_us INTEGER NOT NULL,
      CHECK (created_sequence > 0),
      CHECK (created_virtual_time_us >= 0)
    ) STRICT;

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function assertSupportedSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true });
  if (version !== SCHEMA_VERSION) {
    throw new Error(`unsupported Firedrill SQLite schema version ${String(version)}`);
  }
}

export function assertIntegrity(database: Database.Database): void {
  const result = database.pragma("integrity_check", { simple: true });
  if (result !== "ok") throw new Error(`SQLite integrity check failed: ${String(result)}`);
}
