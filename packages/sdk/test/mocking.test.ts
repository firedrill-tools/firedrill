import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDrills, verifyReport } from "../src/index.js";
import { mockTool } from "../src/testing.js";
import * as clients from "./fixtures/native-clients.js";
import { bookAppointment, finishSample, stabilizeRoom } from "./fixtures/unchanged-agents.js";

// The runner replaces the application's imported module; Firedrill does not rewrite it.
vi.mock("./fixtures/native-clients.js", () => ({
  reserveSlot: vi.fn(() => {
    throw new Error("Unbound scheduling dependency");
  }),
  setTemperature: vi.fn(() => {
    throw new Error("Unbound controller dependency");
  }),
  processSample: vi.fn(() => {
    throw new Error("Unbound sample dependency");
  }),
}));

const roots: string[] = [];
const fixtures = fileURLToPath(new URL("../../compiler/test/fixtures/", import.meta.url));

function repository(name: string, sourceRoot: string, targetFile: string, targetId: string): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-test-mocks-"));
  roots.push(root);
  cpSync(join(fixtures, name), root, { recursive: true });
  // This is test configuration; application source above remains unchanged.
  const target = {
    schemaVersion: 1,
    target: { id: targetId, kind: "external", bindings: ["direct"], timeoutMs: 5_000 },
  };
  writeFileSync(join(root, sourceRoot, targetFile), JSON.stringify(target));
  return root;
}

afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("test-only module mocking with real worlds", () => {
  it("keeps an async application's signature while writes and events enter the world report", async () => {
    const root = repository("appointments", "world", "booking-agent.target.json", "booking-agent");
    const original = readFileSync(fileURLToPath(new URL("./fixtures/unchanged-agents.ts", import.meta.url)));
    const result = await runDrills({
      root,
      drill: "reserve-slot",
      agent: async ({ binding }) => {
        vi.mocked(clients.reserveSlot).mockImplementation(
          mockTool(binding, {
            mode: "async",
            operation: { packageId: "reservations", operationId: "slots.reserve" },
            input: (slotId: string, customerId: string) => ({ slotId, customerId }),
            idempotencyKey: (slotId: string, customerId: string) => `${slotId}-${customerId}`,
            output: (value) =>
              typeof value === "object" && value !== null && !Array.isArray(value) && value.reserved === true,
          }),
        );
        const reply = await bookAppointment("morning", "customer-a");
        expect(reply).toBe("Appointment booked");
        return reply;
      },
    });
    expect(result.verdict).toBe("passed");
    expect(clients.reserveSlot).toHaveBeenCalledExactlyOnceWith("morning", "customer-a");
    const trial = result.drills[0]?.trials[0];
    expect(trial?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "state_change",
        namespace: "slots",
        after: { available: false, reservedBy: "customer-a" },
      }),
    );
    expect(trial?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: { packageId: "reservations", eventId: "slot.reserved" },
      }),
    );
    if (trial === undefined) throw new Error("missing report");
    expect(verifyReport({ report: trial.report.directory }).result.verdict).toBe("passed");
    expect(readFileSync(fileURLToPath(new URL("./fixtures/unchanged-agents.ts", import.meta.url)))).toEqual(
      original,
    );
    // A retained mock cannot access a world after the invocation has finished.
    await expect(clients.reserveSlot("morning", "customer-b")).rejects.toThrow(/no longer active/);
  });

  it("preserves synchronous native exceptions and lets the unchanged agent handle a failure", async () => {
    const root = repository("facility", "simulation", "facility-agent.target.yaml", "facility-agent");
    const result = await runDrills({
      root,
      drill: "recover-climate",
      agent: ({ binding }) => {
        vi.mocked(clients.setTemperature).mockImplementation(
          mockTool(binding, {
            mode: "sync",
            operation: { packageId: "climate-control", operationId: "temperature.set" },
            input: (roomId: string, celsius: number) => ({ roomId, celsius }),
            output: (value) =>
              Number(
                typeof value === "object" && value !== null && !Array.isArray(value)
                  ? value.celsius
                  : Number.NaN,
              ),
            error: (envelope) => new Error("Controller offline", { cause: envelope }),
          }),
        );
        const response = stabilizeRoom("greenhouse");
        expect(response).toBe("Escalate to operator");
        return response;
      },
    });
    expect(result.verdict).toBe("passed");
    expect(clients.setTemperature).toHaveBeenCalledExactlyOnceWith("greenhouse", 22);
    expect(result.drills[0]?.trials[0]?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "operation",
        outcome: expect.objectContaining({ status: "tool_error" }),
      }),
    );
    expect(
      result.drills[0]?.trials[0]?.evidence.filter(
        (entry) => entry.kind === "state_change" && entry.namespace === "rooms" && entry.change === "update",
      ),
    ).toHaveLength(0);
  });

  it("keeps cross-operation events and state in a third unrelated world", async () => {
    const root = repository("laboratory", "drill-world", "lab-agent.target.yaml", "lab-agent");
    const result = await runDrills({
      root,
      drill: "process-sample",
      agent: async ({ binding }) => {
        vi.mocked(clients.processSample).mockImplementation(
          mockTool(binding, {
            mode: "async",
            operation: { packageId: "sample-tracker", operationId: "samples.process" },
            input: (sampleId: string) => ({ sampleId }),
            idempotencyKey: (sampleId: string) => `process-${sampleId}`,
            output: (value) =>
              String(
                typeof value === "object" && value !== null && !Array.isArray(value)
                  ? value.status
                  : "invalid",
              ),
          }),
        );
        expect(await finishSample("specimen-a")).toBe("Ready for review");
      },
    });
    expect(result.verdict).toBe("passed");
    expect(result.drills[0]?.trials[0]?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "state_change",
        namespace: "audit",
        rowId: "specimen-a",
        after: { processed: true },
      }),
    );
  });
});
