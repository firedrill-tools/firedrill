# Python local capability review

This checklist compares the Python distribution with the public, local
TypeScript SDK and CLI. It is not a list of Python rewrites of internal kernel
packages. Both distributions execute the same compiler, world runtime,
assertions, protocol implementations, and report generator.

An API appearing in this table is not by itself an execution or release claim.
The execution record below distinguishes source/package checks from installed
wheel and cross-platform verification. The final release must pass the Python
package workflow and the ordinary repository checks.

## Public surfaces

| Capability | TypeScript entry point | Python entry point | Verification scope |
| --- | --- | --- | --- |
| Local CLI | `@firedrill-run/cli` | `firedrill`, `python -m firedrill` | Install wheel into a clean Python environment without Node/npm on PATH; initialize, validate, run, inspect |
| World lifecycle | `createLocalWorld` | `World.from_project`, `create_world`, `AsyncWorld.from_project`, `create_world_async` | Create and close real SQLite worlds; retain generated files |
| Descriptions and live state | `describe`, `metadata`, `state`, `evidence` | Matching world methods | Read build/contracts, seeded rows, and ordered evidence |
| Tool operations | `world.call` | `world.call`, async equivalent | Execute repository behavior with actor grants and record state changes |
| Tool protocols and apps | `world.listen` | `world.listen`, `binding.environment`, `binding.apps` | Real authenticated HTTP/MCP/CLI listeners and package app routes |
| Inspector | `startLocalInspector` | `world.inspect`, `start_inspector`, async equivalents | Start bundled UI; verify it reads the selected project/world |
| Faults, scheduled events, callbacks | World control methods | Matching world methods | Read actual runtime queues and toggle declared faults |
| Virtual time | `advanceTime` | `advance_time` | Advance the same clock and execute due events |
| Full and scoped reset | `reset` | `reset`, `reset(packages=[...])` | Full baseline restoration; selected-tool restoration with surviving bindings |
| Reusable scenario data | `exportScenario`, `saveScenario` | `export_scenario`, `save_scenario` | Export exact tool state and safely write new source |
| Drill runner | `runDrills` | `run_drills`, `run_drills_async` | Passing and failing real drills, all report formats, stable build/seed |
| Python agent callback | `agent` callback | Sync or async `agent` callback | Python agent calls world tools through invocation-scoped bindings |
| Selection and execution options | `suite`, `tags`, `filter`, `shard`, `trials`, `retries`, `concurrency` | Same options | Preserve selection, repeats, retries, and isolated trials |
| Setup overrides | `setup` | `setup` | Test-owned starting data, faults, operation overrides, behavior modules, binding aliases |
| Hooks | `RunDrillsHooks` | Snake_case `hooks` callbacks | All suite, drill, trial, and attempt lifecycle hooks |
| Test-side function mocks | `sdk/testing` `mockTool` | `mock_tool` | `unittest.mock` sync and async dependencies; evidence and native errors preserved |
| File capture | `attach`, `capture` | Callback `attach`, `capture` | Logs, screenshots, videos, files, automatic driver cleanup, failure-only retention |
| Verification and comparisons | `verifyReport`, `compareRuns`, `compareRunDetails` | `verify_report`, `compare_runs`, `compare_run_details` | Tamper rejection and bounded recorded differences |
| Tool inspection/conformance | `inspectTool`, `validateTool`, `testTool` | `inspect_tool`, `validate_tool`, `test_tool` | Real manifest/behavior checks and ordinary conformance drills |
| Tool contribution | `prepareToolContribution` | `prepare_tool_contribution` | Same explicit attestations, conformance, local review bundle |
| Data import | Preview/save/store/load helpers | Corresponding snake_case helpers | Review-before-write import semantics and original key preservation |
| Browser definitions | Browser load/save/list/replay helpers | `firedrill.browser` | Same source validation, safe writes, pagination, recorded replay |
| Browser execution | `runBrowserTest` | `run_browser_test`, async equivalent | Real Playwright browser steps/assertions, Python drivers, captures, events, cancellation |
| Browser report export | Verify/bundle helpers | `verify_browser_test_report`, `bundle_browser_test_report` | Verify actual artifact bytes and export a usable archive |
| Optional authoring/browser agent | `@firedrill-run/agent` | `firedrill-run[agent]` and CLI | Bundled optional agent runtime; explicit model invocation and caller API key |
| pytest integration | Uses caller's JS test runner | `firedrill`, `firedrill_world`, `firedrill_binding` fixtures | Per-test lifecycle, markers, failure reporting, cleanup |

## Shared behavior and boundaries

- Python's option envelopes accept snake_case. Authored JSON/YAML schemas,
  operation arguments, record fields, and environment variables retain their
  exact keys. Results are mappings with snake_case attribute aliases.
- Every drill uses the canonical assertion evaluator. An agent's self-reported
  success and a browser screenshot do not replace state/operation assertions.
- Every trial has its own synthetic world. Test-side bindings cannot reset the
  owner's world or retain mutation authority after the invocation ends.
- Sync and asyncio Python callbacks are supported. Cancellation revokes world
  access; caller-owned synchronous code must cooperate with its cancellation
  signal if it does work outside Firedrill.
- A command target reads an invocation from stdin and may write one JSON result
  to stdout. An arbitrary Python script is not automatically a target: adapt its
  input/output in test code, or call the agent through the Python SDK callback.
- Fake tools are distributed once in the shared package format. Python consumes
  those tools through protocol bindings or test-side function mocks. Tool
  implementation modules remain JavaScript/TypeScript; the Python wheel does
  not introduce a second Tool behavior language.
- The inspector and local reports use the same UI and data as the npm
  distribution. Python runs do not require an account or the cloud Python SDK.
- Optional browser binaries are installed explicitly. Model-driven authoring or
  browser execution requires the agent extra and a model credential.
- Raw kernel/store classes and custom runtime ownership internals are not
  mirrored as Python objects. Public world controls, test operations, authoring,
  reports, and browser interfaces are the compatibility boundary.

## Release evidence

An independent review on macOS arm64 with Python 3.11 executed the public Python
source API against the staged bundled runtime:

- Template CLI initialization and a passing recorded drill.
- Sync/async world lifecycle, seeded state reads, real operation mutations,
  scenario export/save, HTTP/MCP listeners, and a responding inspector.
- Full and selected-tool reset in the starter world.
- Sync/async Python agent callbacks, test-side function mocking, lifecycle
  callbacks, logs/screenshot capture, and report verification/comparison.
- A real Chromium flow with assertions and three retained artifacts: screenshot,
  video, and trace. Its report archive contained the HTML entry point and was
  readable as a tar archive. Definition replay/save/reload, source listing, and
  report-history listing also executed.
- Runtime EOF and malformed protocol responses returned structured errors
  promptly instead of hanging the caller.

The final macOS arm64 wheel also passed
`python/packaging/verify_wheel.py <wheel> --agent --sdk-tests python/tests` in a clean
Python environment with external Node.js, npm, and pnpm absent from `PATH`.
That check installed the wheel, ran CLI initialization and passing/failing
drills, verified reports and tamper detection, installed and tested an
independent tool package, served the bundled inspector, verified the optional
agent executable and SDK process startup, and passed all 26 Python tests.
This is local wheel evidence for macOS arm64. Cross-platform CI and live
model-backed authoring were not verified by these checks.

The release checks must distinguish source presence from installed behavior:

1. Build platform wheels with pinned runtime/dependency versions and valid
   package metadata; install them without consulting a framework checkout.
2. Run the starter CLI loop with Node/npm absent from the caller's PATH.
3. Exercise sync and async callbacks, function mocks, pytest fixtures, real
   protocol listeners, reset, captures, reports, and inspector through the
   installed Python package.
4. Exercise a real browser test and its report archive; verify a failed check
   remains failed and a tampered report is rejected.
5. Check callback exceptions, runtime EOF, cancellation, expired binding
   access, and cleanup so failed tests do not leave active world listeners.
6. Run the platform matrix before treating an unexecuted operating-system wheel
   as supported. A local wheel test proves only that host platform.

Publication of wheels is a separate state from successful local verification.
Do not describe a package or version as available on PyPI until its registry
release and a clean installation have been checked.
