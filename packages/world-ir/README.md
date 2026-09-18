# `@firedrill-run/world-ir`

Versioned, runtime-safe schemas for the canonical world intermediate representation, resolved Tool lock, and immutable build manifest.

Source paths are deliberately absent from semantic identity. The compiler records current physical paths in its compile result while the build records stable resource IDs and content hashes, so moving a source file does not create a different world.

`trajectoryHash()` captures reproducible behavior rather than per-transport or runtime identity. It excludes call/correlation identifiers, raw idempotency-key strings, and world-lifecycle plumbing such as materialization and snapshots while retaining the recorded/replayed disposition and every agent-visible outcome and effect. Evidence references are normalized after those lifecycle rows are removed, so equivalent local and hosted executions have the same trajectory identity even when their runtime setup differs. Exact evidence integrity remains covered by `evidenceHash`.
