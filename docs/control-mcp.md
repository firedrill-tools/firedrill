# Use Firedrill from your coding agent

The Firedrill MCP server lets a coding agent inspect your test definitions, start fake Tools, examine their state, and run a drill without remembering shell commands. It uses the same compiler and SDK as the CLI. No account or model key is needed to start this server.

This is **not** the synthetic Tool MCP endpoint your application connects to. The control server is for the coding agent writing your tests; `firedrill serve` exposes your fake Tools to the agent being tested.

## Connect

Install the Firedrill CLI using the project's [quickstart](quickstart.md). Add a stdio MCP server in your coding agent's MCP settings:

```json
{
  "command": "firedrill",
  "args": ["mcp", "--root", "/absolute/path/to/your/project"]
}
```

Your coding agent controls the surrounding configuration format. The command above does not write its configuration, install dependencies, or edit your application.

Initially the server can validate and inspect source and browse the bundled Tool catalog. Ask your coding agent: **“Inspect this project's Firedrill setup and tell me what is missing before we run it.”**

To allow local execution, add `--allow-execution`:

```json
{
  "command": "firedrill",
  "args": ["mcp", "--root", "/absolute/path/to/your/project", "--allow-execution"]
}
```

Only enable this for a repository you trust. Tool behavior and declared drill targets are local code, not sandboxed code. Targets may launch subprocesses, read their declared environment variables, call model providers, and incur charges. Your coding agent's tool-approval policy still applies. Do not put secret values in MCP command arguments.

## Try a fake Tool

Ask your coding agent: **“Start this project's synthetic environment. Find the Tool's operation contract, call it with test input, and show me what changed. Do not run my application yet.”**

The server provides these operations:

| Step | MCP tool | What it does |
| --- | --- | --- |
| Understand the project | `project_plan`, `project_inspect` | Counts and paginated definitions: world, Tools, scenarios, targets, drills, suites. |
| Check source | `project_validate`, `tool_inspect` | Compiler diagnostics and Tool contracts without executing behavior. |
| Find reusable Tools | `tool_catalog` | Search the bundled catalog and stated limitations. No automatic install. |
| Start | `environment_start` | Use the baseline, a named scenario, or a drill's setup. Starts local HTTP, MCP, and CLI endpoints. |
| Check connections | `environment_list`, `environment_status` | World, seed, build, actor, and reset generation. No access tokens. |
| Connect your application | `environment_connect` | Explicitly return loopback URLs and actor-scoped tokens/environment variables. |
| Discover operations | `environment_tools` | Running Tool contracts, state namespaces, and available faults. |
| Try an operation | `environment_call` | Invoke a fake operation as the selected actor. May change synthetic state. |
| See what happened | `environment_state`, `environment_evidence` | Paginated state and ordered activity. |
| Reuse the data | `environment_export_scenario`, `environment_save_scenario` | Preview Tool data, then explicitly save it as a new scenario without overwriting source. |
| Change conditions | `environment_set_fault`, `environment_advance_time` | Toggle a declared fault or advance virtual time. |
| Start over | `environment_reset` | Reset the complete world or selected Tool packages; requires `confirm: true`. |
| Finish | `environment_close` | Revoke endpoints and close the environment. |

Local execution operations are absent when `--allow-execution` is not set. A direct attempt to call them is rejected; source-only inspection cannot start a world.

Saving a scenario requires `confirm: true` and the preview's `sourceHash` and `generation`. It captures Tool records and deletions relative to the repository baseline, not an entire running checkpoint. Actors, clock, active faults, pending work, and history are not captured. The preview lists these omissions. The saved scenario can start a new environment; saving it does not change the current environment.

`environment_connect` returns sensitive access details deliberately. Use them in a test-only process or test harness. Never commit them or replace your production configuration. Multiple open environments are isolated from one another. Their connection credentials remain valid through resets, but previously read state/evidence pagination cursors must be restarted after the generation changes.

## Run your actual agent

Ask: **“Run the `my-drill` drill and show me its result and local report. Do not change the expectation to make a failure pass.”**

`drill_run` launches the target declared in the repository and writes reports under `.firedrill/`. It returns the verdict, build, seeds, run identifiers, and local report locations. A failing assertion is a completed drill with a failed verdict, not a broken MCP connection. You can request up to ten trials of one drill; the default is one. Requests have a two-minute execution deadline by default, adjustable up to ten minutes.

Calling `environment_call` manually only demonstrates a fake Tool's behavior. It does **not** prove your application used that Tool. Use `drill_run` for evidence from a declared target. Targets requiring an in-process `runDrills({ agent })` callback remain SDK-driven; the MCP server does not invent a callback or bypass that requirement.

## Limits and cleanup

- One server is scoped to one project root. Tool requests cannot choose arbitrary project roots or read arbitrary files.
- At most four environments may stay open; close one before starting another. Each environment uses the SDK's normal operation budget.
- List pages contain up to 100 items. Messages/results are limited to 1 MB; oversized results return an actionable error instead of incomplete JSON.
- Requests are serialized so a reset cannot overlap another control operation. Disconnecting or interrupting the server cancels a running drill and closes its owned listeners and SQLite handles.
- Saved reports and world artifacts remain in the project's ignored `.firedrill/` directory. This server does not delete them or upload them.
- stdout carries MCP messages only. Keep subprocess logs on stderr; never print credentials. This local server does not provide remote authentication or a hosted API.
