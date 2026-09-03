# Firedrill

Firedrill is an open-source stateful simulation and testing framework for AI agents that take actions.

Firedrill gives your AI agent a world to work inside—tools, data, and state with real consequences—so you can test what it does, not just what it says. Each trial starts from a fresh, controlled world, lets the existing agent act through its ordinary tool seams, and verifies the resulting state and behavior. The complete individual-developer loop runs locally without an account, upload, or hosted service.

Firedrill runs worlds and drills. It does not host, rewrite, or choose the agent.

## The product loop

1. **World** — repository-owned starting state, actors, permissions, clock, and deterministic behavior.
2. **Tools** — local or explicitly selected package operations and the stateful consequences or failures they produce.
3. **Scenario** — a named starting condition, including data, faults, events, and time.
4. **Target** — the one seam through which Firedrill starts or calls the existing agent.
5. **Drill** — a task plus assertions about state, tool calls, events, and ordering.
6. **Evidence** — a retained SQLite world and terminal, JSON, JUnit, and self-contained HTML reports.

Short drills and long-running workloads use the same world, Tool, scenario, runner, and evidence model. A Tool can model any action surface an agent depends on; vendor examples are reusable packages, not framework branches.

## Try the complete local loop

The neutral [quickstart](examples/quickstart/README.md) is executable product documentation. From this source checkout:

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js --root examples/quickstart
```

The drill passes and prints an HTML report path. Change the expected final value as described in the quickstart and run it again to see the assertion diff and reproduction command.

For an existing project, run the guided terminal setup or select a deterministic path directly. JSON, CI, and piped `init` remain read-only unless `--path` is present:

```sh
firedrill init
firedrill init --path firedrill-agent # canonical skill + optional local authoring agent
firedrill init --path coding-agent  # canonical skill + repository brief
firedrill init --path template      # complete runnable local example
```

The normal run loop is:

```sh
firedrill validate
firedrill plan
firedrill
firedrill run refund-dispute --trials 3 --seed 42
firedrill run --suite pull-request --concurrency 4
firedrill run refund-dispute --watch
firedrill inspect
firedrill report verify .firedrill/reports/<run-id>
```

`firedrill plan` lists the compiled Tools, drills, targets, and suites before anything runs. Bare `firedrill` runs every drill. `firedrill inspect` opens the offline World, Drills, and Runs workspace for the same repository; it starts real drills, reads their live state and evidence, repeats recorded seeds, and compares verified runs through the public local runtime. See the [quickstart guide](docs/quickstart.md) for the source layout and how to select an agent target.

Keep `firedrill.json`, `firedrill/`, and any test-runner integration in version control. Firedrill keeps generated builds, retained SQLite worlds, reports, and contribution staging under the project-local `.firedrill/` directory. `firedrill init --path ...` ensures that directory is ignored by Git; do not commit it because reports can contain synthetic records and agent output. Copy a specific self-contained HTML report elsewhere only when you intend to share it. `firedrill report verify <report-directory>` checks a received bundle locally; unsigned local reports detect corruption but do not prove authorship.

## Bind an existing agent without changing its logic

Choose the target that matches how the agent already runs:

| Target | Use it when | Firedrill does |
| --- | --- | --- |
| `module` | The agent is callable from local TypeScript or JavaScript | Imports one repository module and calls its exported function |
| `command` | The agent is a CLI or local process | Starts it, sends the task as JSON on stdin, and supplies binding environment variables |
| `http` | The agent application is already running locally | Sends the task to its declared local endpoint |
| `external` | Jest, Vitest, Mocha, or application code owns the agent process | Passes the task and binding to the `runDrills()` callback |

Each target declares `direct`, `http`, `mcp`, or `cli` bindings. Repoint an existing configurable tool/client seam, or put a separate test-only harness around the agent's ordinary entry point. Firedrill does not require imports, conditionals, or per-action test branches in production agent logic. An agent with no configurable or interceptable seam needs an explicit test adapter before it can be bound; Firedrill does not silently rewrite it or call production. A CLI-bound target discovers operations with `firedrill world tools --json` and calls them with `firedrill world call <tool-id> <operation-id> --input '{...}'`.

When the synthetic world must call back into the application under test, a Tool can declare a durable callback driven by one of its events. The repository names an abstract receiver; the CLI or SDK maps it to a local application origin at run time. See [callbacks](docs/callbacks.md) for delivery, signatures, virtual-time retries, evidence, and assertions.

Custom test harnesses can use the high-level [`createLocalWorld()` control API](docs/local-world-control.md) to call Tools, inspect state and pending work, advance virtual time, and reset the complete world or selected Tool packages. A visual client can use the authenticated [`@firedrill/simulation` loopback API](docs/local-simulation-api.md) to compile repository source, start or cancel drills, follow evidence, inspect retained state, and open completed reports. Neither control surface is included in the actor-scoped binding supplied to the agent.

The agent process continues to own its model/provider configuration and secrets. Firedrill supplies only per-trial synthetic-world connection values. A command target may opt into individual host variables with `environmentFromHost`; every unlisted host secret is withheld.

```ts
import { runDrills } from "@firedrill/sdk";

const result = await runDrills({
  drill: "my-drill",
  setup: {
    scenario: {
      state: [
        {
          action: "upsert",
          packageId: "record-store",
          namespace: "records",
          rowId: "primary",
          value: { status: "ready" },
        },
      ],
    },
    bindings: { environment: { RECORDS_BASE_URL: "FIREDRILL_HTTP_URL" } },
  },
  agent: ({ task, binding, signal }) => runMyAgent({ task, binding, signal }),
});

expect(result.verdict).toBe("passed");
```

Setup and source errors throw `FiredrillProjectError`. A completed drill that fails an assertion returns `verdict: "failed"`, so the caller's test runner remains in control.

The optional `setup` is the Jest-like injection surface for one explicit drill. It can layer test-local starting state, actors, virtual time, events, and declared faults; select an installed Tool package; replace a declared Tool's deterministic behavior with a repository module; and project temporary HTTP, MCP, or CLI connection values onto environment names the existing agent already uses. Firedrill compiles the resolved setup into a content-addressed derived build and copies it into the report, so no hidden SQLite mutation or anonymous mock escapes the evidence trail. See the [`@firedrill/sdk` guide](packages/sdk/README.md#per-test-synthetic-data-and-tools) for the complete contract.

For UI-backed agents, the customer's Playwright, browser driver, or application harness still owns the UI and agent lifecycle. The `agent` callback can attach bounded repository-local screenshots, traces, videos, or text files to the portable report. Firedrill hashes and verifies those files, but world consequences remain the verdict authority. See [supporting file evidence](packages/sdk/README.md#supporting-file-evidence).

## Optional Firedrill Agent

The framework does not require an authoring agent. Developers may write source directly or use any coding agent with the canonical skill. Those who want a built-in local path can separately install `@firedrill/agent` and invoke it through the same CLI:

```sh
pnpm add -D @firedrill/cli @firedrill/agent
export ANTHROPIC_API_KEY=your_key
firedrill init --path firedrill-agent
firedrill agent
```

Firedrill Agent uses the Claude Agent SDK with the developer's own Anthropic key. It can inspect and edit ordinary repository files and call the real local formatter, compiler, Tool checks, and drill runner. It cannot read secret files or generated evidence, use a shell, commit, push, publish, or contact a hosted Firedrill service. Repository content selected during the session is sent to Anthropic under Anthropic's applicable terms; no source is sent to Firedrill.

An invocation defaults to at most 40 turns, $2 of model spend, and a 15-minute wall-clock deadline. The CLI exposes explicit overrides for each limit.

## What works now

Repository-owned YAML or JSON plus explicitly selected Tool packages compile into a verified immutable world build. Custom Tool behavior is ordinary TypeScript or JavaScript loaded from the repository; reusable packs are ordinary package dependencies named once in `firedrill.json` or selected for one test through `runDrills({ setup })`. One behavior definition is exposed through the selected direct, generic HTTP, wire-compatible HTTP, MCP, and CLI adapters and mutates the same world state. A wire HTTP route is explicit repository source: method, path, auth placement, body mode, error statuses, and pure request/response codecs around one semantic operation. It is not an automatic claim of complete compatibility with an arbitrary service. Local execution supports a separate isolated SQLite world for every trial and retry, deterministic scenarios and faults, traceable per-run data/Tool/binding setup, module/command/HTTP/caller-owned targets, eight typed assertion kinds, durable callbacks into the application under test, seeded trials, cancellation and timeouts, retained worlds, and verified local reports.

Long-running drills support multiple actors, ordered interactions, virtual-time horizons, scheduled cross-Tool consequences, invariant checkpoints, stop policies, and event budgets. Suites add tags, text filters, deterministic shards, bounded concurrency, retries with distinct attempt identity, and SDK lifecycle hooks. Watch mode reruns through the same path without overlapping work. `firedrill compare` verifies both report bundles first and labels comparisons as exact-input, descriptive-only, or incompatible before showing factual deltas.

The canonical coding-agent playbook lives at [`skills/firedrill/SKILL.md`](skills/firedrill/SKILL.md) and ships byte-for-byte in the CLI package. The root package gate installs every discovered publishable package archive into a clean external consumer, then exercises the installed `init`, validation, execution, protocols, reports, workloads, skill assets, reusable Tool selection, and an unchanged official client against a bounded compatibility pack. A separate packed deterministic acceptance runs nine drills against four independent agent products over MCP, HTTP, and an actual spawned CLI; it proves wiring and world behavior, not model quality. No fixture or vendor behavior is compiled into framework core.

Two boundaries are deliberate. A Tool uses a declarative `*.tool.yaml` or JSON contract plus a behavior module so compilation and source inspection never execute arbitrary code. A local Tool stays in the repository; a reusable Tool ships as an explicitly selected package whose origin and version are locked into the build. Mid-drill resume is not exposed because Firedrill can snapshot its world but cannot generically capture an arbitrary agent process's memory or external side effects.

Tool authors can inspect source without executing it, validate the loaded behavior surface explicitly, and run ordinary conformance drills twice to prove declared coverage and same-seed determinism:

```sh
firedrill tool inspect my-tool
firedrill tool validate my-tool
firedrill tool test my-tool
```

An explicitly authorized `firedrill tool contribute my-tool --accept-apache-2.0` prepares a deterministic local review bundle containing only repository-owned Tool source. It does not upload or submit anything and refuses to repackage an installed dependency. Browse the generated [Tool-pack catalog](registry/README.md) for operation-level fidelity and bounded compatibility profiles, then follow the selected pack's own setup instructions. The neutral [`work-queue`](tool-packs/work-queue/README.md) pack proves the reusable package path; the [`github-issues`](tool-packs/github-issues/README.md) pack proves a narrow unchanged-client path. Neither is evidence of independent community adoption.

Still pre-release: published community Tool packs, CI integrations, hosted composition, and the stable web copy of the coding-agent skill. Internal clean-room first-use and unfamiliar-agent exercises have passed and already produced framework fixes, but they are not evidence of external adoption. Independent developer use and an independently authored community Tool contribution remain acceptance work; the measurable [external adoption study](docs/adoption-study.md) defines that gate. Anonymous telemetry is not sent because no real disclosed collection service exists yet. A capability is not considered available until its public entry point passes an end-to-end gate.

Hosted services are developed separately and are not required by this framework. No npm package or public release exists yet. The non-publishing [release-evidence process](docs/releasing.md) prepares reproducible package archives, checksums, SPDX SBOMs, and public-repository attestations without crossing that boundary.

## Contributing

Node.js 20.19 or newer and pnpm 9.15 through 10 are required.

```sh
pnpm install
pnpm check
```

Read [AGENTS.md](AGENTS.md) before changing public contracts or package boundaries.
