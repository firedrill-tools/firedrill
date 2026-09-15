# Your world and test files

[Developer guide](README.md) · [Quickstart](quickstart.md)

Keep Firedrill's setup beside the project being tested. Production agent logic
does not need Firedrill imports or a second implementation of every action.
Configuration and test-only adapters connect the existing agent to fake tools.

## A small, organized project

```text
my-agent/
  src/                             # Your existing agent; unchanged
  tests/                           # Optional Jest/Vitest/browser test harness
  firedrill.json                   # Points to the source folder and world file
  firedrill/
    world.yaml                     # Shared identities and starting conditions
    tools/workspace/
      workspace.tool.yaml          # Inputs, outputs, record schemas, operations
      behavior.js                  # What those operations actually do
    scenarios/empty.scenario.yaml  # Starting data or a failure variation
    targets/local-agent.target.yaml
    drills/set-record.drill.yaml   # Task and assertions
    suites/smoke.suite.yaml         # Optional selection of drills
  .firedrill/                      # Generated output; ignored by Git
```

This is a recommended layout, not a mandatory directory structure. Configure
`sourceRoot` and `world` in `firedrill.json`. Resource files are discovered
recursively by their `.tool`, `.scenario`, `.target`, `.drill`, and `.suite` suffixes.
References use stable IDs inside the files, not their display titles.

Use JSON for every resource if that is easier for you or your coding agent.
YAML/YML is an equivalent authoring choice; you do not need to mix formats.
Executable behavior remains JavaScript or TypeScript. Markdown can explain the
setup, but arbitrary prose is not an executable world definition.

The [complete quickstart files](../examples/quickstart) are the smallest runnable
example. They deliberately use a simple deterministic client to teach the format;
passing that example is not evidence about an LLM's quality.

## Tools: declaration and implementation

A tool has two parts:

- **Declaration**: the operation names, input/output shapes, record schemas,
  permissions needed, and any declared errors, events, faults, or HTTP routes.
- **Implementation**: the function that reads or updates fake state and returns
  the response. This is where a simulated action's consequences are written.

In the quickstart, [`workspace.tool.yaml`](../examples/quickstart/firedrill/tools/workspace/workspace.tool.yaml)
declares `records.set`. [`behavior.js`](../examples/quickstart/firedrill/tools/workspace/behavior.js)
stores the requested value and returns it. The compiler does not invent this
implementation from a name or description.

An operation can be reached through direct functions, HTTP, MCP, or Firedrill's
CLI adapter. Those interfaces reach the same implementation and state. Custom
HTTP routes can reproduce a particular request shape; they are not automatically
generated replicas of every external API. Use your normal test runner's mocks
for existing imported functions and SDK methods: [mocking guide](test-mocking.md).

You or a coding agent can write a tool, or select an installed reusable package.
Keep tool-specific behavior in that tool, not in the framework. Tools are trusted
local test code, not sandboxed code from an arbitrary stranger.

## Schema and fake data

The tool's declared state namespaces define record schemas. The world and
scenarios supply records matching them. There is no required second schema
database to maintain.

For example, the quickstart's `records` namespace requires an integer `value`.
Its `empty` scenario puts a record named `primary` there with value `0`. Calling
the fake operation changes that record to `7`.

At execution time, Firedrill materializes the selected starting conditions into
one isolated SQLite world per attempt. All tools in that world share the same
state, clock, pending events, and ordered activity journal. SQLite is Firedrill's
storage for the synthetic surroundings—not a replacement for the agent's own
Postgres, MongoDB, filesystem, or other internal storage.

Runtime changes never rewrite your source files. Editing source changes future
builds; it does not overwrite a retained run. A whole-world reset restores the
initial state of that world. A scoped reset affects selected tools and deliberately
preserves global time and prior evidence. [Exact reset behavior](local-world-control.md#reset-semantics).

## People and permissions

An **actor** is an identity that can perform granted tool operations. Define it
in the world or a scenario, then select it in a drill or timeline interaction.
Its optional short `description` helps a reader understand the role.

**Persona attributes** describe that identity—for example, experience or customer
tier. Attributes do not grant access, run a model, or automatically change the
agent's prompt. Use explicit grants for permissions, and explicitly pass any
needed context through your task or test adapter.

Data records for customers or users are different: they are records the tools
return or mutate. A customer record does not need to be a runtime actor unless
that customer will actually perform actions in the drill.

You can keep one actor and omit persona details for a simple test. When a scenario
replaces an actor with the same ID, it replaces the complete actor; repeat the
description and permissions that should remain.

## Scenarios, targets, and drills

A **scenario** changes starting data, identities, declared faults, pending events,
time, or tool overrides. It can be reused by several drills. It does not itself
start your agent.

A **target** tells Firedrill how to reach the agent: import a repository module,
start a command, call a local HTTP endpoint, or invoke a callback owned by the
test harness. It also declares the tool interfaces the agent may receive.
An external callback target needs `runDrills({ agent })`; the CLI cannot invent
that callback. [Connection options](quickstart.md#3-keep-the-agent-integration-at-one-seam).

A **drill** selects a target, scenario, and actor, supplies the task, and states
what must be true afterward. The [quickstart drill](../examples/quickstart/firedrill/drills/set-record.drill.yaml)
checks both that the action happened once and that the stored value is correct.
The returned message alone cannot satisfy those checks.

Longer drills can schedule multiple interactions and actors over virtual time,
with checkpoints, stop policies, and budgets. They use the same tool behavior
and result format as a short test. Advancing the world's clock does not speed
up a remote model or change the operating system's clock.

## What to commit

Commit the configuration, world resources, behavior modules, and test adapters.
Keep generated builds, SQLite files, captures, and reports under `.firedrill/`
and out of Git. `firedrill init --path ...` adds that ignore rule. Keep provider
keys in your normal ignored environment or secret store, never in source or
captured logs. Share report files deliberately: they can contain agent output
and test data.
