# `@firedrill/sdk`

The repository-level TypeScript API for Firedrill's complete local loop. It compiles source, creates an isolated world per trial, invokes the declared agent target, evaluates consequences, and writes and verifies every report format.

```ts
import { runDrills } from "@firedrill/sdk";

const result = await runDrills({
  root: process.cwd(),
  drill: "my-drill",
  agent: async ({ task, binding, signal }) => {
    return runMyAgent({ task, binding, signal });
  },
});

if (result.verdict !== "passed") throw new Error("agent drill failed");
```

The `agent` callback is used only by a target declared with `kind: external`. Module, command, and local HTTP targets launch from repository source and do not need it. Omit `drill` to run every repository drill.

Use `suite`, `tags`, `filter`, and `shard` for deterministic selection; `trials`, `retries`, and `concurrency` bound local work. Lifecycle hooks exist at suite, drill, and trial boundaries and never replace the customer's test runner. `verifyReport()` verifies one portable local bundle; `compareRuns()` verifies two and returns an explicit compatibility grade before factual deltas.

`binding.environment` contains only the connection values for the target's declared HTTP or MCP binding. `binding.world` exists only for a declared direct binding. Adapt these values at the agent's existing client/tool composition seam rather than adding Firedrill branches to each action. The callback's owning process keeps its normal model/provider credentials; do not copy them into the Firedrill binding. Spawned command targets receive only host variables explicitly named by their `environmentFromHost` mapping.

Callback output may be any ordinary JSON-serializable value; optional `undefined` object properties are omitted just as they are over HTTP or stdout. It is retained as target evidence but does not replace state and operation assertions.

Setup and source problems reject with `FiredrillProjectError`, including stable code, details, and compiler diagnostics. A successful source build returns any non-error compiler diagnostics on `result.diagnostics`; an exact `buildHash` run returns none because it does not recompile source. A drill that executes and fails assertions resolves normally with `verdict: "failed"`, leaving Jest, Vitest, Mocha, or application code in control.

Tool authors and consumers use `inspectTool()` to inspect a selected repository or installed-package contract without executing behavior. `validateTool()` explicitly loads the selected behavior with the developer's local authority. `testTool()` runs a selected repository conformance suite twice and returns ordinary verified drill reports plus operation/error/event/fault/subscription coverage and same-seed state/trajectory reproducibility.

`prepareToolContribution()` is limited to Tool source owned by the current repository. It requires an explicit Apache-2.0/source-rights/customer-data attestation, successful conformance, and a clean source scan. It writes a new local review bundle and never overwrites, uploads, or opens a pull request.

Each returned trial includes the sealed result, ordered evidence, retained SQLite path, and terminal/JSON/JSONL/JUnit/HTML report locations. By default they stay under `<project>/.firedrill/`, which should remain Git-ignored because evidence may contain synthetic records and agent output. No account or hosted service is involved. Lower-level packages remain public for custom composition, but ordinary test code should start here.
