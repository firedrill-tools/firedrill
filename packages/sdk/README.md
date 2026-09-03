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

## Per-test synthetic data and Tools

Ordinary Jest, Vitest, Mocha, Playwright, or application tests can derive one isolated world without editing the repository-owned baseline:

```ts
const result = await runDrills({
  root: process.cwd(),
  drill: "records-are-updated-once",
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
      faults: [{ packageId: "record-store", faultId: "write-timeout" }],
    },
    tools: {
      behaviorOverrides: [
        { packageId: "record-store", module: "test-support/record-store.behavior.ts" },
      ],
    },
    bindings: {
      environment: {
        RECORDS_BASE_URL: "FIREDRILL_HTTP_URL",
        RECORDS_API_TOKEN: "FIREDRILL_HTTP_TOKEN",
      },
    },
  },
  agent: ({ task, binding, signal }) =>
    runMyAgent({ task, environment: binding.environment, signal }),
});

expect(result.verdict).toBe("passed");
```

`setup.scenario` layers actors, state actions, faults, initial events, and optional virtual time after the drill's declared scenario. A later `upsert` for the same Tool namespace and row becomes that trial's starting value. `setup.tools.packages` selects an installed reusable Tool for this run; `behaviorOverrides` points to a repository-relative deterministic module that must implement the already-declared Tool manifest. Firedrill does not accept anonymous mock functions because an invisible closure cannot be hashed, reported, or reproduced.

`setup.bindings.environment` maps the configuration names an existing agent already consumes to invocation-scoped Firedrill HTTP, MCP, or CLI values. A command target receives the projected variables automatically. A caller-owned target passes `binding.environment` into its existing configuration seam. The canonical `FIREDRILL_*` values remain available, and an unavailable protocol mapping fails before the agent starts.

A setup requires one explicit `drill`. Firedrill normalizes it, creates a derived content-addressed build, records the complete setup and hash in every report, and leaves authored files unchanged. Reproduce it with the report's exact `--build-hash`; do not pass `setup` again when loading that immutable build.

Use `suite`, `tags`, `filter`, and `shard` for deterministic selection; `trials`, `retries`, and `concurrency` bound local work. Lifecycle hooks exist at suite, drill, and trial boundaries and never replace the customer's test runner. `verifyReport()` verifies one portable local bundle; `compareRuns()` verifies two and returns an explicit compatibility grade before factual deltas.

Use `callbackReceivers` when the world must send an asynchronous request into the local application under test. Each key is the abstract receiver id declared by Tool source; each value supplies a loopback `baseUrl` and, only when required, an HMAC `secret`. The same mapping is available non-interactively in the CLI. See the repository [callback guide](../../docs/callbacks.md).

`binding.environment` contains only the connection values for the target's declared HTTP, MCP, or CLI binding plus its declared aliases. `binding.world` exists only for a declared direct binding. A caller-owned test harness should pass these values into an existing client/tool configuration seam; production agent logic should not import Firedrill or add invocation-specific branches. The callback's owning process keeps its normal model/provider credentials; do not copy them into the Firedrill binding. Spawned command targets receive only synthetic binding values plus host variables explicitly named by their `environmentFromHost` mapping.

Callback output may be any ordinary JSON-serializable value; optional `undefined` object properties are omitted just as they are over HTTP or stdout. It is retained as target evidence but does not replace state and operation assertions.

Setup and source problems reject with `FiredrillProjectError`, including stable code, details, and compiler diagnostics. A successful source build returns any non-error compiler diagnostics on `result.diagnostics`; an exact `buildHash` run returns none because it does not recompile source. A drill that executes and fails assertions resolves normally with `verdict: "failed"`, leaving Jest, Vitest, Mocha, or application code in control.

Tool authors and consumers use `inspectTool()` to inspect a selected repository or installed-package contract without executing behavior. `validateTool()` explicitly loads the selected behavior with the developer's local authority. `testTool()` runs a selected repository conformance suite twice and returns ordinary verified drill reports plus operation/error/event/fault/subscription/callback coverage and same-seed state/trajectory reproducibility.

`prepareToolContribution()` is limited to Tool source owned by the current repository. It requires an explicit Apache-2.0/source-rights/customer-data attestation, successful conformance, and a clean source scan. It writes a new local review bundle and never overwrites, uploads, or opens a pull request.

Each returned trial includes the sealed result, ordered evidence, retained SQLite path, and terminal/JSON/JSONL/JUnit/HTML report locations. By default they stay under `<project>/.firedrill/`, which should remain Git-ignored because evidence may contain synthetic records and agent output. No account or hosted service is involved. Lower-level packages remain public for custom composition, but ordinary test code should start here.

For a custom harness or debugger, `createLocalWorld()` creates one retained world from a drill scenario without starting the agent. The returned handle can call a Tool as a declared actor, inspect state and causal evidence, advance virtual time, and restore either the whole initial world or selected Tool packages. Whole-world reset restores clock and deterministic randomness; scoped reset deliberately preserves global time, prior evidence, and unselected Tool state. Reset is control authority and is never passed to the agent. See [local world control](../../docs/local-world-control.md).
