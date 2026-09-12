# Firedrill

Firedrill is an open-source simulation and testing framework for AI agents.
Give your existing agent working fake tools and data, let it choose its actions,
and check what it actually changed—not just what it said.

Start a synthetic backend to experiment, or run a **drill**: a task for the agent
with checks on the outcome. Both run locally, without a Firedrill account or
Docker. Agents can use HTTP, MCP, CLI commands, functions, or a browser; they do
not have to be chatbots.

This guide is for developers **using** Firedrill. Start here, then follow the
linked guides when you need more control.

[Install](#install-the-current-version) · [Start tools](#start-tools-for-your-agent) ·
[First drill](#run-your-first-drill) · [Connect your agent](#connect-your-existing-agent) ·
[Files](#where-your-files-live) · [Results](#read-the-results) ·
[Create and share tools](#create-and-share-tools) · [All guides](docs/README.md)

## Install the current version

**Pre-release:** the packages are not published to npm yet. These instructions
use a source checkout; they do not assume an available `npx` or registry release.
You need Node.js 20.19 or newer and pnpm 9.15–10.

From this Firedrill checkout:

```sh
pnpm install --frozen-lockfile
pnpm build

# Make the built CLI available in this terminal, including after changing folders.
export FIREDRILL_CLI="$PWD/packages/cli/dist/bin.js"
firedrill() { node "$FIREDRILL_CLI" "$@"; }
firedrill --help
```

Wait for the build to finish before using the CLI. The shell function above is
only a convenience for this terminal; it does not install or modify your agent.
Alternatively, call `node /absolute/path/to/firedrill/packages/cli/dist/bin.js`.

The TypeScript API is `@firedrill/sdk`; the optional local authoring assistant is
`@firedrill/agent`. Until publication, use reviewed local package archives for
those dependencies, not registry install commands. The repository's
`pnpm pack:artifacts -- --output /absolute/path/to/an/empty/directory` prepares
the package set and its manifest without publishing it.

## Start tools for your agent

From the checkout, create a separate directory for a small, editable backend:

```sh
mkdir ../firedrill-tools-demo
cd ../firedrill-tools-demo
firedrill init --custom records
firedrill serve
```

`init` writes a real Tool declaration, behavior module, and starting world.
This custom starter is a small record store to adapt, **not** a replica of your
agent's service. `serve` starts it on loopback and opens the local inspector.

In the inspector, open **Tools** to read the implementation and try an operation.
Inspect the resulting data and activity. Use **Connect agent** for the actual connection
settings. If a Tool includes an interactive app, **Open app** opens it; its UI
and API operate on the same synthetic data.

Keep the terminal running; Ctrl+C stops the server. Use `serve --no-open` if you
prefer to open the printed inspector URL yourself. Ports are chosen dynamically.
Connection URLs and tokens are private to that running environment.

In your real agent repository, `firedrill init` offers guided Tool selection and
authoring choices. You can use your own Tools, independently distributed
packages, or the [maintained catalog](registry/README.md). Unpublished catalog
packages need a local installation; selecting one does not make it downloadable.

No scenario, target, or test is required to start Tools. A successful playground
call proves that operation worked; it does not mean your agent passed a drill.
See [the complete tool-first workflow](docs/local-environment.md).

## Run your first drill

After stopping `serve`, create a **different new directory** beside that demo:

```sh
mkdir ../firedrill-first-drill
cd ../firedrill-first-drill
firedrill init --path template
firedrill validate
firedrill plan
firedrill run changes-resource
firedrill inspect
```

The included agent is a deterministic client, not an LLM. It writes the value
`7` through a synthetic Tool. The drill checks that the operation succeeded once
and that the stored value is `7`. No model key is needed for this example.

To see a failure, open `firedrill/drills/changes-resource.drill.yaml` and change
only the `value-changed` assertion's expected value from `7` to `8`. Leave
`task.input.value` at `7`, then rerun the drill. The report shows expected `8`,
actual `7`, and the CLI exits with `1`. Restore the expectation afterwards.

`validate` checks definitions without running the agent. `plan` lists the setup.
`run` executes it. Bare `firedrill` runs all drills. `inspect` opens definitions
and saved results; unlike `serve`, it does not silently start a live backend.

### The few names you need

| Name | Meaning |
| --- | --- |
| **Tool** | A fake dependency with defined inputs, responses, and behavior. A write can change what the next call reads. |
| **World** | The Tools and their starting data, identities, permissions, and clock. |
| **Scenario** | A variation of that setup: different records, permissions, failures, or scheduled events. |
| **Target** | Test configuration for reaching the agent you already have. |
| **Drill** | An agent task plus checks on its consequences. |
| **Run** | A saved execution result: checks, calls, changed data, and optional captured files. |

A persona describes an identity; an actor acts with particular permissions.
Neither automatically creates another LLM or a simulated user. Most projects
can start with one actor. [People and permissions](docs/world-authoring.md#people-and-permissions)
explains when more are useful.

## Connect your existing agent

Firedrill controls the **surroundings**, not the agent's decisions or internal
database. Its SQLite world backs the synthetic Tools. It is not a replacement
for your application's PostgreSQL, MongoDB, or other storage.

Use the agent's existing configuration or a separate test harness:

| Your agent uses… | Connect in test setup with… |
| --- | --- |
| HTTP clients | A configurable base URL/auth pointing at declared synthetic HTTP routes. |
| MCP | The running world's MCP connection and actor token. |
| CLI tools | A test-side command adapter or the Firedrill world CLI. |
| Imported functions or SDK methods | Your runner's mocks/spies and `mockTool` from `@firedrill/sdk/testing`. |
| A web interface | Your Playwright harness or the optional Firedrill browser-test package. |

There are no required Firedrill imports or per-action test branches in production
agent logic. But the test must reach a real configurable or interceptable seam:
setting an environment variable the application never reads does nothing.
An inaccessible or hardcoded dependency may need a test adapter. Firedrill does
not universally intercept arbitrary processes or silently fall back to production.

For repeatable drills, declare a `module`, `command`, or `http` target to invoke
the agent from source configuration. Use `external` when your test file already
owns the agent process. That target needs an SDK callback; the CLI and inspector
cannot invent it.

For example, in your existing test runner, after installing the SDK:

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

Here `my-drill` is your declared drill with an `external` target;
`runMyAgent` is your own test-side entry point, not a Firedrill function.
It must apply the supplied connection values to the agent's existing clients.
Your runner supplies `expect`. [Binding recipes](docs/quickstart.md#3-keep-the-agent-integration-at-one-seam)
and [test-side mocking](docs/test-mocking.md) cover the concrete choices.

The agent keeps its own model credentials. Command targets must explicitly
allow required host variables through `environmentFromHost`; do not put keys
in world files or Tool connection values. Allow enough target time for the
entire model/tool loop, not just one model request.

## Where your files live

The teaching template uses this layout. Names and folders are yours to organize;
resource references use stable IDs inside the files.

```text
your-project/
  firedrill.json                         # where source lives and which packs to use
  firedrill/
    world.yaml                          # starting data, identities, access, time
    tools/resource-store/
      resource-store.tool.yaml          # operations, input/output and state schemas
      behavior.mjs                      # what the fake Tool actually does
    scenarios/baseline.scenario.yaml    # starting-condition variation
    targets/starter-agent.target.yaml  # how to invoke the existing agent
    drills/changes-resource.drill.yaml  # task and assertions
    suites/resource-store-conformance.suite.yaml
  firedrill-example/agent.mjs           # teaching client; not production agent code
  .firedrill-tools/                     # vendored Git/local Tool source, if used
  .firedrill/                           # GENERATED state, builds, reports
```

You can use **JSON throughout** instead of YAML; a mixture is not required.
Typed files use resource suffixes such as `.tool.json` or `.drill.yaml`.
Executable behavior stays in JavaScript/TypeScript. Optional Markdown explains
the source; free-form prose is not automatically executable behavior.

Commit your definitions, behavior, test harness, package manifest/lockfile, and
referenced `.firedrill-tools/` archives. Keep `.firedrill/`, model keys, `.env`
files, and `node_modules/` out of Git. `init` adds `.firedrill/` to `.gitignore`;
you remain responsible for your application's other sensitive files.

Runtime writes update SQLite, **not** your source files. Changing source creates
a new build for the next run; restart `serve` to use it there. Each trial/attempt
gets an isolated world, not a separate database for every vendor. Full reset
restores the starting world; scoped reset can restore selected Tools. Neither
resets your agent's own memory/database nor deletes saved drill reports.
See [source authoring](docs/world-authoring.md) and [reset semantics](docs/local-world-control.md).

## Read the results

Start at **`.firedrill/reports/index.html`**. It links to saved runs without a
running server. Each run folder contains its own HTML report, machine-readable
JSON, JUnit XML, ordered evidence, integrity manifest, and optional attachments.
The inspector's **Results** page provides another way to browse them.

Read one result in this order:

1. **Task and outcome:** what was requested and whether execution finished.
2. **Checks:** what passed or failed, with expected versus actual values.
3. **Tool activity and state changes:** what the agent called and what changed.
4. **Captured files:** logs, screenshots, recordings, or traces when enabled.

A reply saying “done” cannot override a failed state assertion. A timeout,
source error, or missing evidence is not the same as a behavioral failure.
The CLI exits `0` for a passing selection, `1` for source/execution/check failure,
and `2` for invalid command usage.

Keep a report's attachment folder with it when sharing. Reports can contain
sensitive test records and model output: review before sharing. The inspector's
**Open report** can embed verified attachments in the opened copy.
`firedrill report verify <report-directory>` checks bundle integrity; an unsigned
local report does not prove who created it.

Use the reproduction command printed with the result to pin its build and seed.
That repeats the **world inputs**, not a live model's exact decisions. Compare
two report directories with `firedrill compare <baseline> <candidate>`; changed
inputs make a comparison descriptive, not proof of a regression.

## Go beyond a single test

| You want to… | Use |
| --- | --- |
| Repeat the teaching drill | `firedrill run changes-resource --trials 3 --seed 42` |
| Run selected smoke tests | `firedrill run --tag smoke --concurrency 4` |
| Rerun after source edits | `firedrill run changes-resource --watch` |
| Inject data, faults, or response overrides for one test | [`runDrills({ setup })`](packages/sdk/README.md#per-test-synthetic-data-and-tools) |
| Control Tools directly, inspect state, advance time, or reset | [`createLocalWorld()`](docs/local-world-control.md) |
| Simulate multiple interactions over time | [Drill timelines and long simulations](docs/running-and-results.md#repeat-compare-and-simulate-longer) |
| Send a fake service webhook into your application | [Callbacks](docs/callbacks.md) |
| Save selected changed data as another starting scenario | [Reusable scenarios](docs/reusable-scenarios.md) |
| Capture logs, screenshots, video, or files only on failure | [Optional capture](docs/capture.md) |
| Test through a UI | [Browser tests](packages/browser-tests/README.md) |

Browser tests drive an application; **Tool apps** are the synthetic dependencies'
own interfaces. They are different features. Browser-only checks prove what was
observed in the page. Combine the browser harness with a world-bound drill when
you also need assertions about Tool calls and synthetic data.

In CI, run the same CLI command or test file and retain its report directory.
Use JUnit XML with your existing CI test-results viewer. Your test runner stays
Jest, Vitest, Mocha, pytest, Playwright, or whatever already invokes your agent;
Firedrill supplies the controlled environment and evidence.

## Let a coding agent set it up

You can write definitions yourself, use your existing coding agent, or use
**Firedrill Agent**. All three work on the same repository files.

```sh
firedrill init --path coding-agent   # installs instructions and a repository brief
firedrill init --path firedrill-agent
firedrill agent                     # prepare or edit a synthetic environment
firedrill agent --workflow drill    # explicitly author a drill
```

For your own coding agent, start with the installed instructions or the
[canonical skill](skills/firedrill/SKILL.md). Ask it to inspect the agent's real
tool seams, prepare compatible fake Tools, validate, and run a representative
drill. `--json` diagnostics support an edit/validate/retry loop. A noninteractive
`init` without an explicit setup choice only reports options; it writes nothing.

The source checkout includes the optional Agent package after building. Other
installations need it separately. Firedrill Agent reads `ANTHROPIC_API_KEY` from
its process environment; it does not automatically load `.env` files. It uses
the **Claude Agent SDK**. Missing key/package?
The CLI gives a resume instruction; the rest of Firedrill still works.
Selected source goes to Anthropic, not to a Firedrill service. The assistant
cannot read secret files or generated evidence, use a shell, commit, or publish.
Defaults are 40 turns, $2 of model spend, and 15 minutes per invocation, with
explicit CLI overrides. Its startup check is not proof that your agent passed.

## Create and share tools

Use existing packages or write exactly the fake behavior you need. Tools may be
stateless, stateful, backend-only, or include an interactive app. You do not have
to contribute to this repository to distribute a compatible Tool.

```sh
firedrill tool create my-tool                 # declaration + editable behavior
firedrill tool create my-helper --template stateless
firedrill tool inspect my-tool                # inspect source, without running it
firedrill tool validate my-tool               # explicitly load/check its behavior
firedrill tool test my-tool                   # run its declared conformance suite
```

A conformance suite must be authored; creating a Tool is not proof of its fidelity.
For an independently distributable starter, use
`firedrill tool create my-tool --package --name @your-team/my-tool --root <new-directory>`.
This includes a portable suite. Choose your own license before publishing.

Install a real package from npm, Git, a local directory, or an archive with
`firedrill tool add <source> --install`. Without `--install`, it only selects an
already installed package. Search with `firedrill tool search`, optionally using
`--index <file-or-HTTPS-url>` for someone else's catalog. Acquisition pins source
and disables install scripts; execution still runs **trusted local test code**,
not a security sandbox. Review it like any test dependency.

Read [Tool installation](docs/tool-installation.md), [package authoring](docs/tool-packages.md),
[the open compatibility contract](docs/tool-compatibility.md), and
[interactive Tool apps](docs/tool-apps.md). Declared compatibility and passing
author tests are not certification of complete real-service behavior.

## Help and reference

- [Developer guides](docs/README.md): choose a workflow or learn a file format.
- [CLI reference](docs/cli-reference.md): exact commands, flags, and JSON output.
- [TypeScript SDK](packages/sdk/README.md): lifecycle, mocks, assertions, and capture.
- [Troubleshooting](docs/running-and-results.md#ci-and-common-first-use-problems):
  no drills, external handlers, missing Tool activity, timeouts, or report errors.
- [Compatibility policy](docs/compatibility.md) and [security](SECURITY.md).

Firedrill is licensed under [Apache-2.0](LICENSE). Copyright Reload Tech Inc.
Looking to change Firedrill itself? See [Contributing](CONTRIBUTING.md).
