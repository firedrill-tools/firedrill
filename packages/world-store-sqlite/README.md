# @firedrill/world-store-sqlite

The native local world substrate. One logical SQLite database contains state, evidence, virtual time, deterministic random state, active faults, pending events, idempotency receipts, and lineage.

Snapshots are created with SQLite `VACUUM INTO`; copying a live WAL database file directly is not supported.
