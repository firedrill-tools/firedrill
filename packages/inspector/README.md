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

- **Synthetic world**: the environment defined by the project's source files.
- **Schema / Data**: declared tool record schemas and starting records. Choose a
  scenario to see its resolved starting data; this is not a running database.
- **Personas & actors**: source-defined identities, attributes and permissions.
  Customer records stay under Data; an actor is not assumed to be a human persona.
- **Scenarios / Tools**: starting situations and the synthetic service contracts,
  including operation input and response schemas.
- **Drills**: tasks and expectations you can run against an agent.
- **Runs**: actual attempts, checks, events and retained data after execution.

The central static report entry is `.firedrill/reports/index.html` (or the index
inside your configured report directory). It lists saved executions; individual
reports explain task, checks, tool calls and data changes. This navigation file
is separate from immutable evidence bundles. A report opened from the inspector
embeds verified attachments so downloads also work outside the original folder.

The UI reads the compiled world setup, scenarios, actors and permissions, seeded
state, Tool surfaces, live or sealed causal evidence, retained world state,
active faults, pending events, and callback deliveries. It can run drills and
suites, repeat a sealed drill with the same seed, compare two verified local
reports, cancel active work, and open the self-contained HTML report. Repository
source remains authoritative and read-only in the inspector. World, scenario,
Tool, target, drill, and suite panels can open their current repository file in a
line-numbered viewer; the browser cannot request arbitrary filesystem paths.
Run search covers drill, target, scenario, seed, trial, and result identity;
evidence search covers nested actor, Tool, operation, event, assertion, fault,
and payload facts. A failed assertion is the default evidence selection.
