# Run a drill and understand the result

[Developer guide](README.md) · [Source files](world-authoring.md)

A drill runs a task against a controlled world. Your existing agent chooses its
actions; Firedrill records the consequences and evaluates the checks you wrote.
The same path handles a short test or a longer sequence of interactions.

## Start from the project folder

```sh
firedrill validate
firedrill plan
firedrill run my-drill
firedrill inspect
```

`validate` checks the authored setup. `plan` lists what was discovered without
running the agent. `run` executes a selected drill. Bare `firedrill` runs all
drills. `inspect` starts the local inspector for this project.

If you own the agent lifecycle in a test file, use `runDrills()` from
`@firedrill-run/sdk` instead. Targets declared `external` need its `agent` callback;
the CLI and inspector cannot create that JavaScript callback for you. Module,
command, and HTTP targets have their launch configuration in repository files.

## What a check proves

Write checks about consequences instead of trusting the agent's success message.
The [quickstart](../examples/quickstart/firedrill/drills/set-record.drill.yaml)
requires both one successful write and the expected final record value.

| Check kind | Question it answers |
| --- | --- |
| `state.value` | Does this record field have the expected value? |
| `state.count` | Is the expected number of records present? |
| `operation.count` | How often did an operation run with these outcomes? |
| `operation.order` | Did the required operations occur in the correct order? |
| `operation.arguments` | Did a call contain the expected arguments? |
| `operation.denied` | Was a forbidden operation denied? |
| `event.count` | Did the expected world event occur? |
| `callback.count` | Did the expected callback delivery outcome occur? |

These are typed assertions in the drill, not prose the framework guesses at.
Validation reports unsupported fields. Your ordinary test runner can add its own
checks around the returned SDK result.

## Find the result

The terminal prints the selected result and report locations. By default:

```text
.firedrill/
  builds/                   # Pinned compiled inputs for reproduction
  runs/                     # Retained per-attempt world databases
  reports/
    index.html              # Start here: all saved reports
    <run-id>/
      index.html            # One attempt's readable report
      report.json           # Machine-readable report
      junit.xml             # CI/test-runner import
      run.json              # Recorded result
      evidence.jsonl        # Ordered world activity
      manifest.json         # Bundle integrity metadata
      attachments/          # Optional retained files
```

The CLI and SDK let you change the run/report directories. The separate
`createLocalWorld()` control API defaults to `.firedrill/worlds/`. These are all
generated files, not authored test definitions.

Open the central `index.html` to browse recorded attempts without a running
server. Keep the index and its run folders together when sharing a collection.
An individual report remains readable offline; keep its attachment folder with
it for screenshots, videos, and downloads. The inspector's **Open report** can
embed its verified attachments in the opened copy.

## Read a failing report in this order

1. **Task and result**: what the agent was asked to do, and whether execution
   completed normally.
2. **Failed checks**: expected and actual values, with the relevant record or
   operation. A failed world check is not overturned by a successful-looking reply.
3. **Tool activity and changes**: what was called, what returned, and which data
   changed. Follow the order to understand the cause.
4. **Attachments**: supporting logs, screenshots, and recordings if your harness
   captured them. Missing capture is shown as unavailable, not as passing evidence.

A source error, agent timeout, failed assertion, and inconclusive check are
different outcomes. Read the error or individual check rather than assuming
every non-passing run is a model-quality failure. CLI exit `0` means the selection
passed, `1` means source/execution/check failure, and `2` means invalid CLI usage.

## Use the inspector

The world pages explain the compiled setup: schemas, fake data, identities,
scenarios, and tools. Tool **Implementation** shows the behavior module, separate
from its declaration. This is the source captured at compile/refresh, not a claim
that it is the original code of every historical run.

**Drills** explains the task and checks to execute. **Results** shows saved execution
results; opening an exact run preserves that identity. A scenario's **Runs** links
use the scenario recorded with the result, even if source changed later. Use run
state to inspect the retained outcome, not the current scenario's starting data.

## Repeat, compare, and simulate longer

```sh
firedrill run my-drill --trials 3 --seed 42
firedrill run --suite smoke --concurrency 4
firedrill compare .firedrill/reports/<baseline> .firedrill/reports/<candidate>
firedrill report verify .firedrill/reports/<run-id>
```

A trial repeats a drill; a retry is another attempt of that trial. Each attempt
has its own world and report. The report's reproduce command pins the build and
seed. Keep that local build available. It repeats the world inputs, not arbitrary
LLM output, browser state, provider behavior, or unrecorded test-harness actions.

Comparison first tells you whether the inputs match. Changed inputs make the
diff descriptive; they do not by themselves prove a regression. Verification
detects bundle corruption; local unsigned reports do not prove authorship.

For longer simulations, use a drill timeline with explicit interactions,
checkpoints, a virtual-time horizon, and budgets. For custom control between
actions, use [world controls](local-world-control.md). Your harness still owns
external agent processes, browser sessions, and their real-time limits.

## CI and common first-use problems

Run the same CLI command or SDK test in CI, retain the report directory, and
upload `junit.xml` with your CI system's ordinary test-results integration.
Do not introduce a second test definition just for CI. Pass model credentials
through the agent's normal secret mechanism, not authored world files.

- **No drills found**: check `firedrill.json`, `sourceRoot`, resource suffixes, and
  `firedrill plan`.
- **External handler required**: run the test file that supplies `agent`, or
  declare a runnable module/command/HTTP target.
- **No tool activity**: verify the agent received the test binding at its real
  tool/client seam. A final message is not proof it used the synthetic world.
- **Agent timeout**: budget for the complete model/tool loop, not one request.
- **Report cannot be verified**: keep the bundle's files together; do not edit
  saved JSON or assume an incomplete report is valid.
- **Capture unavailable**: check the capture error and file/driver limits in
  [the capture guide](capture.md).
