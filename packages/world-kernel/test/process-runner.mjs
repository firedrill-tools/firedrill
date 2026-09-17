import { defineTool } from "@firedrill-tools/tool-sdk";
import { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import { WorldKernel } from "../dist/index.js";

const [filePath, seed] = process.argv.slice(2);
if (filePath === undefined || seed === undefined) {
  throw new Error("usage: node process-runner.mjs <database-path> <seed>");
}

const buildHash = `sha256:${"e".repeat(64)}`;
const packageLockHash = `sha256:${"f".repeat(64)}`;
const tool = defineTool({
  manifest: {
    schemaVersion: 1,
    id: "random-ledger",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: ["state.read", "state.write", "random.draw"],
    state: [{ namespace: "draws", schema: { type: "object" } }],
    operations: [
      {
        id: "draws.record",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["id", "value"],
          properties: { id: { type: "string" }, value: { type: "integer" } },
          additionalProperties: false,
        },
        idempotency: "required",
        fidelity: "behavioral",
      },
    ],
  },
  operations: {
    "draws.record": (input, context) => {
      const id = String(input.id);
      const value = context.random.nextInteger(0, 1_000_000);
      context.state.put("draws", id, { id, value });
      return { id, value };
    },
  },
});

const store = SqliteWorldStore.create({
  filePath,
  worldInstanceId: "world_process01",
  buildHash,
  packageLockHash,
  seed,
  virtualTimeUs: 0,
  correlationId: "corr_processcreate",
  actors: [
    {
      bindingId: "actor_process01",
      actorId: "developer",
      grants: [{ packageId: "random-ledger", operationId: "draws.record" }],
    },
  ],
});

try {
  const kernel = new WorldKernel({ store, packageLockHash, tools: [tool] });
  const result = kernel.invoke({
    schemaVersion: 1,
    callId: "call_process01",
    correlationId: "corr_process01",
    operation: { packageId: "random-ledger", operationId: "draws.record" },
    actorBindingId: "actor_process01",
    arguments: { id: "first" },
    idempotencyKey: "record-first",
  });
  process.stdout.write(
    `${JSON.stringify({
      outcome: result.outcome,
      stateHash: store.stateHash(),
      evidenceHash: store.evidenceHash(),
      evidenceCount: store.readEvidence().length,
    })}\n`,
  );
} finally {
  store.close();
}
