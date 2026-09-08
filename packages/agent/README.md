# `@firedrill/agent`

Optional local authoring agent for Firedrill. It uses the Claude Agent SDK with the developer's own `ANTHROPIC_API_KEY` to inspect a repository, author or repair Firedrill source, and iterate the public validation and drill loop.

The package is not required to define worlds or run drills. It never owns verdicts, commits, pushes, publishes, reads secret files, or calls hosted Firedrill services. The ordinary `firedrill` CLI and `@firedrill/sdk` remain the source of validation, execution, assertions, and evidence.

Running it invokes Anthropic through the Claude Agent SDK and may send repository content selected during the session to Anthropic under Anthropic's applicable terms. It does not send source to Firedrill. The wrapper is Apache-2.0; the Claude Agent SDK dependency is distributed under Anthropic's own terms.

Packages are pre-release and not published yet. The commands below describe the
installed-package workflow; today use a source checkout or reviewed packed
artifacts as described in the [local environment guide](../../docs/local-environment.md).

```sh
pnpm add -D @firedrill/cli @firedrill/agent
export ANTHROPIC_API_KEY=your_key
firedrill init --path firedrill-agent
firedrill agent
```

Each invocation defaults to at most 40 turns, $2 of model spend, and a 15-minute wall-clock deadline. See `firedrill agent --help` for explicit overrides.

## Environment first

The default `workflow: "environment"` prepares tools, their deterministic behavior,
starting data and actor access. It does not require scenarios, targets or drills.
After the SDK session, Firedrill independently compiles and starts the selected
backend before returning `readiness.status: "ready"`. The temporary check closes
its listeners; use `firedrill serve` to keep the backend available.

`readiness.agentTested` is always false: listener startup is not an agent test,
and it does not prove the fake service's fidelity. Invalid source, unloaded
behavior or missing access returns a failed result even if the model says done.
In source-only mode the check returns `source-validated` without importing code.

Use `firedrill agent --workflow drill` (or `workflow: "drill"` in the API) when
authoring a repeatable agent test. The skill then follows the real runner and
report loop. A model response by itself never establishes a passing test.

## Source-only authoring

Programmatic callers can use `runFiredrillAgent({ root, allowRepositoryExecution: false })` when they want a reviewable source proposal without letting the authoring session execute repository code. This removes the drill runner from the actual MCP registry and SDK permissions, and restricts Tool checks to source inspection. Reading/editing ordinary files, formatting, compiler validation, and build-plan inspection remain available. The session reports execution as a remaining step, not a completed drill.

The same optional policy is accepted by `createFiredrillAuthoringTools` and `createFiredrillAuthoringServer`. The default stays `true` for the complete existing local loop. This option limits the assistant's tool surface; it does not replace operating-system isolation or review of source changes.
