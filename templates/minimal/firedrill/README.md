# Your Firedrill source

These files define a synthetic world and one drill: a task for the agent plus checks of what it actually did. This starter asks a small example agent to set a record to `7` and verifies the result.

```text
firedrill.json                              # project configuration
firedrill/
  world.yaml                               # world identity and agent permissions
  tools/resource-store/
    resource-store.tool.yaml               # operations and record schemas
    behavior.mjs                           # how fake Tool calls change records
  scenarios/baseline.scenario.yaml          # starting data and conditions
  targets/starter-agent.target.yaml         # how to invoke the example agent
  drills/changes-resource.drill.yaml        # the task and its assertions
  suites/resource-store-conformance.suite.yaml  # drills that check this Tool
firedrill-example/agent.mjs                 # example agent, separate from world source
.firedrill/                                 # generated output, not source
```

Run `firedrill validate`, then `firedrill run changes-resource`. Read the result at the HTML report path printed by the command. `firedrill inspect` opens this project's world and recorded results.

The example agent is a deterministic HTTP client, not an LLM. Replace its target with your existing agent's entry point; there is no required agent language or framework. The Tool's behavior is fake external-service code, not a replacement for your agent's own application database.

## Keep the distinction clear

- **Schema:** `tools/resource-store/resource-store.tool.yaml` declares the shape of records, inputs and outputs.
- **Starting data:** `scenarios/baseline.scenario.yaml` seeds a record with value `0`. Shared starting data may also live in `world.yaml`.
- **Test:** `drills/changes-resource.drill.yaml` requests value `7` and checks one successful operation and the final record value.
- **Execution:** Firedrill runs the target and fake Tool, maintains the isolated SQLite world, and evaluates the assertions. Running never writes new records back into these source files.
- **Results:** `.firedrill/` contains generated databases, evidence and reports. Keep it ignored; commit the configuration, definitions and agent/test code instead.

## Naming is a convention, not a restriction

We group examples into `tools/`, `scenarios/`, `targets/`, `drills/` and `suites/` to make their purpose easy to find. You may organize your own source differently. Set `sourceRoot` and `world` in `firedrill.json` to choose the source folder and world file; resource files are discovered recursively.

Prefer descriptive kebab-case names such as `duplicate-action.drill.yaml`. Keep the resource suffix: `.tool`, `.scenario`, `.target`, `.drill` or `.suite`, followed by `.yaml`, `.yml` or `.json`. References use stable in-file IDs; changing a title does not require moving a file. A Tool's `module` path is relative to its declaration. Targets refer to the agent from the repository, not from the `targets/` folder.
