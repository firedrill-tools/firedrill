# @firedrill-run/world-store

Storage port used by the generic world kernel. Mutations, semantic evidence, virtual time, randomness, and pending events share one transaction boundary.

The SQLite adapter is the first implementation. This package deliberately contains no hosted session, tenancy, or cloud-storage contract.
