# Firedrill quickstart

This small example shows one complete loop: give an agent a task, let it change a synthetic record, and check what changed. `agent.mjs` is a deterministic HTTP client, not an LLM-backed agent; replace it with your own agent when you are ready.

## Where things live

```text
agent.mjs                                  # the agent being tested
firedrill.json                             # where to find the world source
firedrill/                                 # test definitions; commit these
  world.yaml                              # the world and agent permissions
  tools/workspace/
    workspace.tool.yaml                   # operation and record schemas, HTTP route
    behavior.js                           # what the fake Tool does to records
  scenarios/empty.scenario.yaml            # starting records and conditions
  targets/local-agent.target.yaml          # how to invoke the existing agent
  drills/set-record.drill.yaml             # task and assertions (the test)
  suites/workspace-conformance.suite.yaml  # groups drills to check the Tool
.firedrill/                                # generated databases and reports; ignore
```

This is a recommended layout, not a required one. Firedrill discovers resource files recursively beneath the configured `sourceRoot`. Use descriptive kebab-case filenames with the resource suffix (`.tool.yaml`, `.scenario.yaml`, `.target.yaml`, `.drill.yaml`, `.suite.yaml`); JSON and YML are also supported. Resource references use in-file IDs, not folder names. A display-title change does not require renaming the file.

Keep a Tool's declaration and behavior module together. Tool `module` paths are relative to the declaration. A target's `workingDirectory` is repository-relative; command arguments resolve within that working directory, not the target file's folder.

Earlier flat copies remain valid; no migration is required. Do not rerun `init` merely to adopt these folders. If you reorganize a project, preserve resource IDs, update relative module or configured world paths where needed, and run `firedrill validate`.

## Run and read the result

`firedrill plan` shows the declared `PUT /api/records/{recordId}` route before any Tool behavior runs.

From this directory, run:

```sh
firedrill validate
firedrill
firedrill tool test workspace
```

The drill asks the agent to set a record to `7`. It checks that the operation succeeded once and that the stored record equals `7`. The terminal prints the path to a self-contained HTML report. To see a useful failure, change only the final assertion's expected `value` in `firedrill/drills/set-record.drill.yaml` from `7` to `8` and run `firedrill` again. Keep `task.input.value` at `7`, then restore the assertion after reviewing the failure.

Firedrill keeps the retained SQLite worlds and generated reports for this project under `.firedrill/`. Keep the source in version control; keep `.firedrill/` ignored because its generated evidence may contain synthetic test records and agent output. Running a drill changes its isolated SQLite world, not the YAML starting data.

Real projects replace every sample name and behavior here. Firedrill's engine does not know about `workspace`, `records.set`, or this agent process.
