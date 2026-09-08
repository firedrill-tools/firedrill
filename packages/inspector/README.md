# `@firedrill/inspector`

Offline local inspector for a repository-defined Firedrill world. It serves the
same authenticated loopback API as `@firedrill/simulation` and a bundled web UI
from one origin. It does not contact a hosted service or supply a customer agent;
drills still invoke the repository's declared module, command, HTTP, or
caller-owned target through the normal public runner.

Use `firedrill serve` for a live synthetic environment with connection values,
current data, and Tool activity. It requires no drill or scenario. Use
`firedrill inspect` to inspect repository source and saved drill reports without
starting a standalone environment. Embedders that own an
external agent callback can call `startLocalInspector({ root, agent })` so that
external targets remain in their process.

## Borrow an existing live environment

```ts
import { startLocalInspector } from "@firedrill/inspector";
import { createLocalWorld } from "@firedrill/sdk";

const root = process.cwd();
const world = await createLocalWorld({ root });
const binding = await world.listen(); // Select actorId explicitly when the world has several actors.
const inspector = await startLocalInspector({ root, environment: { world, binding } });
try {
  await useExistingClient({ environment: binding.environment, inspectorUrl: inspector.url });
} finally {
  await inspector.close();
  await binding.close();
  world.close();
}
```

The inspector and world must belong to the same repository. The inspector borrows
the supplied `LocalWorld` and optional `LocalWorldBinding`: closing the inspector
does not close either one. The caller must keep a supplied binding open while its
connection values are shown. There is no account, upload, remote deployment, or
ambient production fallback. Starting Tools or using **Test tool** is manual
operator activity, not a passing agent test.

Live operation contracts and current data come from the running world's immutable
build and SQLite state. Repository source views remain separate and may describe
later source edits. The live activity page reads canonical journal entries, not
an HTTP access log: operation outcomes and world changes are included;
unauthenticated requests, discovery, and health checks are not. An operation
arriving through a binding does not identify or prove the customer's agent.

### Local environment API

These additive routes use the same bearer token as the inspector UI. All require
the listener's loopback host; browser origins must match exactly. Mutation bodies
must be JSON and are capped at 64 KiB. The token is not accepted in a query string.

| Route | Result or input |
| --- | --- |
| `GET /api/environment` | `available: false`, or running metadata, description, token-free connections, and `agentTested: false` |
| `GET /api/environment/tools` | Running build's Tool operation and state contracts |
| `GET /api/environment/state` | `packageId`, `namespace`, optional `afterRowId`, `limit` (1–1,000); returns records and optional exclusive `nextRowId` |
| `GET /api/environment/activity` | Optional inclusive `fromSequence`, `limit` (1–1,000); returns journal entries and `nextSequence` |
| `POST /api/environment/call` | `{ actorId, packageId, operationId, arguments?, idempotencyKey? }`; uses canonical actor grants and labels the result `initiator: "operator"` |
| `POST /api/environment/reset` | `{ worldInstanceId, packages? }`; exact running identity required; omitted packages resets the complete world |
| `GET /api/environment/connections` | Explicit credential reveal: connection tokens and environment variables |

Live pages include a `generation` cursor epoch, also available as
`description.generation` in status. Pass `generation` with paginated reads;
a mismatch returns `409 framework.ENVIRONMENT_RESET`. Reload status and restart
pagination after a reset. Full reset restores baseline SQLite state and journal,
removing activity after baseline. Package reset retains earlier evidence and
unselected Tool state. Both advance the generation without changing listener
URLs or tokens. A reset while a control request uploads rejects that request
instead of applying it to the new generation. A relevant in-flight callback
prevents reset through the canonical SDK's safety checks.

Status never reveals connection tokens; only the explicit connections route does.
Live state, activity, and manual-call results redact conservative sensitive field
names, schema-declared write-only/password fields, and known local connection
credentials. This is presentation redaction, not a guarantee that arbitrary text
contains no secrets. Retained SQLite files and direct SDK reads are unredacted.
Keep generated `.firedrill/` files private and review content before sharing.

If a test harness writes artifacts to custom folders, pass the same `runDirectory`
and `reportDirectory` options to `startLocalInspector()`. Relative paths resolve
from `root`; defaults remain `.firedrill/runs` and `.firedrill/reports`. These are
local launch options, not paths that a browser request can change. Saved reports
remain readable when their retained SQLite files are unavailable, but state
queries then report that the world artifact is missing.

## What you are looking at

The sidebar opens on **Tools**. **Local environment** groups Tools, State &
activity, and Connect agent; **Testing** groups Drills and Results. The collapsed
**Source definitions** group contains World setup, Schema, Starting data,
Actors & permissions, and Scenarios. These are navigation groups, not separate
runtimes. Opening a source/report-only inspector does not start a live world.

- **World setup**: the environment defined by the project's source files.
- **Schema / Starting data**: declared tool record schemas and starting records. Choose a
  scenario to see its resolved starting data; this is not a running database.
  Data rows have a **View record** button pinned to the right during horizontal
  scrolling. Record IDs and cell values remain ordinary selectable text; the
  button opens the complete record in the existing full-width JSON viewer.
- **Actors & permissions**: source-defined identities, attributes and permissions.
  Customer records stay under Data; an actor is not assumed to be a human persona.
  Actors may include an optional plain-text `description` (1–500 characters).
  It appears below the identity in this page and in world/scenario setup, and is
  searchable. Omit it when unnecessary; there is no generated description or empty
  placeholder. This is documentation, not a model prompt or permission setting.
- **Scenarios**: starting situations for the agent to encounter. Each scenario
  includes its recorded **Runs**, with results and an **Open run** link to the
  exact execution in Results. History is matched to the scenario saved with the
  run, not today's drill definition. Earlier runs may use an older definition.
  Five runs appear per page; **Load older runs** searches further through saved
  project history when earlier batches have not loaded yet.
- **Tools**: choose **Behavior** for inputs, responses and declared errors,
  **Starting data** for source-defined records, **Test tool** for a manual call
  to the live environment, or **Source** for executable TypeScript/JavaScript.
  **Full contract** opens the complete compiled declaration from Behavior.
  Source opens in the main workspace, not a narrow detail panel. It starts at the actual entry module and lets you
  select imported helper files, with line numbers, syntax coloring, wrapping and copy.
  **Available interfaces** in Behavior lists MCP, HTTP API,
  Firedrill CLI and direct function. These are adapters for declared operations,
  not a single exclusive Tool type or a live-connection indicator. The target's
  bindings and actor permissions determine access. HTTP includes generic operation
  calls even without custom routes; separately displayed route counts are declared
  routes, not observed traffic. CLI means `firedrill world`, not arbitrary native
  command interception; direct function uses the supplied binding/test adapter.
- **State & activity**: **Live state** reads current records; **Activity** reads
  journaled Tool operations and world changes. Neither view substitutes source
  seed rows when no live world exists. Full reset requires typing the exact world
  identity and clearly states that post-baseline state and activity are removed.
- **Connect agent**: token-free endpoint descriptions appear first. **Reveal
  connection values** is an explicit action that exposes copyable local binding
  credentials. Connecting a client is separate from running an agent drill.
- **Drills**: read the agent's task, starting scenario and checks, then run the
  drill. Repeated workloads and task inputs come from the same source files.
  Execution limits stay under settings; raw check definitions open in a wide viewer.
- **Results**: actual attempts, checks, events and retained data after execution.
  Check values appear inline as an expected/actual diff, and recorded data changes
  show before/after together. Changed lines use minus/plus markers; check conditions
  still determine the verdict (a threshold check can pass with different values).
  Wide views align both sides; narrow views stack changed lines. Long documents
  paginate without dropping content, with a jump to the first change.
  Failed checks come first in run results; source and saved evidence order do not change.

The central static report entry is `.firedrill/reports/index.html` (or the index
inside your configured report directory). It lists saved executions; individual
reports explain task, checks, tool calls and data changes. This navigation file
is separate from immutable evidence bundles. A report opened from the inspector
embeds verified attachments so downloads also work outside the original folder.

Detail panels are closed by default. Open **Details** when you need source or
technical metadata; on Runs, selecting an event opens its details. Close the
panel to restore the full workspace width.

Actions have visible button boundaries. Clickable operation names use underlined
links, and selectable list rows have a trailing chevron. Hover and keyboard focus
identify the active control; an open Details panel or enabled Wrap lines control
keeps its selected styling. Ordinary table cells and status labels remain static.

Scenarios show their complete starting setup directly: records, failures, events
and permissions, including inherited world content. A short summary first explains
what differs from the world baseline; unchanged scenarios say so. There is no
separate setup toggle, and tables are not repeated in a second differences view.
Repository source remains available separately. The setup sections describe the
starting situation; the separate Runs section links to execution results.
Run links retain the run ID in the URL, supporting refresh and opening in a new
tab. Browser Back returns to the selected scenario. A missing or unreadable run
shows an error instead of silently opening a different result.

Long setup, drill and run pages have section shortcuts. Scrollable content has
keyboard access and a **More below** action; wide tables show **More columns**
above the table. These controls appear only for actual overflow and become return
actions at the end. Selecting a different definition resets its content position.

Content lists use shared Previous/Next controls: the Tools directory uses 12 per
page and live state/activity use 50 per page. Other source/report lists use up to
25 entries, with 10 in definition/detail lists. Controls appear only
when another page is needed. Search filters the complete loaded collection before
paging; changing a filter or definition resets its page, and refreshed shorter
lists cannot leave an empty trailing page. Check numbering continues across pages.
Retained state reads fetch the next cursor batch through the same Next control;
Previous reuses already loaded rows. Fixed navigation, metadata fields and native
select options are not paginated. Saved reports are discovered in bounded batches
of 100 directories, with **Load older runs** to continue through the full history.
Invalid reports consume a batch slot and remain visible with their verification
errors. Search and comparison selectors cover the loaded runs; the UI marks that
scope while older batches remain. Polling updates the latest batch without
discarding loaded history or re-verifying every historical report each second.

Use **View record**, **View definition**, or the input/response actions to open
structured data in a wide, line-numbered viewer. Copy and line wrapping work the
same way for data and source files. Single documents do not expand inside narrow
table cells; paired check values and recorded data changes use the inline diff.
Operation names open their contract, including declared errors, fidelity and
idempotency. The Tool's Full contract view also retains full capabilities, state,
events, faults, subscriptions, callbacks and HTTP definitions. Run details retain identifiers, seed, and execution metadata without
repeating them throughout the workspace. Reports that cannot be opened stay
listed under Runs with their verification errors; they are not silently omitted.

**Run drill** appears when the declared agent can be invoked by this inspector.
For an external target without its callback, **How to run** explains the missing
connection instead of showing a disabled Run button. Run from your existing test
script, or start the inspector with the same `agent` callback you pass to
`runDrills`. Opening saved reports alone does not connect an external agent.

The UI reads the compiled world setup, scenarios, actors and permissions, seeded
state, Tool surfaces, live or sealed causal evidence, retained world state,
active faults, pending events, and callback deliveries. It can run drills and
suites, repeat a sealed drill with the same seed, compare two verified local
reports, cancel active work, and open the self-contained HTML report. Repository
source remains authoritative and read-only in the inspector. World, scenario,
Tool, target, drill, and suite panels can open their current repository file in a
line-numbered viewer; the browser cannot request arbitrary filesystem paths.
**Current repository file** means the file on disk now, not necessarily the source
used by an older build or run. Refresh repository source to recompile current files.
Implementation is a separate, bounded source snapshot captured after compilation
at the last refresh. It reads only compiler-selected files from the repository or
the explicitly installed Tool package; it never imports code to display it. Original
source is not archived with run reports. Missing, restricted, oversized or unsafe
files have an explicit explanation, not a substitute generated implementation.
The viewer does not claim that each operation maps to a particular line or that
current source is byte-identical to the source of a historical build.
Run search covers drill, target, scenario, seed, trial, and result identity;
evidence search covers nested actor, Tool, operation, event, assertion, fault,
and payload facts. A failed assertion is the default evidence selection.

**Compare runs** opens a full-width workspace when at least two verified reports
are available. Choose a baseline and candidate; the comparison loads directly.
Checks show each run's actual values together, plus changed expectations, and tool
counts include errors even when the number of calls is unchanged. Input differences
are explicit: different drills, scenarios, targets or seeds are not a controlled
comparison. Matching world inputs do not make a live model deterministic.
Final-data hashes and mutation counts are summary evidence, not a full snapshot
diff. Missing evidence is never presented as unchanged or empty data.
