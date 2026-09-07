# `@firedrill/inspector`

Offline local inspector for a repository-defined Firedrill world. It serves the
same authenticated loopback API as `@firedrill/simulation` and a bundled web UI
from one origin. It does not contact a hosted service or supply a customer agent;
drills still invoke the repository's declared module, command, HTTP, or
caller-owned target through the normal public runner.

Use `firedrill inspect` for the normal CLI experience. Embedders that own an
external agent callback can call `startLocalInspector({ root, agent })` so that
external targets remain in their process.

If a test harness writes artifacts to custom folders, pass the same `runDirectory`
and `reportDirectory` options to `startLocalInspector()`. Relative paths resolve
from `root`; defaults remain `.firedrill/runs` and `.firedrill/reports`. These are
local launch options, not paths that a browser request can change. Saved reports
remain readable when their retained SQLite files are unavailable, but state
queries then report that the world artifact is missing.

## What you are looking at

The sidebar groups the environment under **World** (Synthetic world, Schema,
Data, Tools, Personas & actors), and the test workflow under **Testing**
(Scenarios, Drills, Runs). These are navigation groups, not separate runtimes.

- **Synthetic world**: the environment defined by the project's source files.
- **Schema / Data**: declared tool record schemas and starting records. Choose a
  scenario to see its resolved starting data; this is not a running database.
- **Personas & actors**: source-defined identities, attributes and permissions.
  Customer records stay under Data; an actor is not assumed to be a human persona.
  Actors may include an optional plain-text `description` (1–500 characters).
  It appears below the identity in this page and in world/scenario setup, and is
  searchable. Omit it when unnecessary; there is no generated description or empty
  placeholder. This is documentation, not a model prompt or permission setting.
- **Scenarios**: starting situations for the agent to encounter.
- **Tools**: choose **Operations** for inputs, responses and declared errors,
  **Implementation** for the executable TypeScript/JavaScript, or **Declaration**
  for the complete compiled contract. Implementation opens in the main workspace,
  not a narrow detail panel. It starts at the actual entry module and lets you
  select imported helper files, with line numbers, syntax coloring, wrapping and copy.
  **Available interfaces** stays visible in every Tool view: MCP, HTTP API,
  Firedrill CLI and direct function. These are adapters for declared operations,
  not a single exclusive Tool type or a live-connection indicator. The target's
  bindings and actor permissions determine access. HTTP includes generic operation
  calls even without custom routes; separately displayed route counts are declared
  routes, not observed traffic. CLI means `firedrill world`, not arbitrary native
  command interception; direct function uses the supplied binding/test adapter.
- **Drills**: read the agent's task, starting scenario and checks, then run the
  drill. Repeated workloads and task inputs come from the same source files.
  Execution limits stay under settings; raw check definitions open in a wide viewer.
- **Runs**: actual attempts, checks, events and retained data after execution.
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
Repository source remains available separately. These views describe setup, not
the agent's execution results.

Long setup, drill and run pages have section shortcuts. Scrollable content has
keyboard access and a **More below** action; wide tables show **More columns**
above the table. These controls appear only for actual overflow and become return
actions at the end. Selecting a different definition resets its content position.

Content lists use shared Previous/Next controls: up to 25 entries in navigation,
catalogs and activity, and 10 in definition/detail lists. Controls appear only
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
idempotency. The Tool's Declaration view also retains full capabilities, state,
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
