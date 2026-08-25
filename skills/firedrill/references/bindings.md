# Agent target and world binding reference

Use this reference after inspecting how the existing agent already starts and obtains tools.

## Decision table

| Existing agent shape | Target | Typical binding | Integration seam |
| --- | --- | --- | --- |
| CLI, worker, or app process | `command` | HTTP, MCP, or CLI | Process environment / client construction |
| Importable JS/TS entry point | `module` | Direct, HTTP, MCP, or CLI | Exported handler / dependency injection |
| Already-running local service | `http` | HTTP, MCP, or CLI | Request handler receives Firedrill invocation |
| Agent owned by Jest/Vitest/application code | `external` | Direct, HTTP, MCP, or CLI | `runDrills({ agent })` callback |

Choose the shape requiring the fewest production-code changes. Protocol and target are separate decisions: a CLI agent may consume MCP, and an HTTP target may receive an MCP world binding.

Capture the native interface before adapting it. A successful integration preserves the agent's ordinary input, output/return, log destination, and failure behavior when no Firedrill invocation or binding is present. When the target contract differs from the product interface, prefer a small target-only wrapper at the existing callable/composition seam rather than changing the product CLI or UI.

## HTTP world binding

Firedrill supplies:

- `FIREDRILL_HTTP_URL`
- `FIREDRILL_HTTP_TOKEN`

Use bearer authentication. Discover granted operations with `GET /v1/tools`. Invoke one with:

```http
POST /v1/operations/{packageId}/{operationId}
Authorization: Bearer <token>
Content-Type: application/json

{"arguments":{"value":7},"idempotencyKey":"stable-key"}
```

The response always includes `schemaVersion`, `callId`, `correlationId`, and `outcome`. Read `outcome.status`; do not assume every HTTP 2xx response represents a successful Tool result.

This is Firedrill's typed operation protocol, not an automatic wire-compatible clone of a vendor REST surface. When the product agent uses vendor-specific URLs and payloads, adapt that client once at its normal composition seam or add a small repository-owned translation adapter. Do not put vendor routes in framework core.

## MCP world binding

Firedrill supplies:

- `FIREDRILL_MCP_URL`
- `FIREDRILL_MCP_TOKEN`

Connect a standard MCP client using Streamable HTTP and bearer authentication. Each granted Tool name is `{packageId}.{operationId}`. Successful values are in `structuredContent`; denied, invalid, unsupported, and Tool-error responses set `isError: true` and carry a structured outcome.

Repoint the agent's existing MCP registry/client at the per-trial URL. Do not introduce one client per Tool operation.

## Direct binding

Use direct only for `module` or `external` targets that explicitly declare it. A module receives the bound world client in its execution context. An external target receives it as `binding.world` in the `runDrills()` callback.

Direct is a local in-process capability, not a universal protocol. Never try to serialize it into a subprocess.

## CLI world binding

Firedrill supplies:

- `FIREDRILL_CLI_URL`
- `FIREDRILL_CLI_TOKEN`

The public commands consume those values automatically:

```sh
firedrill world tools --json
firedrill world call resource-store records.set --input '{"value":7}' --idempotency-key set-7 --json
```

Use this when an agent already invokes local commands as tools. Do not parse the human output; use `--json`. The command connects to the same per-trial world and operation runtime as HTTP, MCP, and direct bindings. It is unavailable outside an active drill, which prevents accidental calls against an unspecified world.

## Command contract

A command target receives one `TargetInvocation` JSON value on stdin containing the run, interaction, actor, task, and binding environment. It must:

- exit `0` on completion;
- write zero or one JSON **output value** to stdout;
- send logs to stderr;
- stay within its declared timeout; and
- use only explicitly mapped host environment values.

Firedrill captures process failure, timeout, cancellation, malformed output, and the world effects independently.

Do not wrap stdout in a `TargetResult` object. Firedrill owns the target status/error envelope and places the parsed command value under `targetResult.output`; returning another envelope only creates a misleading nested result. A successful wrapper can write a plain object such as `{ "text": "done", "toolCalls": [] }`.

These stdout rules apply to the target process Firedrill launches, not automatically to the product's normal CLI. If the existing command writes human output to stdout, add a wrapper or activate structured stdout only after recognizing a real `TargetInvocation`; prove the normal command still behaves as before. Moving all product output to stderr or suppressing it is not a compatible integration.

The agent—not Firedrill—owns model-provider credentials. Declare a narrow allowlist when a spawned process needs a host variable:

```yaml
target:
  id: local-agent
  kind: command
  bindings: [mcp]
  executable: node
  arguments: [agent.mjs]
  environmentFromHost:
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
  timeoutMs: 120000
```

The mapping is `target variable: host variable`. No other host secrets are inherited. `timeoutMs` applies to the complete interaction—including every model turn and Tool call—not to each request.

## Module contract

A module target exports an async or synchronous function receiving `(invocation, context)`. `context.signal` carries cancellation. `context.world` exists only for a declared direct binding. Return an ordinary JSON-serializable value or `undefined`.

The target descriptor's `module` path is relative to the repository root, not to the `*.target.yaml` file. For example, a module stored beside `firedrill/agent.target.yaml` is declared as `module: firedrill/agent-target.js`. Tool behavior is different by design: a Tool source's `module` path is relative to that `*.tool.yaml` or JSON source file.

Module targets share the Firedrill process and may overlap when trials or suites use concurrency. Treat the handler as reentrant. It must not temporarily replace process-global output, environment, working-directory, signal, or registry state. If the existing agent writes narration to global stdout, either inject an output/logger dependency while preserving the ordinary default or run it behind a command target so process output is isolated and captured. Redirecting `process.stdout.write` for the duration of one async call is unsafe because another target can enter or finish while that replacement is active.

## External SDK callback

Use this when the customer's test runner or application must retain control:

```ts
const result = await runDrills({
  root: process.cwd(),
  drill: "changes-resource",
  agent: async ({ task, binding, signal }) =>
    runExistingAgent({ task, toolEnvironment: binding.environment, world: binding.world, signal }),
});
```

Assertion failures resolve as data with `verdict: "failed"`; setup/source failures reject with `FiredrillProjectError`. Let Jest, Vitest, Mocha, or the application decide how to assert.

## Canary evidence

Before adding more drills, require one operation call to appear in evidence and one intended state/event consequence to pass. A callback or process that returns “done” without using its granted Tool binding has not proven integration.
