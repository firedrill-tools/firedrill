# Work Queue Tool pack

This is Firedrill's small reference package for the reusable Tool-pack contract. It models a stateful work queue with list, claim, and complete operations, declared missing-item errors, actor-aware assignment, and a completion event.

It is not a privileged product model or a compatibility claim for a third-party service. Its purpose is to prove that an ordinary installed package can supply typed behavior to any consumer world without changing Firedrill core.

Its conformance agent uses the pack's declared synthetic HTTP routes rather than Firedrill's generic operation envelope. The routes deliberately cover bearer, HTTP Basic, and query-token authentication; no-body and text requests; nested JSON, empty, and text responses; and mapped not-found failures. They all invoke the same three semantic operations used by direct, MCP, and CLI bindings.

Install it with the package manager already used by the project, then select it explicitly:

```json
{
  "schemaVersion": 1,
  "toolPackages": ["@firedrill-tools/tool-work-queue"]
}
```

That package is the only Tool-specific dependency the consuming repository needs. Firedrill compiles its small behavior runtime into the immutable Tool artifact; consumers do not hoist `@firedrill-tools/tool-sdk` manually.

The consumer world owns actors, initial state, scenarios, targets, and drills. Firedrill reads the package declaration without executing behavior during `validate`; behavior executes only when a build is loaded or a drill runs, with the developer's local authority.

Maintainers run the same public conformance path available to every Tool author:

```sh
firedrill tool test work-queue
```
