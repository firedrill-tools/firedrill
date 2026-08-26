# @firedrill/world-store-sqlite

The native local world substrate. One logical SQLite database contains state, evidence, virtual time, deterministic random state, active faults, pending events, idempotency receipts, and lineage.

Snapshots are created with SQLite `VACUUM INTO`; copying a live WAL database file directly is not supported.

Whole-world reset replaces state, evidence history, clock, random progress, pending work, faults, and receipts from one compatible snapshot. Package-scoped reset restores selected Tool-owned state, faults, pending work, and receipts in one transaction while preserving prior evidence, global clock/random progress, actors, and unselected Tools. A reset is rejected while an affected callback delivery is in flight.

`SqliteWorldReader` opens a query-only concurrent view for local inspectors and debuggers. It can read metadata, state, faults, pending work, callbacks, and ordered evidence, but it has no transaction, reset, clock, or Tool-invocation authority.
