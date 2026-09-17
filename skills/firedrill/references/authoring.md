# Firedrill authoring reference

Use this reference when creating or repairing repository source. These are patterns, not required domain names.

## Source layout

```text
firedrill.json
firedrill/
  world.yaml
  tools/resource-store/
    resource-store.tool.yaml
    behavior.js
  scenarios/baseline.scenario.yaml
  targets/agent-under-test.target.yaml
  drills/changes-resource.drill.yaml
  suites/pull-request.suite.yaml       # optional
agent.mjs                             # existing agent or separate test harness
```

`firedrill.json` may contain only:

```json
{ "schemaVersion": 1 }
```

The defaults are `sourceRoot: firedrill` and `world: world.yaml`. The compiler discovers resources recursively beneath `sourceRoot`; the folders above are a recommended convention, not required names. Preserve an existing project's organization rather than moving files merely to match this example. Resource filenames end in `.tool`, `.scenario`, `.target`, `.drill`, or `.suite` followed by `.yaml`, `.yml`, or `.json`. Prefer descriptive kebab-case basenames. A resource's identity is its in-file `id`; renaming a title must not require moving its file.

Keep schema in the Tool declaration, shared starting data and identities in the world, variations in scenarios, and the task plus assertions in each drill. Keep the agent's actual code or a test-only harness separate from synthetic Tool behavior. `.firedrill/` is generated runtime output, never a source directory to author or commit.

## Reusable Tool package

If the project already depends on an approved compatible Tool pack, select it by npm-compatible package name:

```json
{
  "schemaVersion": 1,
  "toolPackages": ["@scope/firedrill-tool"]
}
```

The package must export `./package.json` and declare `firedrill.layer: "tool-pack"`, `firedrill.tool`, and an `active`, `deprecated`, or `revoked` lifecycle. Firedrill reads its declaration without executing behavior, confines behavior source to that package, and records package name and version in the build lock. A deprecated version produces `FD1403`; a revoked version is refused. These checks are offline and use the installed artifact.

Run `firedrill tool inspect <tool-id> --json` to verify the exact origin, operations, state, fidelity, and source closure. The consuming repository still owns its world data, actors, scenarios, target, and drills. Do not edit or contribute the installed copy. If no compatible package is already approved, use a repository-owned Tool instead of silently adding an untrusted dependency.

## Minimal world

```yaml
schemaVersion: 1
id: local-world
seed: "1"
actors:
  - id: operator
    grants:
      - packageId: resource-store
        operationId: records.set
```

Actors are deterministic identities with explicit operation grants. Put shared baseline time, state, faults, and initial events here only when every scenario needs them.

## Minimal stateful Tool

`firedrill/tools/resource-store/resource-store.tool.yaml`:

```yaml
schemaVersion: 1
module: ./behavior.js
manifest:
  schemaVersion: 1
  id: resource-store
  version: 1.0.0
  engine: ">=0.1.0 <0.2.0"
  capabilities: [state.read, state.write]
  state:
    - namespace: records
      schema:
        type: object
        required: [value]
        properties:
          value: { type: integer }
        additionalProperties: false
  operations:
    - id: records.set
      inputSchema:
        type: object
        required: [value]
        properties:
          recordId: { type: string }
          value: { type: integer }
        additionalProperties: false
      outputSchema:
        type: object
        required: [value]
        properties:
          value: { type: integer }
        additionalProperties: false
      idempotency: required
      fidelity: stateful
```

`firedrill/tools/resource-store/behavior.js`:

```js
export default {
  operations: {
    "records.set": (input, context) => {
      const value = { value: Number(input.value) };
      context.state.put("records", String(input.recordId ?? "primary"), value);
      return value;
    },
  },
};
```

The manifest owns schemas, capabilities, declared errors, events, faults, and fidelity. The behavior module owns deterministic consequences. Keep business-specific behavior here, never in the Firedrill kernel.

### Optional synthetic HTTP route

Declare a wire route only when the existing agent's HTTP client needs that shape. The route points to an existing semantic operation; it does not create another behavior implementation.

```yaml
  http:
    - id: set-record
      operationId: records.set
      method: PUT
      path: /api/records/{recordId}
      auth: { kind: header, name: x-api-key }
      requestBody: json
      response:
        successStatus: 200
        errors: []
```

Add the exact matching codec to the Tool behavior export:

```js
export default {
  operations: {
    "records.set": (input, context) => {
      const value = { value: Number(input.value) };
      context.state.put("records", String(input.recordId), value);
      return value;
    },
  },
  http: {
    "set-record": {
      decode: (request) => {
        const body =
          request.body.kind === "json" &&
          typeof request.body.value === "object" &&
          request.body.value !== null &&
          !Array.isArray(request.body.value)
            ? request.body.value
            : {};
        return {
          arguments: { recordId: request.path.recordId, value: body.value },
          idempotencyKey: request.headers["idempotency-key"]?.[0],
        };
      },
      encode: ({ outcome }) => ({
        body:
          outcome.status === "ok"
            ? { kind: "json", value: outcome.value }
            : { kind: "json", value: { error: outcome.error.message } },
      }),
    },
  },
};
```

Validate optional wire fields deliberately rather than relying only on coercion. Route codecs receive bounded path/query/header/body data but no `ToolContext`, so they cannot own state. Firedrill removes the declared synthetic credential before calling the decoder. Every declared Tool error must have a route status mapping. Unsupported routes fail closed; never add a successful placeholder for behavior that is not implemented. Run `firedrill plan --json` to inspect method, path, auth kind, and operation fidelity before executing the agent.

### Optional callback into the application

Use a callback when a committed world event must make an asynchronous HTTP request to the application under test. This is not an agent-facing API. Declare an abstract receiver id and static path in the Tool manifest, then add a pure event-to-request codec under the matching callback id. Never put the receiver URL or signing secret in repository source.

At run time, map the receiver explicitly:

```sh
firedrill run <drill-id> \
  --callback-receiver application=http://127.0.0.1:4319 \
  --callback-secret-env application=CALLBACK_SECRET
```

Use `callback.count` to assert durable delivery evidence. Retry delays use virtual time; the framework owns signing, idempotency, retry scheduling, crash recovery, and evidence. Read `docs/callbacks.md` for the exact source shape and constraints.

`idempotency` describes the operation's call contract:

- `none` rejects a supplied idempotency key;
- `optional` accepts a key but does not require one; and
- `required` rejects direct/HTTP calls without a key (MCP derives a stable request key when the caller does not provide one).

Choose `none` only when callers must not send a key. A read can still be `optional` when the agent adapter naturally supplies stable keys.

For an expected operation failure, list its stable code in that operation's `declaredErrors`, then stop the handler with `context.fail({ code, message, retryable, details })`. This rolls back the operation's transaction and records a structured `tool_error` without requiring the behavior file to import a runtime package. Throwing an ordinary exception represents a handler crash, not a provider or policy outcome. `context.fail` is for operation handlers; a subscription failure is an execution failure.

## Minimal scenario

```yaml
schemaVersion: 1
id: baseline
state:
  - action: upsert
    packageId: resource-store
    namespace: records
    rowId: primary
    value: { value: 0 }
```

Use a scenario for a meaningful starting condition, actor overlay, active Tool fault, virtual clock value, or initial scheduled event. Do not encode expected outcomes in scenario state.

## Minimal command target

```yaml
schemaVersion: 1
target:
  id: agent-under-test
  kind: command
  bindings: [http]
  executable: node
  arguments: [agent.mjs]
  workingDirectory: .
  timeoutMs: 5000
```

The command receives one JSON invocation on stdin. It must write either no stdout or one JSON value to stdout; write logs to stderr. Firedrill supplies only declared world binding variables and explicitly mapped host variables.

Target `module` and `workingDirectory` paths are repository-root-relative. Tool behavior `module` paths are relative to their own `*.tool.yaml` or JSON file. A command's stdout value is its output payload, not a `TargetResult` envelope; Firedrill records completion or failure around it.

## Minimal drill

```yaml
schemaVersion: 1
id: changes-resource
title: Changes one resource through the agent
tags: [smoke]
targetId: agent-under-test
actorId: operator
scenarioId: baseline
task:
  instruction: Set the requested value.
  input: { value: 7 }
assertions:
  - id: operation-called-once
    kind: operation.count
    operation: { packageId: resource-store, operationId: records.set }
    outcomes: [ok]
    comparison: { operator: equals, value: 1 }
  - id: value-changed
    kind: state.value
    packageId: resource-store
    namespace: records
    rowId: primary
    path: [value]
    comparison: { operator: equals, value: 7 }
```

Keep a first drill small. A task is input to the customer-owned target. Assertions decide the result from the world evidence.

## Repeated workload

Replace the simple `actorId`/`task` shape with a timeline when the drill needs multiple interactions or long virtual time:

```yaml
timeline:
  horizonUs: 21600000000
  maxEvents: 1000
  stopOnInvariantFailure: true
  stopOnTargetFailure: true
  workloads:
    - id: periodic-review
      actorIds: [operator]
      task:
        instruction: Review and handle the current work item.
      startAfterUs: 0
      everyUs: 3600000000
      occurrences: 6
  invariants:
    - id: mutation-budget
      kind: operation.count
      operation: { packageId: resource-store, operationId: records.set }
      comparison: { operator: less_than_or_equal, value: 6 }
```

The runner expands workloads deterministically, advances one virtual clock, processes scheduled events within `maxEvents`, checks invariants after actions/events and at the horizon, then evaluates final assertions.

## Suite

```yaml
schemaVersion: 1
id: pull-request
drills: []
tags: [smoke]
trials: 3
concurrency: 2
retries: 0
```

Explicit drill IDs and tags form a union. Empty `drills` and `tags` select every drill. Filters and deterministic shards can further narrow a CLI/SDK run.

## Validation loop

```sh
firedrill format
firedrill format --check --json
firedrill validate --json
firedrill plan --json
firedrill run changes-resource --json
```

Do not infer a field when validation rejects it. Inspect the emitted schemas from `@firedrill-tools/compiler/schema/*` and `@firedrill-tools/contracts/schema/*` when examples are insufficient.
