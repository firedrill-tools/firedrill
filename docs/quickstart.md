# Quickstart

This guide explains Firedrill's repository contract. The files belong beside the agent code, can be reviewed in pull requests, and work without an account.

## 1. Pick a verified starting path

In an existing repository, `firedrill init` performs a bounded read-only inspection and prints three explicit choices. It never edits anything without `--path`.

```sh
firedrill init
firedrill init --path coding-agent
# or: firedrill init --path template
# or: firedrill init --path manual
```

The coding-agent path installs the canonical skill and a repository-specific brief under `.agents/` without creating application or world source. The template path creates a complete runnable Tool, target, scenario, and drill. The manual path creates only a valid world shell and deterministic probe Tool. Existing source files are never replaced. Every selected path also ensures `.firedrill/` is present in the repository's `.gitignore`, appending only that rule when necessary.

Alternatively, copy `examples/quickstart` into a temporary directory or inspect it in place. It contains one intentionally plain agent and one Tool so the framework concepts stay visible.

```text
firedrill.json
firedrill/
  world.yaml
  workspace.tool.yaml
  workspace.js
  empty.scenario.yaml
  local-agent.target.yaml
  set-record.drill.yaml
  workspace-conformance.suite.yaml
agent.mjs
```

Run `firedrill validate`, inspect the discovered work with `firedrill plan`, then run `firedrill`. A fresh SQLite world is created, the agent is invoked with only its declared binding, assertions inspect the resulting consequences, and the terminal prints a local HTML report path.

### What belongs in Git

| Commit | Keep local and ignored |
| --- | --- |
| `firedrill.json` | `.firedrill/builds/` |
| `firedrill/**/*.yaml`, JSON, and behavior modules | `.firedrill/worlds/` and `.firedrill/runs/` |
| Agent/test integration code | `.firedrill/reports/` and `.firedrill/tool-tests/` |
| The installed coding-agent skill, when the team wants it shared | `.firedrill/contributions/` |

The ignored side is reproducible runtime output and may contain synthetic data, model output, and evidence. Provider keys belong in the agent's normal ignored environment files or secret manager—never in either Firedrill source or reports.

## 2. Replace the fixture with the agent's real boundaries

Work from the interfaces the agent already uses:

- Model each required action surface as a Tool operation with typed input, output, and deterministic behavior.
- Put baseline records, actors, permissions, time, and initial events in the world.
- Put each meaningful starting condition or provider failure in a scenario.
- Choose one target matching how the agent already runs: module, command, local HTTP, or an SDK callback.
- Give the target only the direct, HTTP, or MCP bindings it needs.
- Write drills around observable consequences and safety invariants, not phrasing in the model response.

Tools are not limited to REST APIs. They describe capabilities and consequences; HTTP and MCP are current transport adapters. A CLI-based agent can still receive an HTTP or MCP world binding through environment variables.

### Reuse an installed Tool package when one fits

A reusable Tool is an ordinary package dependency, not a framework feature switch. Install it with the project's package manager, then select it once in `firedrill.json`:

```sh
pnpm add -D @scope/firedrill-tool
```

```json
{
  "schemaVersion": 1,
  "sourceRoot": "firedrill",
  "world": "world.yaml",
  "toolPackages": ["@scope/firedrill-tool"]
}
```

Install the selected Tool package itself; do not add its Firedrill implementation dependencies to the application. The compiler embeds the approved Tool behavior runtime into the locked artifact.

The generated [Tool-pack catalog](../registry/README.md) shows operation-level fidelity for known packs; the machine-readable form is [`registry/index.json`](../registry/index.json). The selected package's own documentation gives its Tool id, operations, state contract, and setup. `firedrill validate` reads and locks the selected declaration without executing behavior. Use `firedrill tool inspect <tool-id>` to see exactly what was selected, then `firedrill tool validate <tool-id>` or run a drill to execute it locally. Your repository still owns its initial data, actors, scenarios, targets, and drills. Firedrill never edits the installed package.

The pre-release source tree includes [`@firedrill/tool-work-queue`](../tool-packs/work-queue/README.md) as a neutral contract and packaging proof. It is not yet a published dependency.

## 3. Keep the agent integration at one seam

For a command target, Firedrill sends a JSON invocation on stdin and supplies the declared binding variables, such as `FIREDRILL_HTTP_URL` and `FIREDRILL_HTTP_TOKEN` or their MCP equivalents. For an external target, `runDrills()` supplies the same values in `binding.environment`. A direct binding is available only to a module or callback target that declares it.

Firedrill does not become the model-provider credential store. An external callback uses the provider configuration already available to its owning process. A command target can map only the host variables it needs:

```yaml
environmentFromHost:
  ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
```

Unlisted host variables are not inherited by the command. The target's `timeoutMs` covers the complete agent interaction, including all model turns and Tool calls, so choose it for the slowest expected end-to-end loop rather than one request.

Repoint or adapt the agent's existing tool client once. Do not duplicate every agent action or scatter test-mode branches through business logic.

HTTP-bound agents can discover their granted operations at `GET $FIREDRILL_HTTP_URL/v1/tools` and call one at `POST /v1/operations/{packageId}/{operationId}` with bearer authentication. MCP-bound agents use the supplied Streamable HTTP URL and token; discovered names are `{packageId}.{operationId}`. The protocol package READMEs define the exact request and response envelopes.

## 4. Run and diagnose

```sh
firedrill validate
firedrill plan
firedrill
firedrill run <drill-id> --trials 3 --seed 42
firedrill run <drill-id> --json
firedrill run --suite <suite-id> --concurrency 4
firedrill run --tag safety --shard 1/2
firedrill run <drill-id> --watch
firedrill report verify .firedrill/reports/<run-id>
firedrill tool inspect <tool-id>
firedrill tool validate <tool-id>
firedrill tool test <tool-id>
```

Exit code `0` means every selected drill passed. Exit code `1` means source, execution, or assertions failed. Exit code `2` means the CLI invocation itself was invalid. Human and JSON modes carry the same diagnostics and report locations.

Every trial retains its exact world and writes terminal, JSON, JSONL, JUnit, and self-contained HTML evidence under the current project's `.firedrill/` directory. That directory is generated and Git-ignored by default. Use `firedrill report verify <report-directory>` to check the exact file set, hashes, schemas, identities, evidence ordering, and generated projections without an account or network. This proves bundle integrity, not authorship. Use the build hash, seed, and reproduction command in the report to rerun deterministic world inputs.

A drill timeline can span hours of virtual time while running locally in minutes. It declares actors, ordered interactions, a horizon, invariant checkpoints, and Tool-call and event budgets; it is still a drill and uses the same runner and evidence. Watch mode queues edits and reruns without overlapping. To inspect change, compare two verified report directories:

```sh
firedrill compare .firedrill/reports/<baseline> .firedrill/reports/<candidate>
```

Read the compatibility grade before interpreting deltas. A build or Tool-lock change is descriptive evidence, not proof that the agent regressed.

Tool conformance uses ordinary drills rather than a second test language. Name the suite `<tool-id>-conformance` (or pass `--suite`), cover every declared operation/error/event/fault/subscription, and run `firedrill tool test <tool-id>`. Firedrill executes it twice against one immutable build and checks same-seed state and trajectory hashes. After it passes, a human who owns the source may prepare a non-uploading review bundle:

```sh
firedrill tool contribute <tool-id> --accept-apache-2.0
```

This copies only the Tool declaration and its exact local behavior dependency closure, blocks common secret patterns, writes checksums and a portable conformance summary, and never overwrites, uploads, or opens a pull request.

## 5. Let a coding agent iterate to green

A coding agent should begin with `.agents/firedrill/BRIEF.md` and `.agents/skills/firedrill/SKILL.md`, inspect the real agent's tool clients, existing mocks, fixtures, and failure tests, create or select Tool packages, then run `firedrill validate --json` repeatedly until diagnostics are empty. It should run a small passing and intentionally failing drill before adding breadth. It must not invent unsupported fidelity or change production behavior merely to satisfy a fixture.

Published JSON Schemas are available from `@firedrill/compiler/schema/*` and `@firedrill/contracts/schema/*`. Source diagnostics include stable codes, file locations, paths, and corrective suggestions for machine use.
