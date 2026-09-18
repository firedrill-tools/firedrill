import { writeFileSync } from "node:fs";
import { defineTool } from "@firedrill-run/tool-sdk";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import { WorldKernel } from "../dist/index.js";

const [filePath, mode, signalPath] = process.argv.slice(2);
if (filePath === undefined || (mode !== "crash" && mode !== "complete")) {
  throw new Error("usage: node scheduled-event-worker.mjs <database-path> <crash|complete> [signal-path]");
}
if (mode === "crash" && signalPath === undefined) throw new Error("crash mode requires a signal path");

const packageLockHash = `sha256:${"f".repeat(64)}`;
const pause = new Int32Array(new SharedArrayBuffer(4));
const source = defineTool({
  manifest: {
    schemaVersion: 1,
    id: "timer-source",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: [],
    operations: [
      {
        id: "status.read",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          required: ["ready"],
          properties: { ready: { const: true } },
          additionalProperties: false,
        },
        idempotency: "none",
        fidelity: "contract",
      },
    ],
    events: [
      {
        id: "task.due",
        payloadSchema: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  },
  operations: { "status.read": () => ({ ready: true }) },
});

const consumer = defineTool({
  manifest: {
    schemaVersion: 1,
    id: "timer-consumer",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: ["state.write"],
    state: [{ namespace: "completed", schema: { type: "object" } }],
    operations: [
      {
        id: "status.read",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          required: ["ready"],
          properties: { ready: { const: true } },
          additionalProperties: false,
        },
        idempotency: "none",
        fidelity: "contract",
      },
    ],
    subscriptions: [{ id: "complete-due-task", event: { packageId: "timer-source", eventId: "task.due" } }],
  },
  operations: { "status.read": () => ({ ready: true }) },
  subscriptions: {
    "complete-due-task": (payload, context) => {
      const taskId = String(payload.taskId);
      context.state.put("completed", taskId, { taskId, completed: true });
      if (mode === "crash") {
        writeFileSync(signalPath, "event-transaction-open\n");
        Atomics.wait(pause, 0, 0, 600_000);
      }
    },
  },
});

const store = SqliteWorldStore.open(filePath);
try {
  const kernel = new WorldKernel({ store, packageLockHash, tools: [source, consumer] });
  const result = kernel.advanceTime(1_000, { correlationId: `corr_timer${mode}` });
  if (mode === "complete") process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  store.close();
}
