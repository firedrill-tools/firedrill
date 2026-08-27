# `@firedrill/inspector`

Offline local inspector for a repository-defined Firedrill world. It serves the
same authenticated loopback API as `@firedrill/simulation` and a bundled web UI
from one origin. It does not contact a hosted service or supply a customer agent;
drills still invoke the repository's declared module, command, HTTP, or
caller-owned target through the normal public runner.

Use `firedrill inspect` for the normal CLI experience. Embedders that own an
external agent callback can call `startLocalInspector({ root, agent })` so that
external targets remain in their process.

The UI reads the compiled world setup, scenarios, actors and permissions, seeded
state, Tool surfaces, live or sealed causal evidence, retained world state,
active faults, pending events, and callback deliveries. It can run drills and
suites, repeat a sealed drill with the same seed, compare two verified local
reports, cancel active work, and open the self-contained HTML report. Repository
source remains authoritative and read-only in the inspector. World, scenario,
Tool, drill, and suite panels can open their current repository file in a
line-numbered viewer; the browser cannot request arbitrary filesystem paths.
