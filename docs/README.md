# Using Firedrill

Firedrill lets you run your existing AI agent against controlled tools and data,
then check what it actually changed. Your agent still chooses its actions. Your
test defines the surroundings and what a correct outcome looks like.

Start with the tools your agent needs. Try their behavior and data before adding
tests. You do not need to describe your entire company, copy your agent's internal
database, or learn every concept before the first useful call.

## Start here

1. [Start local tools](local-environment.md): select or create tools, open their
   live workspace, and connect your agent. Or [try a complete drill](quickstart.md)
   to see a passing and failing test first.
2. [Understand your files](world-authoring.md): where tools, fake data, scenarios,
   agent connections, and checks live.
3. [Connect an existing agent](quickstart.md#3-keep-the-agent-integration-at-one-seam):
   use its existing function, process, HTTP endpoint, or test harness.
4. [Read results](running-and-results.md): run a drill, find the report, and inspect
   the exact actions, checks, and resulting data.
5. [Add optional capture](capture.md): readable logs, screenshots, and recordings,
   including retention only when an attempt fails.

## The vocabulary, in plain English

| Name | What you define or get |
| --- | --- |
| World | The controlled surroundings: available tools, starting data, identities, permissions, and time. |
| Tool | An action the agent can take, with inputs, outputs, and an implementation of its fake consequences. It need not be HTTP. |
| Scenario | A variation of the starting conditions, such as an empty account or a tool returning an error. |
| Target | How the test reaches the agent you already have. This is test configuration, not a new agent. |
| Drill | A task for the agent plus checks on the outcome. Running it is an agent simulation. |
| Run | The saved result of an execution attempt: checks, activity, changed data, and optional attachments. |

A persona describes who an identity represents; an actor is the identity making
actions with specific permissions. Neither automatically creates a simulated
human or another LLM. [See the distinction](world-authoring.md#people-and-permissions).

## Choose what you need next

| I want to… | Read |
| --- | --- |
| Start fake tools without writing a test yet | [Local environment](local-environment.md) |
| Use Jest, Vitest, Mocha, or my own script | [TypeScript SDK](../packages/sdk/README.md) |
| Replace an imported function or SDK method only in a test | [Test-side mocks and overrides](test-mocking.md) |
| Change fake data or a tool response for one test | [Per-test setup](../packages/sdk/README.md#per-test-synthetic-data-and-tools) |
| Call tools, inspect state, advance time, or reset | [Local world control](local-world-control.md) |
| Send synthetic webhooks into my application | [Callbacks](callbacks.md) |
| Find an exact CLI flag or machine-readable command | [CLI reference](cli-reference.md) |
| Build a custom viewer or client | [Local simulation API](local-simulation-api.md) |
| Reuse an existing tool implementation | [Tool catalog](../registry/README.md) |
| Let a coding agent set this up | [Authoring-agent workflow](quickstart.md#5-let-an-authoring-agent-iterate-to-green) |
| Understand version and report compatibility | [Compatibility](compatibility.md) |

The individual-developer loop is local and needs no Firedrill account. An agent
that uses a model still needs its own provider setup. A seeded synthetic world
does not make live model output deterministic.

Packages are currently an unpublished release candidate. The
[root README](../README.md#try-the-complete-local-loop) gives working source-checkout
commands; do not assume an npm release is available.
