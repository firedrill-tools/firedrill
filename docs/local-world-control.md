# Local world control

`runDrills()` is the normal testing API: it creates an isolated world per trial, invokes the existing agent, evaluates assertions, and writes reports. Use `createLocalWorld()` when a custom test harness, debugger, or local inspector needs to control the world between agent actions.

```ts
import { createLocalWorld } from "@firedrill/sdk";

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

The selected drill supplies the scenario: initial Tool state, actors and grants, faults, scheduled events, virtual time, and seed. `describe()` lists the selected build, actors, Tools, operations, state namespaces, events, and faults. `state()`, `evidence()`, `scheduledEvents()`, and `callbacks()` provide bounded inspection without exposing the storage handle. The customer's agent and application database remain outside this control plane.

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

## Reset semantics

`world.reset()` restores the complete initial world from a coherent SQLite snapshot. It restores Tool state, faults, scheduled events, callback deliveries, idempotency receipts, virtual time, and deterministic random state together. Activity after the baseline is removed from that world file; a durable `world_reset` lifecycle entry identifies the reset.

`world.reset({ packages: ["billing"] })` restores only runtime data owned by those Tool packages:

- package state and active faults;
- scheduled events and callback deliveries owned by the selected packages; and
- operation idempotency receipts for the selected packages.

Scoped reset preserves actors, virtual time, random progress, prior evidence, and unselected Tool state. It does not guess how to reverse an already committed consequence in another Tool. Select every affected Tool or use a whole-world reset when the initial condition spans packages.

A reset fails without changing the world while a relevant callback request is in flight. Its external outcome is unknown until delivery settles, so silently rewinding would make a duplicate side effect possible.

The control handle revokes its previous actor clients after every reset. Reset authority is held by the developer's harness; it is never included in a binding supplied to the agent under test.

## Local artifacts

By default, each controlled world is retained beneath `<project>/.firedrill/worlds/` as `world.sqlite` plus `baseline.sqlite`. Both files may contain complete synthetic state and unredacted evidence. Keep `.firedrill/` ignored by Git. `close()` releases the database but deliberately does not delete it, so a local inspector or debugger can open the retained artifact.
