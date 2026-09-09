# `@firedrill/sdk`

The repository-level TypeScript API for Firedrill's complete local loop. Start synthetic Tools and baseline data with `createLocalWorld()`; run actual agent tests with `runDrills()`. Both use the same world runtime. The testing API creates an isolated world per trial, invokes the declared agent target, evaluates consequences, and writes and verifies every report format.

## Run a standalone synthetic environment

No scenario, drill, target, or agent is required:

```ts
import { createLocalWorld } from "@firedrill/sdk";

const world = await createLocalWorld({ root: process.cwd() });
const binding = await world.listen({ actorId: "operator", protocols: ["http", "mcp"] });
try {
  await useExistingClient(binding.environment);
} finally {
  await binding.close();
  world.close();
}
```

The repository must declare the selected actor and its operation grants. Omit `actorId` only when exactly one actor exists. `listen()` defaults to HTTP, MCP, and Firedrill CLI on available loopback ports; use `httpPort`, `mcpPort`, or `cliPort` to choose a selected protocol's port. Connection tokens stay local and private. Firedrill starts the synthetic interfaces, not the agent, and never falls back to production.

Tools that declare optional browser assets also start automatically, including when `protocols` selects only MCP. `binding.apps` is a readonly array of `{ packageId, title, url }`; backend-only Tools add no app. Open an app's URL in a browser to interact with that same SQLite world as the selected actor. Each app has a separate ephemeral loopback origin and its own package-scoped token. Treat the URL as a local credential: pass it only to the intended browser/test client, not a report or public log. It never contains the generic protocol or inspector token.

Apps can invoke only their own Tool's declared operations, with existing grants, validation, idempotency and evidence enforced by the kernel. They cannot inspect the database, reset the world, change actors, or invoke another Tool directly. App links survive resets and close with their binding or world. These are trusted local package assets, not a sandbox for untrusted code; remote scripts and network connections are blocked by the default browser policy. Tool authors use the [same-origin browser module](../protocol-http/README.md#optional-tool-apps), not inspector APIs.

`runDrills` also exposes `binding.apps` to its target callback, with fresh app listeners for each interaction. Command targets receive their array in `FIREDRILL_TOOL_APPS`. Browser actions flow into normal Tool evidence and state assertions. See [Tool apps](../../docs/tool-apps.md) for authoring, lifetime, and browser-testing guidance.

Omit `scenario` and `drill` to use world baseline data, select a named `scenario`, or select a `drill` to use its starting situation without running it. At most one may be supplied. The default operation budget is 1,000 without a drill; `maxToolCalls` overrides it. `describe()` includes the running build, optional scenario/drill IDs, actors, Tool `operationContracts` and `stateContracts`, and reset `generation`.

The handle can call a Tool as a declared actor, inspect current state and causal evidence, advance virtual time, and reset the whole initial world or selected Tool packages. `world.call()` records operator/control activity; listener activity records actor-scoped operation outcomes. Neither is an agent-test verdict. Use `state({ packageId, namespace, afterRowId, limit })` and `evidence({ fromSequence, limit })` for paginated reads. These SDK values are unredacted.

`world.reset()` restores baseline state, clock, randomness, and journal; activity after baseline is removed. `world.reset({ packages: ["record-store"] })` preserves global time, earlier evidence, and unselected Tool state. Every successful reset advances `describe().generation`; restart state and evidence cursors when it changes. Listener URLs and tokens survive resets without widening grants. Reset authority is never passed through the listener binding.

`world.close()` revokes access immediately and begins socket cleanup; await `binding.close()` to finish closing listeners. Closing a binding does not close its world. World files remain under `.firedrill/worlds/` unless a new `directory` is supplied. See [local world control](../../docs/local-world-control.md) for reset boundaries, lifecycle, and the inspector's borrowed-world integration.

## Run an agent drill

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

`setup.scenario` layers actors, state actions, faults, initial events, `toolOverrides`, and optional virtual time after the drill's declared scenario. A later `upsert` for the same Tool namespace and row becomes that trial's starting value. `setup.tools.packages` selects an installed reusable Tool for this run; `behaviorOverrides` points to a repository-relative deterministic module that must implement the already-declared Tool manifest. Canonical behavior must be reproducible source, not an unrecorded closure.

For existing imported functions or SDK methods, install `mockTool(binding, options)` from `@firedrill/sdk/testing` using your test runner's module mock or spy. It preserves synchronous/Promise signatures and native error mapping while delegating to the same world operation. Production agent code stays unchanged. Declarative `toolOverrides` provide baseline → scenario → drill → per-test return/error/original rules, optional argument/actor matching, and durable `times` limits. See [test-side mocking](../../docs/test-mocking.md) for the complete example, precedence, reset and interception boundaries.

`setup.bindings.environment` maps the configuration names an existing agent already consumes to invocation-scoped Firedrill HTTP, MCP, or CLI values. A command target receives the projected variables automatically. A caller-owned target passes `binding.environment` into its existing configuration seam. The canonical `FIREDRILL_*` values remain available, and an unavailable protocol mapping fails before the agent starts.

A setup requires one explicit `drill`. Firedrill normalizes it, creates a derived content-addressed build, records the complete setup and hash in every report, and leaves authored files unchanged. Reproduce it with the report's exact `--build-hash`; do not pass `setup` again when loading that immutable build.

Use `suite`, `tags`, `filter`, and `shard` for deterministic selection; `trials`, `retries`, and `concurrency` bound local work. Lifecycle hooks exist at suite, drill, and trial boundaries and never replace the customer's test runner. `verifyReport()` verifies one portable local bundle; `compareRuns()` verifies two and returns an explicit compatibility grade before factual deltas.

Use `callbackReceivers` when the world must send an asynchronous request into the local application under test. Each key is the abstract receiver id declared by Tool source; each value supplies a loopback `baseUrl` and, only when required, an HMAC `secret`. The same mapping is available non-interactively in the CLI. See the repository [callback guide](../../docs/callbacks.md).

`binding.environment` contains only the connection values for the target's declared HTTP, MCP, or CLI binding plus its declared aliases. `binding.world` exists only for a declared direct binding. A caller-owned test harness should pass these values into an existing client/tool configuration seam; production agent logic should not import Firedrill or add invocation-specific branches. The callback's owning process keeps its normal model/provider credentials; do not copy them into the Firedrill binding. Spawned command targets receive only synthetic binding values plus host variables explicitly named by their `environmentFromHost` mapping.

Callback output may be any ordinary JSON-serializable value; optional `undefined` object properties are omitted just as they are over HTTP or stdout. It is retained as target evidence but does not replace state and operation assertions.

## Supporting file evidence

For optional logs, screenshots, recordings, and failure-only retention, start
with the [capture guide](../../docs/capture.md). `runDrills({ capture })` exposes
`capture.log`, `capture.file`, `capture.screenshot`, `capture.video`, and
`capture.registerDriver` to caller-owned targets and lifecycle hooks. Every
category defaults to off. Retention runs after the attempt's final assertions;
capture errors remain visible without changing the behavioral verdict.

The existing `attach()` API below always retains its file independently of those
policies. Use it when an attachment should be part of the record in every outcome.

A caller-owned browser or application harness can copy a screenshot, trace, video, or text artifact into the report for the current attempt:

```ts
agent: async ({ task, binding, signal, attach }) => {
  await driveMyAgentUi({ task, environment: binding.environment, signal });
  attach({
    path: "test-results/agent-screen.png",
    mediaType: "image/png",
    redaction: { status: "applied_by_caller" },
  });
}
```

The path must resolve to a regular, non-symlinked file inside `root`. Firedrill copies it immediately into private temporary staging, records only its portable name, media type, byte count, SHA-256 hash, and caller-declared redaction status, then writes it beneath the attempt's report directory. The source path never enters the run result. One file is limited to 64 MiB; one run is limited to 32 files and 128 MiB. Supported media types are JSON, ZIP, PNG, JPEG, WebP, plain text, HTML, and WebM.

Firedrill does not inspect or redact binary content. Mark `applied_by_caller` only after the harness has removed sensitive content; otherwise the report states that the file was copied verbatim. Attachments remain supporting evidence. A screenshot or DOM result cannot override a failed world-state, Tool-call, event, fault, time, or ordering assertion.

Setup and source problems reject with `FiredrillProjectError`, including stable code, details, and compiler diagnostics. A successful source build returns any non-error compiler diagnostics on `result.diagnostics`; an exact `buildHash` run returns none because it does not recompile source. A drill that executes and fails assertions resolves normally with `verdict: "failed"`, leaving Jest, Vitest, Mocha, or application code in control.

Tool authors and consumers use `inspectTool()` to inspect a selected repository or installed-package contract without executing behavior. `validateTool()` explicitly loads the selected behavior with the developer's local authority. `testTool()` runs a selected repository conformance suite twice and returns ordinary verified drill reports plus operation/error/event/fault/subscription/callback coverage and same-seed state/trajectory reproducibility.

`prepareToolContribution()` is limited to Tool source owned by the current repository. It requires an explicit Apache-2.0/source-rights/customer-data attestation, successful conformance, and a clean source scan. It writes a new local review bundle and never overwrites, uploads, or opens a pull request.

Each returned trial includes the sealed result, ordered evidence, retained SQLite path, and terminal/JSON/JSONL/JUnit/HTML report locations. By default they stay under `<project>/.firedrill/`, which should remain Git-ignored because evidence may contain synthetic records and agent output. No account or hosted service is involved. Lower-level packages remain public for custom composition, but ordinary test code should start here.
