import { defineTool } from "@firedrill-run/tool-sdk";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import { WorldKernel } from "../dist/index.js";

const [filePath, workerId, mode] = process.argv.slice(2);
if (filePath === undefined || workerId === undefined) {
  throw new Error("usage: node idempotency-worker.mjs <database-path> <worker-id>");
}

const packageLockHash = `sha256:${"f".repeat(64)}`;
const pause = new Int32Array(new SharedArrayBuffer(4));
const tool = defineTool({
  manifest: {
    schemaVersion: 1,
    id: "atomic-counter",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: ["state.read", "state.write"],
    state: [{ namespace: "counters", schema: { type: "object" } }],
    operations: [
      {
        id: "counters.increment",
        inputSchema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "integer" } },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "integer" } },
          additionalProperties: false,
        },
        idempotency: "required",
        fidelity: "stateful",
      },
    ],
  },
  operations: {
    "counters.increment": (input, context) => {
      const current = Number(context.state.get("counters", "main")?.value ?? 0);
      Atomics.wait(pause, 0, 0, 200);
      const value = current + Number(input.amount);
      context.state.put("counters", "main", { value });
      if (mode === "original-once") throw new Error("failed original after write");
      return { value };
    },
  },
});

const store = SqliteWorldStore.open(filePath);
try {
  const kernel = new WorldKernel({
    store,
    packageLockHash,
    tools: [tool],
    ...(mode === "original-once"
      ? {
          toolOverrides: [
            {
              id: "fallback",
              operation: { packageId: "atomic-counter", operationId: "counters.increment" },
              scope: { kind: "baseline" },
              outcome: { kind: "return", value: { value: 77 } },
            },
            {
              id: "original-once",
              operation: { packageId: "atomic-counter", operationId: "counters.increment" },
              scope: { kind: "baseline" },
              outcome: { kind: "original" },
              times: 1,
            },
          ],
        }
      : {}),
  });
  const result = kernel.invoke({
    schemaVersion: 1,
    callId: `call_worker${workerId.padStart(2, "0")}`,
    correlationId: `corr_worker${workerId.padStart(2, "0")}`,
    operation: { packageId: "atomic-counter", operationId: "counters.increment" },
    actorBindingId: "actor_process01",
    arguments: { amount: 1 },
    idempotencyKey: "increment-main-once",
  });
  const operation = result.evidence.find((entry) => entry.kind === "operation");
  process.stdout.write(
    `${JSON.stringify({ outcome: result.outcome, idempotency: operation?.idempotency })}\n`,
  );
} finally {
  store.close();
}
