# Firedrill

Firedrill is a simulation and testing framework for AI agents. Define synthetic
tools and data, run your agent against them, and assert on tool calls, state
changes, and events.

- Stateful tools with HTTP, MCP, CLI, and function bindings.
- Scenario-based tests with faults, response overrides, and virtual time.
- Isolated world state, seeded data, snapshots, and resets.
- HTML, JSON, and JUnit reports with timelines and optional browser captures.
- Repository-defined tools, including independently distributed packages.

[Quickstart](#quickstart) · [SDK](#using-the-sdk) ·
[Documentation](https://docs.firedrill.run) · [Neutral example](examples/quickstart/README.md) ·
[Gmail Agent example](https://github.com/firedrill-tools/firedrill-example-gmail-agent)

## Installation

Requirements: Node.js 20.19 or later and pnpm 9.15–10.

Packages are not yet published to npm. From a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm build

# Use the built CLI in this terminal.
export FIREDRILL_CLI="$PWD/packages/cli/dist/bin.js"
firedrill() { node "$FIREDRILL_CLI" "$@"; }
```

The examples below use this shell function. You can also invoke the CLI directly
with `node /path/to/firedrill/packages/cli/dist/bin.js`.

The programmatic API is `@firedrill/sdk`. To prepare installable archives of the
CLI, SDK, and other packages from this checkout, run
`pnpm pack:artifacts -- --output /absolute/path/to/an/empty/directory`.
The output includes a package manifest.

## Quickstart

Create a project with a synthetic record store:

```sh
mkdir ../firedrill-example
cd ../firedrill-example
firedrill init --custom records
firedrill serve
```

`init` creates a Tool declaration, a behavior module, and starting data.
`serve` starts the backend and opens the inspector.

Open **Tools** to inspect the implementation or call an operation.
**State & activity** shows records and calls; **Connect agent** provides the
connection settings. Tools with a bundled UI also have an **Open app** action.
Browser actions and API calls use the same state.

The server listens on loopback using available ports. Keep the terminal open;
Ctrl+C stops it. Use `--no-open` to skip opening the inspector automatically.

Run `firedrill init` in an existing project for guided setup, or select a package
from the [Tool catalog](registry/README.md). Catalog packages currently require
a local installation until they are published.

Tools can run independently of tests. To check an agent's behavior, add a drill.

For a model-backed project, see the
[Gmail Agent example](https://github.com/firedrill-tools/firedrill-example-gmail-agent):
an existing Claude Agent SDK assistant runs three drills against a pinned
stateful Gmail Tool, with its synthetic mailbox and reports kept in the project.

## Writing drills

A **drill** defines an agent task, starting conditions, and assertions about the
result. To try one, stop the server and create the example test project:

```sh
mkdir ../firedrill-first-drill
cd ../firedrill-first-drill
firedrill init --path template
firedrill validate
firedrill plan
firedrill run changes-resource
firedrill inspect
```

The template contains a deterministic example agent that writes `7` to a record.
Its drill checks that the write succeeded once and that the final value is `7`.
Replace the example target with your agent when adding your own tests.

To inspect a failing result, edit
`firedrill/drills/changes-resource.drill.yaml`: change the `value-changed`
assertion's expected value to `8`, keeping `task.input.value` at `7`.
Rerun the drill. The report shows expected `8` and actual `7`; the process exits
with code `1`. Restore the expectation afterwards.

| Command | Purpose |
| --- | --- |
| `firedrill validate` | Check source definitions |
| `firedrill plan` | List tools, scenarios, targets, and drills |
| `firedrill run <id>` | Run one drill |
| `firedrill` | Run all drills |
| `firedrill serve` | Start a standalone synthetic backend |
| `firedrill inspect` | Browse definitions and saved results |

### Definitions

| Term | Meaning |
| --- | --- |
| Tool | A synthetic dependency with callable operations, input/output schemas, and an implementation |
| World | Tools, starting data, identities, permissions, and a clock |
| Scenario | A variation of the starting data, permissions, faults, or scheduled events |
| Target | Configuration for invoking the agent under test |
| Drill | A task and its assertions |
| Run | A recorded execution result, including checks, calls, and state changes |

Actors identify who is calling a tool and which operations they may use.
Personas provide descriptions of those identities. See
[people and permissions](docs/world-authoring.md#people-and-permissions).

## Connecting an agent

Configure the agent's dependencies in test setup:

| Dependency | Integration |
| --- | --- |
| HTTP client | Point its base URL and authentication at the Tool's declared HTTP routes |
| MCP server | Use the world's MCP endpoint and actor token |
| CLI tool | Use a test-side command adapter or the Firedrill world CLI |
| Function or SDK method | Use runner mocks/spies with `mockTool` from `@firedrill/sdk/testing` |
| Web interface | Use a Playwright harness or the optional browser-test package |

Bindings use existing configuration or test-side adapters, leaving production
agent logic unchanged. Hardcoded dependencies need an interceptable boundary or
an explicit adapter. See [binding recipes](docs/quickstart.md#3-keep-the-agent-integration-at-one-seam)
and [test-side mocking](docs/test-mocking.md).

Targets can invoke a module, start a command, call an HTTP endpoint, or use an
`external` callback supplied by a test harness. External targets run through the
SDK; module, command, and HTTP targets can also run through the CLI.

Model credentials belong to the agent process. For command targets, pass model
credentials and other required host variables through `environmentFromHost`.
Set target timeouts for the complete model/tool loop.

## Using the SDK

Use `runDrills` from an existing test runner:

```ts
import { runDrills } from "@firedrill/sdk";

const result = await runDrills({
  root: process.cwd(),
  drill: "my-drill",
  agent: ({ task, binding, signal }) =>
    runMyAgent({ task, environment: binding.environment, signal }),
});

expect(result.verdict).toBe("passed");
```

This example assumes a declared `my-drill` with an `external` target.
`runMyAgent` is your test adapter; it applies the supplied connection values to
your agent. `expect` comes from your test runner.

`runDrills({ setup })` supports per-test data, fault, and Tool overrides.
`createLocalWorld()` provides direct control over calls, state, time, and resets.
See the [SDK reference](packages/sdk/README.md) for lifecycle hooks, concurrency,
capture, and report APIs.

## Project structure

The example template uses the following layout:

```text
your-project/
  firedrill.json                         # source location and selected packages
  firedrill/
    world.yaml                          # starting data, identities, access, time
    tools/resource-store/
      resource-store.tool.yaml          # operations and state schemas
      behavior.mjs                      # operation implementations
    scenarios/baseline.scenario.yaml    # starting conditions
    targets/starter-agent.target.yaml  # agent invocation
    drills/changes-resource.drill.yaml  # task and assertions
    suites/resource-store-conformance.suite.yaml
  firedrill-example/agent.mjs           # example agent
  .firedrill-tools/                     # vendored Tool dependencies
  .firedrill/                           # generated state, builds, and reports
```

Definitions support JSON or YAML; use either consistently or mix them.
Resource suffixes identify file types, such as `.tool.json` and `.drill.yaml`.
References use IDs inside the files, so you can organize folders as needed.
Tool implementations are JavaScript or TypeScript.

Commit definitions, behavior modules, test code, package manifests, lockfiles,
and referenced `.firedrill-tools/` archives. Generated files under `.firedrill/`
are ignored by `init`. Keep credentials, `.env` files, and `node_modules/` ignored
as well.

### Source and runtime state

Tool state lives in SQLite. Runtime writes leave the source definitions unchanged.
Source edits apply to the next build; restart `serve` to load them.

Each trial or retry uses an isolated world. A full reset restores its baseline;
a scoped reset restores selected Tools. Reset affects the synthetic environment,
not the agent's own database or memory. Saved reports are retained.

See [source authoring](docs/world-authoring.md) and
[world controls](docs/local-world-control.md).

## Reports

Open `.firedrill/reports/index.html` to browse saved runs, or use **Results**
in the inspector. Each run directory contains:

- An HTML report with task, outcome, expected/actual checks, and tool activity.
- JSON results, JUnit XML, and ordered evidence.
- An integrity manifest and any captured attachments.

```sh
firedrill compare .firedrill/reports/<baseline> .firedrill/reports/<candidate>
firedrill report verify .firedrill/reports/<run-id>
```

Reports distinguish assertion failures, execution errors, and incomplete evidence.
CLI exit codes are `0` for a passing selection, `1` for source/execution/check
failure, and `2` for invalid command usage.

The reproduction command pins the build and seed. This reproduces the world
inputs; live model responses can still vary. Comparisons identify changed inputs
before presenting result differences.

Keep attachment folders with their reports. Review captured data before sharing.
Bundle verification checks integrity, not authorship. See
[running and results](docs/running-and-results.md) for the report layout and CI use.

## Simulation controls

| Capability | Usage or guide |
| --- | --- |
| Repeated trials | `firedrill run changes-resource --trials 3 --seed 42` |
| Filtered, concurrent execution | `firedrill run --tag smoke --concurrency 4` |
| Watch mode | `firedrill run changes-resource --watch` |
| Per-test data and Tool overrides | [SDK setup](packages/sdk/README.md#per-test-synthetic-data-and-tools) |
| State inspection, virtual time, and resets | [World controls](docs/local-world-control.md) |
| Multi-interaction simulations | [Drill timelines](docs/running-and-results.md#repeat-compare-and-simulate-longer) |
| Synthetic webhooks | [Callbacks](docs/callbacks.md) |
| Reusable starting states | [Scenarios](docs/reusable-scenarios.md) |
| Logs, screenshots, recordings, and traces | [Capture](docs/capture.md) |
| UI-driven tests | [Browser tests](packages/browser-tests/README.md) |

Browser tests drive an application. Tool apps are interfaces to synthetic
dependencies. Combine a browser harness with a world-bound drill to check both
page behavior and Tool state.

In CI, use the same commands or SDK tests and retain the report directory.
JUnit files work with standard test-results viewers.

## Coding agents

Firedrill includes a [skill](skills/firedrill/SKILL.md) for coding agents and an
optional authoring assistant built with the Claude Agent SDK.

To install instructions for your coding agent:

```sh
firedrill init --path coding-agent
```

To use Firedrill Agent:

```sh
firedrill init --path firedrill-agent
firedrill agent
firedrill agent --workflow drill
```

The default workflow creates or edits a synthetic environment. Use
`--workflow drill` to author tests. Both initialization paths create instructions
and a repository brief; the agent then authors the definitions.

Firedrill Agent requires `@firedrill/agent` and `ANTHROPIC_API_KEY` in the process
environment. The source checkout includes the package. The CLI does not load
`.env` automatically. Selected repository content is sent to Anthropic.

Default limits are 40 turns, $2 of model spend, and 15 minutes per invocation.
See `firedrill agent --help` for overrides and [Security](SECURITY.md#optional-firedrill-agent)
for execution and source-access boundaries. `--json` diagnostics are available
for scripted validation and authoring workflows.

## Tool packages

Create a Tool in your project:

```sh
firedrill tool create my-tool
firedrill tool create my-helper --template stateless
firedrill tool inspect my-tool
firedrill tool validate my-tool
```

Tool declarations describe operations and schemas; behavior modules implement
their responses and state changes. Add a conformance suite, then run
`firedrill tool test my-tool`.

For a standalone package with a starter conformance suite:

```sh
firedrill tool create my-tool --package --name @your-team/my-tool --root <new-directory>
```

Packages can live in any repository. Install one from npm, Git, a local directory,
or an archive with `firedrill tool add <source> --install`. Without `--install`,
the command selects an already installed package. Use `firedrill tool list` to
browse the community catalog, `firedrill tool search <text>` to narrow it, or
`--index <file-or-HTTPS-url>` to use another index.

Installation pins source and disables lifecycle scripts. Tool execution uses
your local permissions; review packages as executable test dependencies.
Conformance results describe tested coverage, not complete service compatibility.

See [installation](docs/tool-installation.md), [package authoring](docs/tool-packages.md),
[Tool apps](docs/tool-apps.md), and the [compatibility contract](docs/tool-compatibility.md).

## Documentation

- [Developer guides](docs/README.md)
- [CLI reference](docs/cli-reference.md)
- [TypeScript SDK](packages/sdk/README.md)
- [Troubleshooting](docs/running-and-results.md#ci-and-common-first-use-problems)
- [Compatibility policy](docs/compatibility.md)
- [Security](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Copyright Reload Tech Inc.
