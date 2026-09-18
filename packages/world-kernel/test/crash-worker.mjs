import { writeFileSync } from "node:fs";
import { defineTool } from "@firedrill-run/tool-sdk";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import { WorldKernel } from "../dist/index.js";

const [filePath, signalPath] = process.argv.slice(2);
if (filePath === undefined || signalPath === undefined) {
  throw new Error("usage: node crash-worker.mjs <database-path> <signal-path>");
}

const packageLockHash = `sha256:${"f".repeat(64)}`;
const pause = new Int32Array(new SharedArrayBuffer(4));
const tool = defineTool({
  manifest: {
    schemaVersion: 1,
    id: "crash-probe",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: ["state.read", "state.write", "clock.read", "clock.schedule", "random.draw", "event.emit"],
    state: [{ namespace: "records", schema: { type: "object" } }],
    operations: [
      {
        id: "effects.apply",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          required: ["completed"],
          properties: { completed: { const: true } },
          additionalProperties: false,
        },
        idempotency: "required",
        fidelity: "behavioral",
      },
    ],
    events: [
      {
        id: "effect.pending",
        payloadSchema: {
          type: "object",
          required: ["recordId"],
          properties: { recordId: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  },
  operations: {
    "effects.apply": (_input, context) => {
      const random = context.random.nextInteger(1, 1_000_000);
      context.state.put("records", "main", { value: "uncommitted", random });
      context.events.scheduleAt("effect.pending", { recordId: "main" }, context.clock.nowUs() + 1_000);
      writeFileSync(signalPath, "transaction-open\n");
      Atomics.wait(pause, 0, 0, 600_000);
      return { completed: true };
    },
  },
});

const store = SqliteWorldStore.open(filePath);
const kernel = new WorldKernel({ store, packageLockHash, tools: [tool] });
kernel.invoke({
  schemaVersion: 1,
  callId: "call_crash001",
  correlationId: "corr_crash001",
  operation: { packageId: "crash-probe", operationId: "effects.apply" },
  actorBindingId: "actor_process01",
  arguments: {},
  idempotencyKey: "apply-once",
});
store.close();
