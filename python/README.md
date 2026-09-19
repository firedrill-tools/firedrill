# Firedrill for Python

Firedrill is a simulation and testing framework for AI agents. Give an agent
synthetic tools and data, run its task, and check tool calls, state changes, and
events. Use the CLI, an existing pytest suite, or the Python API.

## Installation

Requires Python 3.10 or later. Install the release candidate:

```sh
python -m pip install --pre "firedrill-run[pytest]"
firedrill --help
```

The distribution is named `firedrill-run`; Python imports use `firedrill`.
The wheel includes the local runtime, CLI, tool protocols, reports, and browser
inspector. You do not need to install Node.js or npm. Tool packages are shared
with the TypeScript version and use the same source definitions and behavior.

For a release wheel supplied as a file, install its exact path instead:

```sh
python -m pip install /path/to/firedrill_run-<version>-<platform>.whl
```

## Try a drill

In an empty directory:

```sh
firedrill init --path template
firedrill validate
firedrill run changes-resource
firedrill inspect
```

The starter agent writes `7` to a synthetic record. Its drill checks that the
operation succeeded once and that the final value is `7`. This is an installation
example; replace its target with your agent when writing your own tests.

To see a failure, change the `value-changed` assertion in
`firedrill/drills/changes-resource.drill.yaml` to expect `8`, leaving the task's
input at `7`. Run the drill again. The report shows expected `8`, actual `7`, and
the command exits with code `1`. Restore the expectation after trying it.

`firedrill inspect` opens the project and saved results. To run synthetic tools
independently of a test, use `firedrill serve`. Both commands keep their local
server running until you press Ctrl+C.

## Add tests to a Python project

Keep the definitions and test code beside your application:

```text
your-project/
  pyproject.toml
  src/your_agent/
  tests/test_agent.py
  firedrill.json
  firedrill/
    world.yaml
    tools/
    scenarios/
    targets/
    drills/
  .firedrill/          # generated state and reports; Git-ignored
```

A **tool** is a synthetic dependency with operations and state. A **scenario**
changes its starting conditions. A **drill** gives the agent a task and declares
what must be true afterwards. A **run** records what actually happened.

Run an existing repository drill from pytest:

```python
from firedrill import run_drills


def test_agent():
    result = run_drills(root=".", drill="changes-resource")
    result.assert_passed()
```

This uses the target declared in source. `assert_passed()` raises an assertion
error with the result and report path when a drill fails. The returned result
also exposes every drill, trial, attempt, assertion, and evidence entry.

### pytest fixtures

The pytest extra registers three fixtures automatically:

| Fixture | Provides |
| --- | --- |
| `firedrill` | A project handle with `run()`, `run_async()`, `world`, and `listen()` |
| `firedrill_world` | An isolated world, closed after the test |
| `firedrill_binding` | An actor's protocol endpoints, closed after the test |

```python
import pytest


def test_drill(firedrill):
    firedrill.run("changes-resource").assert_passed()


@pytest.mark.firedrill(scenario="baseline", actor_id="operator")
def test_initial_data(firedrill_world):
    rows = firedrill_world.state(package_id="resource-store", namespace="records")
    assert rows[0].value["value"] == 0
```

Fixtures find `firedrill.json` above the test file. Select another project with
`pytest --firedrill-root PATH` or `@pytest.mark.firedrill(root="...")`.
Marker world settings apply when the fixture creates a standalone world;
`firedrill.run("id", ...)` executes the drill's declared setup. The marker's
`drill` and `seed` also become defaults for `firedrill.run()`; explicit arguments
take precedence.

### Call an existing Python agent

Use an `external` target when your pytest code owns the agent invocation:

```yaml
schemaVersion: 1
target:
  id: my-agent
  kind: external
  bindings:
    - http
    - mcp
  timeoutMs: 120000
```

Set the drill's `targetId` to `my-agent`. Your callback receives the task and
connection values for that attempt:

```python
from firedrill import run_drills
from your_agent import run_agent


def test_agent():
    def invoke(request):
        return run_agent(
            instruction=request.task.instruction,
            environment=request.binding.environment,
        )

    run_drills(root=".", drill="my-drill", agent=invoke).assert_passed()
```

The `run_agent` call is your test adapter: use the configuration interface your
agent already has. `binding.environment` contains the selected protocol's
`FIREDRILL_HTTP_URL`/`FIREDRILL_HTTP_TOKEN`, `FIREDRILL_MCP_URL`/
`FIREDRILL_MCP_TOKEN`, or CLI equivalents. The callback's process keeps its own
model credentials. You do not need to import Firedrill into production agent code.

Bindings work through existing client configuration or test-side mocks. They do
not automatically redirect arbitrary hardcoded network calls or imported
functions. See [test-side mocking](https://github.com/firedrill-tools/firedrill/blob/main/docs/test-mocking.md).

For asyncio agents:

```python
import asyncio
from firedrill import run_drills_async
from your_agent import run_agent


async def main():
    async def invoke(request):
        return await run_agent(
            instruction=request.task.instruction,
            environment=request.binding.environment,
        )

    result = await run_drills_async(root=".", drill="my-drill", agent=invoke)
    result.assert_passed()


asyncio.run(main())
```

`run_drills` and `run_drills_async` also accept `suite`, `tags`, `filter`,
`shard`, `trials`, `retries`, `concurrency`, `seed`, `build_hash`,
`run_directory`, and `report_directory`. A selected drill can use `setup` to
override its starting data, faults, tool responses, or connection aliases for
that test. The repository's source files remain unchanged.

```python
result = run_drills(
    root=".",
    drill="changes-resource",
    setup={
        "scenario": {
            "state": [{
                "action": "upsert",
                "packageId": "resource-store",
                "namespace": "records",
                "rowId": "primary",
                "value": {"value": 3},
            }],
        },
    },
    trials=3,
    seed="42",
)
result.assert_passed()
```

Python option names use snake_case. Dictionaries containing source definitions
keep their schema keys such as `packageId` and `rowId`.

Pass lifecycle callbacks in `hooks`: `before_all`, `after_all`, `before_drill`,
`after_drill`, `before_trial`, `after_trial`, `attempt_started`, and
`attempt_finished`. Use `callback_receivers` to connect declared synthetic
webhooks to a local application. See [callbacks](https://github.com/firedrill-tools/firedrill/blob/main/docs/callbacks.md) for the
receiver format and delivery behavior.

### Mock Python functions and SDK methods

Use `mock_tool` with the name your agent imports, just as with
`unittest.mock.patch`. Calls run the real synthetic tool behavior and appear in
the drill's evidence:

```python
from firedrill import mock_tool, run_drills
from your_agent import run_agent


def invoke(request):
    with mock_tool(
        "your_agent.write_record",
        request.binding.world,
        package_id="resource-store",
        operation_id="records.set",
        arguments=lambda value: {"value": value},
        idempotency_key="agent-write",
    ) as write_record:
        output = run_agent(request.task.instruction)
        write_record.assert_called_once()
        return output


run_drills(root=".", drill="my-drill", agent=invoke).assert_passed()
```

The external target must declare `bindings: [direct]` for
`request.binding.world`. Patch the lookup site in the agent module; replacing a
different module's already-imported symbol cannot affect it. `mock_tool`
recognizes async functions and returns an awaitable replacement; use
`asynchronous=True` to choose it explicitly.

For provider-specific response or error types, supply `transform`, which
receives the complete operation result. Its default returns the successful
operation value or raises `ToolError` with the declared code and result. You can
also mock against a standalone `World` by supplying `actor_id`.

### Command targets

Use a command target to run a separate process. Firedrill sends one invocation as
JSON on stdin. The command can return one JSON value on stdout; write logs to
stderr. A script with a different input/output contract needs a test-side wrapper.

```python
# tests/run_agent_target.py
import json
import os
import sys
from your_agent import run_agent

request = json.load(sys.stdin)
result = run_agent(
    instruction=request["task"]["instruction"],
    environment=dict(os.environ),
)
json.dump(result, sys.stdout)
```

```yaml
schemaVersion: 1
target:
  id: my-agent
  kind: command
  executable: python
  arguments:
    - tests/run_agent_target.py
  bindings:
    - mcp
  environmentFromHost:
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
  timeoutMs: 120000
```

Run the CLI from the activated Python environment so `python` resolves to your
agent's interpreter. Only explicitly mapped host variables and the protocol
bindings are passed to the command. Select a timeout for the entire agent loop.

## Work with a synthetic environment

```python
from firedrill import World

with World.from_project(".", scenario="baseline", seed="42") as world:
    description = world.describe()
    print([tool.package_id for tool in description.tools])

    with world.listen(actor_id="operator", protocols=["http", "mcp"]) as binding:
        # Configure your agent's existing clients with binding.environment.
        with world.inspect(binding=binding) as inspector:
            print(inspector.url)
            input("Press Enter to stop the environment. ")
```

The example assumes the project declares `baseline` and `operator`. Omit
`scenario` to use the world baseline. Omit `actor_id` only when exactly one actor
exists. Tools with a UI expose their app links in `binding.apps`; browser and API
calls share the same synthetic state. Treat binding URLs and tokens as credentials.

The world API includes:

| Method | Purpose |
| --- | --- |
| `describe()` | Running build, tool contracts, actors, and reset generation |
| `call(actor_id=..., package_id=..., operation_id=..., arguments=...)` | Invoke an operation with the selected actor's grants |
| `state(package_id=..., namespace=..., limit=...)` | Read synthetic records |
| `evidence(from_sequence=..., limit=...)` | Read ordered activity |
| `faults()`, `set_fault(...)` | Inspect and control declared faults |
| `scheduled_events()`, `callbacks()` | Inspect scheduled activity and deliveries |
| `advance_time(to_us)` | Advance virtual time and process due events |
| `reset()` | Restore the full initial world |
| `reset(packages=[...])` | Restore selected tools |
| `export_scenario(...)`, `save_scenario(...)` | Capture current tool data as reusable scenario source |
| `listen(...)`, `inspect(...)` | Start protocol endpoints and the inspector |

A full reset restores the baseline state, clock, randomness, and journal. A
scoped reset retains other tools, global time, and earlier evidence. Existing
binding URLs survive resets. Re-read cursors after `describe().generation`
changes. Saved reports and your agent's own database are unaffected.

Use `AsyncWorld` for asynchronous application code:

```python
from firedrill import AsyncWorld

async def use_world():
    async with await AsyncWorld.from_project(".") as world:
        async with await world.listen() as binding:
            await run_my_agent(binding.environment)
        await world.reset()
```

Worlds, bindings, and inspectors support explicit cleanup and context managers.
Closing a world revokes its listeners. Generated files stay in the project.

## Reports and errors

The central report is `.firedrill/reports/index.html`. Each drill run retains
HTML, JSON, JUnit XML, ordered evidence, a hash manifest, and selected attachments.
Use `result.report_index` to locate the central report from Python.

```python
from firedrill import FiredrillError, run_drills

try:
    result = run_drills(root=".", drill="my-drill")
except FiredrillError as error:
    print(error.code, error.diagnostics)
    raise

result.assert_passed()
```

Source/configuration errors raise `FiredrillError`. Executed drills with failed
assertions return a result; call `assert_passed()` or check `result.verdict`.
Results support dictionary access and snake_case attributes. Source JSON,
operation inputs, environment names, and user data retain their original keys.

```sh
firedrill compare .firedrill/reports/<baseline> .firedrill/reports/<candidate>
firedrill report verify .firedrill/reports/<run-id>
```

Reports verify retained bytes and evidence, not authorship. Seeds reproduce
synthetic inputs; a live model can still choose a different response.

Use the corresponding Python helpers when processing reports in a test suite:

```python
from firedrill import compare_runs, compare_run_details, verify_report

verify_report(".firedrill/reports/<run-id>")
comparison = compare_runs(
    ".firedrill/reports/<baseline>",
    ".firedrill/reports/<candidate>",
)
details = compare_run_details(
    ".firedrill/reports/<baseline>",
    ".firedrill/reports/<candidate>",
    kind="assertions",
    offset=0,
    limit=20,
)
```

`details` is paginated. Available comparison kinds are `assertions`,
`operations`, and `state_changes`. These helpers verify both report bundles
before comparing them.

## Logs, screenshots, and recordings

Capture is opt-in. A callback can attach supporting files from the project:

```python
def invoke(request):
    request.capture.log("Starting agent task")
    result = run_my_agent(request.task, request.binding.environment)
    request.capture.screenshot("test-results/agent.png")
    request.capture.video("test-results/agent.webm")
    request.attach("test-results/trace.zip", media_type="application/zip")
    return result


result = run_drills(
    root=".",
    drill="my-drill",
    agent=invoke,
    capture={
        "logs": "always",
        "screenshots": "retain-on-failure",
        "video": "retain-on-failure",
    },
)
```

Your browser or application harness must create those files first. With an
async callback, await the capture and attachment calls. `capture.register_driver`
also accepts screenshot, video start/stop, and cleanup callbacks for automatic
end-of-attempt capture.

Capture policies are `off`, `always`, and `retain-on-failure`. `attach()` retains
its file independently of those policies. The report copies the files it keeps;
it does not remove your originals. Review captured content before sharing.
Screenshots and recordings supplement the assertions; they do not determine
whether an agent changed the synthetic world correctly.

## Browser tests

Install the matching Chromium browser once:

```sh
firedrill browser install
```

Start your application, then exercise it with saved steps or the Python helper:

```python
from firedrill.browser import run_browser_test

result = run_browser_test(
    {
        "schemaVersion": 1,
        "id": "send-message",
        "startUrl": "http://127.0.0.1:3000",
        "steps": [
            {
                "action": "fill",
                "selector": {"by": "label", "value": "Message"},
                "parameter": "message",
            },
            {
                "action": "click",
                "selector": {"by": "role", "role": "button", "name": "Send"},
            },
        ],
        "assertions": [
            {
                "id": "reply-visible",
                "kind": "visible",
                "selector": {"by": "testId", "value": "reply"},
            },
        ],
    },
    parameters={"message": "Summarize my recent messages"},
    capture={"screenshot": "always", "video": "retain-on-failure"},
)
result.assert_passed()
```

`run_browser_test_async` provides the same flow with asyncio. Pass `headless=False`
to watch. A custom `driver` receives `observe()`, `step()`, and a cancellation
signal. Optional `on_event` and `on_frame` callbacks receive activity and live
previews. Remote application origins require `allow_remote=True` and explicit
`allowed_origins`.

Browser assertions check the application UI. To also check synthetic tool state,
run the browser harness inside a drill's agent callback and configure the
application with that callback's binding. An unasserted flow is `completed`,
not `passed`.

Save reusable definitions with `save_browser_test`, load them with
`load_browser_test`, and list them with `list_browser_tests`. Browser reports
live under `.firedrill/browser/`; use `verify_browser_test_report` and
`bundle_browser_test_report` to verify and export the complete report with
artifacts. `browser_test_definition_from_result` derives replay source only when
the recorded flow remains safe to replay after privacy redaction.

The optional agent extra also enables task-driven browser testing:

```sh
firedrill browser run --url http://127.0.0.1:3000 \
  --task "Send a message and check its reply" --agent --allow-model
```

It uses `ANTHROPIC_API_KEY` from the host process. Add independent assertions to
the saved definition to make the resulting test decide pass or fail.

## Tool packages

```sh
firedrill tool list
firedrill tool search gmail
firedrill tool add @firedrill-tools/gmail --install
firedrill serve
```

Python and TypeScript use the same tool catalog. The CLI acquires packages,
records their versions, and runs them in the bundled local runtime. You do not
install separate Python copies of a synthetic service. Independent packages may
come from npm, Git, or local directories and archives.

```sh
firedrill tool create my-tool
firedrill tool inspect my-tool
firedrill tool validate my-tool
firedrill tool test my-tool
```

Tools use JSON/YAML declarations and JavaScript/TypeScript behavior modules.
Python agents consume their HTTP, MCP, CLI, or test-side function bindings.
Tool code runs with your local permissions. See the
[tool package guide](https://github.com/firedrill-tools/firedrill/blob/main/docs/tool-packages.md)
and [security policy](https://github.com/firedrill-tools/firedrill/blob/main/SECURITY.md).

## Optional authoring agent

```sh
python -m pip install --pre "firedrill-run[agent]"
firedrill init --path firedrill-agent
firedrill agent
```

Set `ANTHROPIC_API_KEY` in the terminal environment before invoking the agent.
The CLI does not load `.env` automatically. The optional agent reads selected
repository content and uses the Claude Agent SDK to author tool definitions and
drills. Review its source changes as you would other generated test code.

To use your own coding agent instead:

```sh
firedrill init --path coding-agent
```

## More guides

- [CLI reference](https://github.com/firedrill-tools/firedrill/blob/main/docs/cli-reference.md)
- [World source and scenarios](https://github.com/firedrill-tools/firedrill/blob/main/docs/world-authoring.md)
- [Tool installation](https://github.com/firedrill-tools/firedrill/blob/main/docs/tool-installation.md)
- [Capture files and browser artifacts](https://github.com/firedrill-tools/firedrill/blob/main/docs/capture.md)
- [Test-side mocking](https://github.com/firedrill-tools/firedrill/blob/main/docs/test-mocking.md)
- [Python capability review](https://github.com/firedrill-tools/firedrill/blob/main/python/PARITY.md)

## License

Apache-2.0. Copyright Reload Tech Inc.
