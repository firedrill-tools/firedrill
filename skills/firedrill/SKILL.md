---
name: firedrill
description: Set up, author, validate, run, reproduce, or debug Firedrill synthetic worlds and agent drills in a software repository. Use when an agent must inspect an AI agent's real tool boundary, model deterministic Tool behavior and state, connect the existing agent through direct/HTTP/MCP/CLI/command/module seams, write *.drill.yaml tests or suites, iterate on Firedrill diagnostics, and produce local evidence reports.
---

# Build and run agent drills

Give the existing AI agent a deterministic, stateful world to act inside. Keep the agent process customer-owned. Change one composition seam, run drills locally, and assert on consequences rather than model wording.

## Definition of done

Do not stop at generated files. Finish only when all applicable checks hold:

- `firedrill.json` and repository-owned world source exist.
- `firedrill format --check --json` reports no pending source changes.
- `firedrill validate --json` returns success with no error diagnostics.
- At least one real Tool operation is supplied by an approved selected package or repository-owned deterministic behavior.
- The existing agent is connected at one declared target/binding seam.
- The agent's ordinary non-Firedrill entry point keeps its existing input, output, logging, and failure contract.
- At least one representative drill passes.
- A deliberately broken expectation produces exit code `1` and a verified local HTML report, then the source is restored.
- The passing drill is rerun after restoration.
- Every newly authored reusable Tool passes `firedrill tool test <tool-id> --json` through an ordinary conformance suite.
- Report the commands, files, selected target/binding, pass/fail evidence paths, and any fidelity limitations.
- Keep `firedrill.json` and `firedrill/` in version control; keep generated `.firedrill/` state and reports ignored.

## Execute one checked workflow

Treat “one shot” as this verified loop, not one blind generation pass.

### 1. Scout the repository

Find the agent entry point, its tool registry/client composition point, current tests, fixtures, mocks, MCP configuration, API clients, CLI adapters, and process start command. Identify the smallest seam where synthetic bindings can replace real dependencies without branching throughout business logic. Before editing, run or inspect the ordinary entry point and record its observable contract: accepted input, returned value or stdout, log destination, exit/error behavior, and provider configuration. Recheck that contract after integration; do not declare compatibility from a newly invented smoke path.

Do not assume an agent framework, protocol, vendor, or domain. A Tool represents any capability the agent can invoke; it may be reached by MCP, HTTP, a CLI adapter, an SDK, or an in-process function.

### 2. Choose the target and binding

Select the target that matches how the agent already runs:

- `command`: start an existing CLI, worker, or app process; use HTTP, MCP, or CLI bindings.
- `module`: call a repository module; use direct, HTTP, MCP, or CLI bindings.
- `http`: invoke an already-running loopback endpoint; use HTTP, MCP, or CLI world bindings.
- `external`: let the caller's test code invoke the agent through `runDrills()`; use direct, HTTP, MCP, or CLI bindings.

Read [references/bindings.md](references/bindings.md) before wiring the seam. Never give an out-of-process target a direct binding. Never point a local HTTP target outside loopback unless the user explicitly authorizes the credential exposure.

If a target protocol conflicts with the product interface—for example, a command target needs one JSON stdout value but the product CLI streams human output—prefer a thin target wrapper around the existing callable seam. If a wrapper is impossible, make transport/output routing conditional on the actual target invocation and prove the ordinary interface remains unchanged.

Module and external targets may execute concurrently in one process. Their adapters must be reentrant: never replace `process.stdout.write`, `process.stderr.write`, `console` methods, `process.env`, the working directory, or another process-global registry during an invocation. Inject a logger/output sink into the existing callable seam, or use a command target when the agent cannot avoid process-global output. A single passing trial does not prove a process-global adapter is safe.

### 3. Select or author the smallest useful Tool surface

Inspect `firedrill.json`, project dependencies, and existing Tool source before writing behavior. Reuse a compatible approved package already selected under `toolPackages`. Inspect it first with `firedrill tool inspect <tool-id> --json`; do not edit dependency files or infer capabilities that its manifest does not declare.

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

Restore repository source that compiles to the report's displayed build hash, then use its recorded seed to reproduce world inputs:

```sh
firedrill run <drill-id> --seed <seed> --trials 1
```

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
- Never read, copy, move, or commit secrets. Map only explicitly required host environment variables.
- Keep model/provider credentials owned by the customer's agent process. Firedrill bindings carry only synthetic-world connection material.
- Do not weaken production behavior, bypass authorization, or add per-action test branches to make a drill pass.
- Do not redirect, suppress, or reshape the agent's ordinary UI, stdout, return value, or errors merely to satisfy a target transport contract.
- Do not monkey-patch process globals inside module or external target adapters; trials and drills may overlap in the same process.
- Do not claim fidelity beyond the operations and failure modes implemented.
- Do not merge, publish, upload, or contact hosted services without explicit authority.
- Never supply `--accept-apache-2.0` on a Tool contribution unless the human explicitly confirms source rights and review for customer data and secrets.
- Keep local source and evidence private by default.
