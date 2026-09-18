# Local world control

`createLocalWorld()` starts one synthetic environment from the repository's world baseline, with no required scenario, drill, target, or agent. Use it to develop Tools, connect an existing client, or control a world from a custom harness. `runDrills()` is the testing API: it creates an isolated world per trial, invokes the existing agent, evaluates assertions, and writes reports. Starting a world or calling a Tool manually does not establish that an agent was tested.

## Start from baseline data

```ts
import { createLocalWorld } from "@firedrill-run/sdk";

const world = await createLocalWorld({ root: process.cwd() });
const binding = await world.listen(); // Exactly one source-defined actor is required when actorId is omitted.

try {
  // Pass binding.environment to your existing client's configuration seam.
  // Keep its local bearer tokens private; these are not provider credentials.
  await useExistingClient(binding.environment);
} finally {
  await binding.close();
  world.close();
}
```

The world supplies initial state, actors and explicit grants, faults, scheduled events, virtual time, and seed. No actor or permission is invented. To select an actor explicitly, use `world.listen({ actorId: "support-agent" })`. A world without actors can still be inspected but cannot listen for actor-scoped calls.

`listen()` starts HTTP, MCP, and Firedrill CLI listeners by default. Select a non-empty subset with `protocols: ["http", "mcp"]`. `httpPort`, `mcpPort`, and `cliPort` accept a fixed port or `0` for an available port; a port option requires its protocol to be selected. Every listener is loopback-only. The returned binding exposes `worldInstanceId`, `actorId`, `environment`, selected `{ url, token }` endpoints, and `close()`. No agent process is launched and no fallback calls production. These protocols expose the same declared operations and actor grants; they do not imply complete compatibility with an arbitrary external service.

`createLocalWorld({ scenario: "busy-inbox" })` uses a named starting situation. `createLocalWorld({ drill: "refund-dispute" })` uses a drill's scenario without executing the drill. Select at most one of `scenario` or `drill`; omitting both uses the baseline. `seed` overrides the world seed, `buildHash` loads an immutable build, and `maxToolCalls` defaults to the selected drill's budget or 1,000 without a drill.

## Operator controls

```ts
import { createLocalWorld } from "@firedrill-run/sdk";

const world = await createLocalWorld({
  root: process.cwd(),
  drill: "refund-dispute",
});

try {
  const result = world.call({
    actorId: "support-agent",
    packageId: "billing",
    operationId: "refunds.create",
    arguments: { orderId: "order-1", amount: 12900 },
    idempotencyKey: "refund-order-1",
  });

  world.advanceTime(3_600_000_000);
  const records = world.state({ packageId: "billing", namespace: "refunds" });
  const evidence = world.evidence();
} finally {
  world.close();
}
```

`describe()` identifies the immutable running build, the optional selected scenario/drill, and the current reset `generation`. Each Tool includes operation IDs and complete `operationContracts`, state namespaces and `stateContracts`, event IDs, and fault IDs. These describe the build that is running, not later edits to repository files.

`world.call()` is a developer control call made as the specified actor; it still enforces that actor's grants. Its journal correlation identifies operator activity separately from listener calls. Neither category is a drill verdict or proof of which external application made the call. The customer's agent and application database remain outside this control plane.

Use `state({ packageId, namespace, afterRowId, limit })` and `evidence({ fromSequence, limit })` for bounded reads. Row cursors are exclusive; evidence sequence cursors are inclusive. `scheduledEvents()`, `callbacks()`, and `faults()` inspect pending work and active failures without exposing a storage handle. SDK values and retained SQLite files are unredacted; review them before sharing.

## Runtime fault controls

`world.describe().tools` lists the faults declared by the selected Tool packages;
`world.faults()` lists those currently enabled. Use
`world.setFault({ packageId, faultId, active: true })` to enable one and the same
call with `active: false` to disable it between agent actions. Unknown packages,
unknown faults, and non-boolean values are rejected without mutating the world.

The result includes `previouslyActive`, `active`, `changed`, and the committed
evidence. State and a distinct `fault_control` entry commit in the same SQLite
transaction, including a repeated request that leaves the state unchanged. This
is controller activity, not proof that an agent triggered a fault. Subsequent
operations still record any actual injected failure separately. Disabling a
fault never erases an earlier idempotency receipt or reverses a committed effect.
Reset and snapshots preserve the same fault-state semantics described below.
The agent's binding and Tool context cannot call this control method.

Runtime controls are inputs from your harness, not changes to the immutable
build. Reports retain them separately and comparisons involving these controls
are descriptive only, even if the build and seed match. The report's command
reruns initial world inputs; use the original harness to repeat mid-run controls.
The framework does not capture arbitrary harness scheduling or model randomness.

## Reset semantics

`world.reset()` restores the complete initial world from a coherent SQLite snapshot. It restores Tool state, faults, scheduled events, callback deliveries, idempotency receipts, virtual time, and deterministic random state together. Activity after the baseline is removed from that world file; a durable `world_reset` lifecycle entry identifies the reset.

`world.reset({ packages: ["billing"] })` restores only runtime data owned by those Tool packages:

- package state and active faults;
- scheduled events and callback deliveries owned by the selected packages; and
- operation idempotency receipts and Tool override match counts for the selected packages.

Scoped reset preserves actors, virtual time, random progress, prior evidence, and unselected Tool state. It does not guess how to reverse an already committed consequence in another Tool. Select every affected Tool or use a whole-world reset when the initial condition spans packages.

Whole-world reset also restores initial Tool override counts. Neither reset changes your test runner's installed mocks or spies; restore those through the runner. See [test-side mocking](test-mocking.md).

A reset fails without changing the world while a relevant callback request is in flight. Its external outcome is unknown until delivery settles, so silently rewinding would make a duplicate side effect possible.

Every successful reset increments `describe().generation` and revokes the previous actor clients. Existing `listen()` URLs and tokens remain stable, but each invocation resolves the current actor client. Permissions do not widen during a reset. Restart state/evidence pagination when the generation changes: a whole-world reset returns the journal to baseline and may reuse earlier sequence numbers. Scoped reset retains prior evidence but also advances the cursor epoch.

Reset authority is held by the developer's harness; it is never included in an actor-scoped listener binding. The local inspector requires the exact running `worldInstanceId` before resetting and rejects a control request if the world resets while its body is uploading.

## Local artifacts

By default, each controlled world is retained beneath `<project>/.firedrill/worlds/` as `world.sqlite` plus `baseline.sqlite`. Both files may contain complete synthetic state and unredacted evidence. Keep `.firedrill/` ignored by Git. `world.close()` immediately revokes world access, starts listener shutdown, and releases the database; await `binding.close()` for completed socket cleanup. Closing one binding alone leaves its world and other bindings available. A failed multi-protocol startup closes any listeners it already opened. Neither close method deletes retained world files.

The inspector can borrow a running world with `startLocalInspector({ root, environment: { world, binding } })` from `@firedrill-run/inspector`. Its `close()` stops only the inspector and its drill supervisor; the caller continues to own the supplied world and binding. Keep the supplied binding open while advertising its connection values. See the [inspector guide](../packages/inspector/README.md).
