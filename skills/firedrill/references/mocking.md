# Mock dependencies from your tests

Run the existing agent. Replace its surroundings, not its decisions. A drill can
control starting data, tool responses, failures and scheduled events; the agent
still chooses its actions. A browser test may use Playwright to drive the agent's
UI. A worker or CLI agent does not need a browser.

Keep production code unchanged. Your existing test runner installs replacements;
Firedrill supplies the stateful world and records what happened.

## Replace an imported function

For a target declared as `kind: external` with `bindings: [direct]`, use
`mockTool` from `@firedrill-run/sdk/testing` as a mock implementation. This Vitest
example assumes the existing agent imports `saveRecord` from `records-client`.
The test imports Firedrill; the application does not.

```ts
import { afterEach, expect, test, vi } from "vitest";
import { runDrills } from "@firedrill-run/sdk";
import { mockTool } from "@firedrill-run/sdk/testing";
import { saveRecord } from "../src/records-client.js";
import { runAgent } from "../src/agent.js";

vi.mock("../src/records-client.js", () => ({ saveRecord: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test("the agent saves the intended record", async () => {
  const result = await runDrills({
    drill: "save-record",
    agent: async ({ task, binding }) => {
      vi.mocked(saveRecord).mockImplementation(mockTool(binding, {
        mode: "async",
        operation: { packageId: "record-store", operationId: "records.save" },
        input: (id: string, text: string) => ({ id, text }),
        idempotencyKey: (id: string) => `save-${id}`,
      }));
      return runAgent(task.instruction);
    },
  });
  expect(result.verdict).toBe("passed");
});
```

The named operation must exist in your world and its input/output schemas must
match the mapped values. The helper returns the operation's JSON value by default;
use `output(value)` to preserve a different native return shape. Use `mode: sync`
for a synchronous function or `mode: async` for a Promise. A failed operation
throws/rejects with `ToolMockError`, including `envelope` and `status`. Supply
`error(envelope)` to construct the dependency's native Error class instead.

Choose idempotency keys according to the real operation: retries of one logical
request reuse a key; distinct requests use distinct keys. A repeated successful
key returns its receipt before selecting a new override.

Jest's mocks or spies can install the same callable. Follow your runner's module
loading rules: install replacements before importing the agent when required by
ESM. A spy must replace its implementation; spying alone can still call the real
service. Restore spies after tests. Module replacements must not be shared by
overlapping drills: use `concurrency: 1` within each worker and non-concurrent
tests that share a module. Parallel trials need separate isolated processes or
module instances, not just separate test workers running concurrent trials.
A retained `mockTool` callable rejects after its binding expires.

## Return a value or fail selected calls

Add `toolOverrides` to your world, scenario or drill JSON/YAML. For a single test,
put the same rules in `runDrills({ drill, setup: { scenario: { toolOverrides } } })`.
For example, a Tool that declares a `BUSY` error can fail its first matching call:

```json
{
  "toolOverrides": [
    {
      "id": "busy-once",
      "operation": { "packageId": "record-store", "operationId": "records.save" },
      "when": { "arguments": { "id": "record-1" } },
      "times": 1,
      "outcome": { "kind": "error", "code": "BUSY", "message": "Try again", "retryable": true }
    }
  ]
}
```

This is a field fragment, not a complete world file. Outcomes are:

- `return`: return `value` without running the Tool handler or its faults. It
  does **not** pretend a state change happened. The value must match the output schema.
- `error`: return a declared Tool error without running the handler or faults.
- `original`: use normal synthetic Tool behavior, including its active faults,
  instead of a lower-priority stub. This never means calling the production service.

Rules apply to direct, HTTP, MCP and Firedrill CLI calls after transport decoding.
Permissions, valid input, budgets and idempotency remain enforced. Rules match an
operation and optionally an `actorId` or supplied argument keys. Each supplied
argument value matches exactly, including nested objects and arrays; other
top-level arguments may differ.

Priority is world baseline → named scenario → drill → per-test setup. Within a
scope, later matching rules win. A higher-scope rule with the same `id` replaces
the lower rule entirely. Once its `times` limit is consumed, matching continues
to other rules, then normal Tool behavior—not the replaced definition. Omit
`times` for unlimited matches. Inline scenarios remain complete starting setups,
not overlays of the world baseline.

## State, reset and evidence

For a replacement that changes records, emits events or schedules consequences,
author a deterministic Tool behavior module. Reuse it normally or select it with
`setup.tools.behaviorOverrides`. `mockTool` calls that same engine, so function
mocks and protocol clients share state and evidence.

An override's identity, source scope, selected outcome and match count are recorded
with the operation. One-shot consumption is durable even when the selected Tool
handler rolls back. Whole-world reset restores initial rule counts with the other
state; package reset restores counts only for those packages. Restoring runner
mocks and resetting a Firedrill world are separate operations.

Per-test rules are compiled into the derived build and retained in its report.
Reproduction with the exact build and seed restores those rules. Reinstall your
test-side function adapters using the same harness; the build does not capture
arbitrary test closures, application code or model randomness.

## Interception boundaries

This is not a universal process hook. Module mocking can replace imported
functions, SDK methods and provider-router calls exposed to your test runner.
It cannot automatically replace private same-module calls, previously captured
references, subprocess internals or native built-ins inside an opaque agent.
For another process, use its existing MCP/HTTP endpoint configuration, a supported
CLI adapter, or an explicit test-only process harness. Filesystem/grep behavior
needs an interceptable function boundary or a controlled fixture workspace;
changing a working directory alone does not confine filesystem access.

`mockTool` never falls through to a real dependency. Other dependencies remain
your harness's responsibility: block unintended network/process/file access and
verify the selected binding before allowing side-effecting real credentials.
