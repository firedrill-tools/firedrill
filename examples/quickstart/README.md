# Firedrill quickstart

This deliberately small fixture teaches the product loop without representing a required agent architecture:

1. `world.yaml` names the synthetic world and the agent's permissions.
2. `workspace.tool.yaml` and `workspace.js` define one stateful Tool operation.
3. `empty.scenario.yaml` defines the starting state.
4. `local-agent.target.yaml` tells Firedrill how to start this existing agent process and bind it over HTTP.
5. `set-record.drill.yaml` gives the agent a task and verifies the resulting tool call and world state.
6. `workspace-conformance.suite.yaml` reuses that drill to test the Tool contract and reproducibility.

From this directory, run:

```sh
firedrill validate
firedrill
firedrill tool test workspace
```

The drill passes and the terminal prints the path to a self-contained HTML report. To see a useful failure, change the final expected `value` in `set-record.drill.yaml` from `7` to `8` and run `firedrill` again.

Firedrill keeps the retained SQLite worlds and generated reports for this project under `.firedrill/`. Keep the source in this directory in version control; keep `.firedrill/` ignored because its generated evidence may contain synthetic test records and agent output.

Real projects replace every sample name and behavior here. Firedrill's engine does not know about `workspace`, `records.set`, or this agent process.
