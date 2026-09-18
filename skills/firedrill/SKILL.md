---
name: firedrill
description: Set up or edit Firedrill synthetic tools and data for an existing agent, or author and debug repeatable agent drills. Inspect real interfaces, preserve production logic, validate repo-owned source and use local backend or test workflows according to the user's task.
---

# Create synthetic tools and run agent drills

Give the existing AI agent controlled tools and data. Keep the agent process customer-owned and its production logic unchanged. Match the user's task: they may want only a synthetic backend, or a repeatable drill that checks their agent's actions. A backend does not require a target, task, or assertions. Read [references/backend.md](references/backend.md) for tool-first setup; use the drill workflow below when the request includes testing an agent.

For a fresh setup, prefer tools → starting data/behavior → local startup → existing
agent connection. Do not make users choose frameworks, scenarios and tests before
they can try a useful tool. Existing detected dependencies are hints, not proof
of an agent's interface. Inspect actual inputs, responses and side effects.

## Definition of done

Common authoring checks:

- `firedrill.json` and repository-owned world source exist.
- `firedrill format --check --json` reports no pending source changes.
- `firedrill validate --json` returns success with no error diagnostics.
- At least one real Tool operation is supplied by an approved selected package or repository-owned deterministic behavior.
- Keep `firedrill.json` and `firedrill/` in version control; keep generated `.firedrill/` state and reports ignored.
- Report the files, verified commands, implemented behavior, connection instructions, and remaining limitations.

For a **synthetic backend** request, validate the source and exercise an actual operation when execution is authorized and available. A running listener is not proof of correct tool behavior. Verify state changes, declared errors, and reset using the public SDK when those capabilities are requested. If your tools cannot launch or call the backend, report source validation and exact handoff commands; do not fabricate runtime proof. Do not invent a drill just to satisfy this skill.

For a **drill/testing** request, also verify:

- The existing agent is externally bound at one declared target/binding seam without Firedrill logic inside its production behavior.
- The agent's ordinary non-Firedrill entry point keeps its existing input, output, logging, and failure contract.
- At least one representative drill passes.
- A deliberately broken expectation produces exit code `1` and a verified local HTML report, then the source is restored.
- The passing drill is rerun after restoration.
- Every newly authored reusable Tool passes `firedrill tool test <tool-id> --json` through an ordinary conformance suite.
- Report the selected target/binding and pass/fail evidence paths. Backend behavior alone is not evidence that the real agent was tested.

## Drill workflow

Treat “one shot” as this verified loop, not one blind generation pass.

### 1. Scout the repository

Find the agent entry point, its tool registry/client composition point, current tests, fixtures, mocks, MCP configuration, API clients, CLI adapters, and process start command. Identify an existing configurable or interceptable seam where a test harness can replace real dependencies without editing production agent behavior. Before editing, run or inspect the ordinary entry point and record its observable contract: accepted input, returned value or stdout, log destination, exit/error behavior, and provider configuration. Recheck that contract after integration; do not declare compatibility from a newly invented smoke path. If no such seam exists, report the limitation and the smallest test-only adapter that would be required. Do not silently add production branches or monkey-patch a hidden dependency.

Do not assume an agent framework, protocol, vendor, or domain. A Tool represents any capability the agent can invoke; it may be reached by MCP, HTTP, a CLI adapter, an SDK, or an in-process function.

### 2. Choose the target and binding

Select the target that matches how the agent already runs:

- `command`: start an existing CLI, worker, or app process; use HTTP, MCP, or CLI bindings.
- `module`: call a repository module; use direct, HTTP, MCP, or CLI bindings.
- `http`: invoke an already-running loopback endpoint; use HTTP, MCP, or CLI world bindings.
- `external`: let the caller's test code invoke the agent through `runDrills()`; use direct, HTTP, MCP, or CLI bindings.

Read [references/bindings.md](references/bindings.md) before wiring the seam. Never give an out-of-process target a direct binding. Never point a local HTTP target outside loopback unless the user explicitly authorizes the credential exposure.

For imported functions or SDK methods, a separate test may install `mockTool` from `@firedrill-run/sdk/testing` with the existing runner's module mocks or spies. Use an external target with a direct binding, preserve input/result/error signatures, and install mocks before loading the agent as required by the runner. Keep shared mocked modules out of concurrent drills: use sequential tests and `concurrency: 1` within each worker. Parallel trials require isolated processes or module instances. This does not intercept private calls or opaque subprocess internals. Read [references/mocking.md](references/mocking.md) before adding a function mock or scoped response rule.

If a target protocol conflicts with the product interface—for example, a command target needs one JSON stdout value but the product CLI streams human output—prefer a separate thin target wrapper around the existing callable seam. Do not put target-specific transport or output branches into production agent logic. If no safe wrapper or existing configuration seam is possible, stop and report the unsupported boundary.

Module and external targets may execute concurrently in one process. Their adapters must be reentrant: never replace `process.stdout.write`, `process.stderr.write`, `console` methods, `process.env`, the working directory, or another process-global registry during an invocation. Inject a logger/output sink into the existing callable seam, or use a command target when the agent cannot avoid process-global output. A single passing trial does not prove a process-global adapter is safe.

### 3. Select or author the smallest useful Tool surface

Inspect `firedrill.json`, project dependencies, and existing Tool source before writing behavior. Reuse a compatible approved package already selected under `toolPackages`. Inspect it first with `firedrill tool inspect <tool-id> --json`; do not edit dependency files or infer capabilities that its manifest does not declare.

Use `firedrill tool add <installed-package>` to select an approved dependency or `firedrill tool create <tool-id>` for a stateful starter. These reuse the same tool contract; no service catalog or separate twin runtime is required.

Tools may live in anyone's repository, not only Firedrill's. `tool search [text]
--json` searches bundled metadata; `--index <path-or-url>` explicitly reads another
index. With installation authority, `tool add <npm/Git/local-source> --install`
pins and installs that source with scripts disabled. Never infer approval from a
catalog entry. For an author explicitly sharing a reusable package, use
`tool create <id> --package --name <npm-name> --root <new-directory>`; it includes
portable conformance. Keep dependency locks and `.firedrill-tools/` source archives
in version control, not generated `.firedrill/` evidence. Publishing or contributing
still requires separate explicit authority.

If no selected package matches the agent's actual seam, author a repository Tool. Do not force a generic example or near-match onto the project. Read [references/authoring.md](references/authoring.md) for both paths.

### 4. Author the smallest useful world

Create one vertical slice before breadth:

1. World with only the actors and grants needed by the drill.
2. One or more Tool operations the agent truly calls.
3. Deterministic Tool behavior and state transitions.
4. One scenario with realistic starting state or a declared fault.
5. One target matching the existing agent.
6. One drill asserting state, operation, event, error, or temporal consequences.

Use YAML or JSON for typed source and JavaScript/TypeScript for deterministic local behavior. Do not invent fields from prose.

### 5. Iterate compiler diagnostics to green

Canonicalize the authored source, then validate it:

```sh
firedrill format
firedrill format --check --json
firedrill validate --json
```

Formatting must preserve semantic build identity; if it refuses a write, fix the reported source instead of bypassing the guard. For every validation diagnostic, use its stable code, source span, path, message, and suggestion. Fix the source and rerun the format check plus validation. Do not proceed while pending format changes or error diagnostics remain. Then run `firedrill plan --json` and inspect the resolved tools, scenarios, drills, targets, provenance, and build identity.

### 6. Prove the binding canary

Run one drill with one action and one consequence:

```sh
firedrill run <drill-id> --trials 1 --json
```

Confirm the report records an observed Tool call and the intended state/event effect. A target returning text without touching the world is not a successful binding canary.

### 7. Prove pass, failure, and reproduction

Run the representative drill normally. Temporarily make one deterministic assertion false, rerun, and confirm exit code `1` plus an HTML evidence path. Restore the assertion and rerun to green.

Finish with `firedrill format --check --json` and `firedrill validate --json` again so temporary failure edits or later source additions cannot leave the repository non-canonical or invalid.

Use the exact reproduction command in the report. It loads the content-addressed local build and reuses its recorded seed, including any hashed test-local setup:

```sh
firedrill run <drill-id> --build-hash <sha256:...> --seed <seed> --trials 1
```

If the generated build has been removed, restore and compile the matching repository source and any recorded setup first. Never silently reproduce against a different build.

Use `firedrill compare <baseline-report> <candidate-report>` only after checking its compatibility grade. Never call a descriptive-only or incompatible delta a regression.

### 8. Add breadth only after the loop works

Add 3–5 drills covering the highest-risk state changes, permissions, retries/idempotency, provider failures, scheduled consequences, and safety invariants. Use tags and a `*.suite.yaml` only when selection policy is useful. Use timeline workloads for repeated actors and long virtual time; do not create a second runner.

For a reusable Tool, add a `<tool-id>-conformance.suite.yaml`, then run `firedrill tool inspect`, `firedrill tool validate`, and `firedrill tool test`. Cover every declared operation, declared error, event, fault, subscription, and callback. Tool conformance proves deterministic Tool behavior, so use a deterministic probe target or caller-owned harness for that suite; do not make conformance depend on stochastic model wording or tool selection. Keep separate drills exercising the real model-backed agent. Do not create another conformance DSL.

## Rules

- Prefer a user-owned Tool over a fake vendor-specific abstraction.
- Reuse a compatible, approved Tool package when one is actually present; never pretend a registry command or package exists.
- Never edit an installed Tool package. Select it in `firedrill.json`; contribute changes from its owned source repository.
- Assert on state, calls, events, callbacks, time, and errors. Treat response text as supporting evidence, not ground truth.
- Keep fixtures deterministic. Never make network calls from Tool behavior.
- In runner-owned tests, use `runDrills({ drill, setup })` for per-test state, faults, Tool selection, traceable behavior replacement and binding aliases. Use `toolOverrides` at world/scenario/drill or `setup.scenario` for declared return/error/original rules with argument/actor matching and optional `times`. Production agent code stays unchanged. Test-only function mappers may translate native signatures into world calls; do not mutate generated SQLite behind the runner or substitute unrecorded behavior closures for canonical Tool source.
- Never read, copy, move, or commit secrets. Map only explicitly required host environment variables.
- Keep model/provider credentials owned by the customer's agent process. Firedrill bindings carry only synthetic-world connection material.
- Do not weaken production behavior, bypass authorization, or add per-action test branches to make a drill pass.
- Keep Firedrill imports and invocation-specific branches out of production agent logic; repository-owned world/drill files and separate test-only adapters are the integration surface.
- Do not redirect, suppress, or reshape the agent's ordinary UI, stdout, return value, or errors merely to satisfy a target transport contract.
- Do not monkey-patch process globals inside module or external target adapters; trials and drills may overlap in the same process.
- Do not claim fidelity beyond the operations and failure modes implemented.
- Do not merge, publish, upload, or contact hosted services without explicit authority.
- Never supply `--accept-apache-2.0` on a Tool contribution unless the human explicitly confirms source rights and review for customer data and secrets.
- Keep local source and evidence private by default.
