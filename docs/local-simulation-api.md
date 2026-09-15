# Local simulation API

`@firedrill/simulation` is the adapter for a local visual inspector or another read-mostly client. It compiles the repository, delegates execution to the public `runDrills()` API, and exposes a small versioned HTTP surface on loopback. The drill runner and SQLite world remain the canonical implementations; this package does not duplicate their semantics.

```ts
import { startLocalSimulationServer } from "@firedrill/simulation";

const server = await startLocalSimulationServer({ root: process.cwd() });

console.log(server.baseUrl, server.token);
// await server.close();
```

Every project, run, state, evidence, and control request requires `Authorization: Bearer <token>`. The generated token is returned only to the caller that starts the server. The server accepts loopback hosts and origins only, has no CORS allowance, never exposes raw SQL or arbitrary filesystem reads, and rejects oversized or unknown input.

## What a client can do

- Read the compiled World, Tools, targets, drills, suites, diagnostics, and repository-relative source provenance. Tool views include the complete compiled manifest and references to captured implementation files, without inferring extra fields, relationships, or operation-to-function mappings.
- Start one drill or a named suite with optional seed, trial, retry, and concurrency overrides.
- Follow a run request until its real drill-run IDs exist, then inspect those runs while the agent is still acting.
- Page the ordered evidence journal and current synthetic Tool state.
- Inspect active faults, scheduled events, callback deliveries, final assertions, and retained report availability.
- Compare two verified sealed runs. The response removes local filesystem paths, grades input compatibility, and reports factual deltas without inferring improvement or regression.
- Cancel active work and refresh repository source once no drill is running.

The fixed routes are rooted at `/api/v1`: `project`, `runs`, `run-requests`, and `comparisons`, with bounded child routes for evidence and state. A run request is transport-level correlation only: one request can create several real drill runs when trials or retries are enabled. Product evidence and reports always use the real run IDs.

An `external` target is available only when the embedding application supplies its agent callback to `startLocalSimulationServer()`. Module, command, and HTTP targets continue to use their declared target adapters even when an external callback is present.

## Tool implementation source

`GET /api/v1/tools/:toolId/implementation/:fileId` reads one compiler-selected
implementation file. Get opaque file IDs from `project.tools[].implementation.files`;
the request never accepts a path. Both repository Tools and explicitly installed
packages expose source when available. `definition` is the full compiled Tool
manifest, separate from executable behavior. The compiler's actual entry module
is marked `role: entry`; imported files are helpers.

Source documents are captured in memory after compilation at project load/refresh,
not read afresh on each browser request or persisted with reports. `contentHash`
hashes the exact captured UTF-8 bytes; `buildHash` and `artifactHash` identify the
associated compilation, not proof that later-captured source bytes reconstruct its
bundle. Builds retain executable bundles, not original TypeScript. Refresh after
editing source. Each file is limited to 1 MiB, with a 16 MiB total snapshot budget.
Missing sources, unsupported file types, restricted paths, symlinks below a declared
root, changed package identity, invalid text and budget limits are reported explicitly.
Inspection does not execute source. As with any source viewer, ordinary code can
contain embedded secrets; this is local inspection, not automatically redacted output.

## Saved-run pagination

`GET /api/v1/runs?limit=100&cursor=<nextCursor>` returns a bounded saved-report
page. `limit` accepts 1–500 (default 100); omit `cursor` for the latest page. Follow
the optional `nextCursor` until it is absent. Invalid reports are returned under
`unavailable` and consume slots so pagination advances even through unreadable
history. Ordering uses report-directory modification time, then run ID.

Active attempts appear on every page, outside the saved-report limit. Merge by
run ID and prefer newer responses when polling; do not append duplicate active
runs. The cursor is opaque and bound to the configured report directory. It
survives source refresh and deletion of its anchor directory. Poll only the newest
page and load older pages on demand; search over accumulated client pages must
be labeled as loaded-history search until all saved reports have been loaded.

## Report files

All report routes require the same bearer header; a token is never placed in a report URL.

| Route | Response |
| --- | --- |
| `GET /api/v1/runs/:runId/report` | Verified HTML report. |
| `GET /api/v1/runs/:runId/report/attachments` | Verified attachment descriptors, including IDs, portable relative paths, declared media types, byte lengths, and hashes. |
| `GET /api/v1/runs/:runId/report/attachments/:attachmentId` | The verified attachment's bytes, served as an inert download. |

Attachment requests select a descriptor ID, not a filesystem path. Unknown IDs are rejected, and changed or invalid bundles are not served. Downloads use `application/octet-stream`, `Content-Disposition: attachment`, and `nosniff`; the original declared media type remains in the descriptor. The inspector embeds these verified bytes into the report it opens or downloads so links do not depend on the inspector's authentication or local attachment paths.

## Artifact semantics

Each trial and retry has its own retained SQLite world beneath `.firedrill/runs/`. That database contains the synthetic Tool state, clock, faults, pending work, and ordered evidence for that run; it is not the customer's application database. Completed portable reports remain under `.firedrill/reports/` in terminal, JSON, JUnit, and self-contained HTML formats.

`startLocalSimulationServer()` and `startLocalInspector()` accept `runDirectory`
and `reportDirectory` launch options for artifacts written to custom locations.
They resolve relative to the repository root, matching `runDrills()`. The HTTP API
cannot choose or override those directories.

State reads show the current retained world. Historical before/after values are carried by `state_change` evidence entries, so a client can explain a consequence without inventing a replay or time-travel claim.

Project setup is different from retained run state: each compiled scenario already includes the world's baseline followed by its own ordered patches. Apply these once in order, using Tool, namespace, and record ID together as identity. An upsert replaces the entire record; a delete removes it. These are starting records, not the outcome of a past run.

Generated `.firedrill/` artifacts may contain complete synthetic records and agent output. Keep the directory out of version control.
