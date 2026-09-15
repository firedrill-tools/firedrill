import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OperationOutcomeSchema, type ToolOverride } from "@firedrill/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentCallback, createLocalWorld, runDrills, verifyReport } from "../src/index.js";

const roots: string[] = [];
const operation = { packageId: "reservations", operationId: "slots.reserve" };
const stub: ToolOverride = {
  id: "availability",
  operation,
  outcome: { kind: "return", value: { slotId: "morning", reserved: false } },
};
const once: ToolOverride = {
  id: "first-conflict",
  operation,
  times: 1,
  outcome: { kind: "error", code: "OCCUPIED", message: "Retry this reservation" },
};

function repository(bindings: string[] = ["direct"]): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-scoped-sdk-"));
  roots.push(root);
  cpSync(fileURLToPath(new URL("../../compiler/test/fixtures/appointments/", import.meta.url)), root, {
    recursive: true,
  });
  writeFileSync(
    join(root, "world", "booking-agent.target.json"),
    JSON.stringify({
      schemaVersion: 1,
      target: { id: "booking-agent", kind: "external", bindings, timeoutMs: 5_000 },
    }),
  );
  return root;
}

function appendRules(root: string, path: string, rules: ToolOverride[]): void {
  const file = join(root, "world", path);
  writeFileSync(file, `${readFileSync(file, "utf8")}\ntoolOverrides: ${JSON.stringify(rules)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("public scoped Tool overrides", () => {
  it.each(["http", "cli"])(
    "applies scoped rules through the %s binding and reproduces the exact setup",
    async (protocol) => {
      const root = repository([protocol]);
      appendRules(root, "world.yaml", [stub]);
      appendRules(root, "busy-morning.scenario.yaml", [{ ...stub, outcome: { kind: "original" } }]);
      writeFileSync(
        join(root, "world", "retry.drill.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "retry",
          targetId: "booking-agent",
          actorId: "scheduler",
          scenarioId: "busy-morning",
          toolOverrides: [stub],
          task: { instruction: "Try reservations with controlled responses." },
          assertions: [
            {
              id: "three-calls",
              kind: "operation.count",
              operation,
              comparison: { operator: "equals", value: 3 },
            },
            {
              id: "one-real-reservation",
              kind: "state.value",
              packageId: "reservations",
              namespace: "slots",
              rowId: "morning",
              path: ["reservedBy"],
              comparison: { operator: "equals", value: "customer-c" },
            },
          ],
        }),
      );
      const agent: AgentCallback = async ({ binding }) => {
        const prefix = protocol === "http" ? "FIREDRILL_HTTP" : "FIREDRILL_CLI";
        const outcomes = [];
        for (const customerId of ["customer-a", "customer-b", "customer-c"]) {
          const response = await fetch(
            `${binding.environment[`${prefix}_URL`]}/v1/operations/reservations/slots.reserve`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${binding.environment[`${prefix}_TOKEN`]}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                arguments: { slotId: "morning", customerId },
                idempotencyKey: customerId,
              }),
            },
          );
          const body = (await response.json()) as { outcome: unknown };
          outcomes.push(OperationOutcomeSchema.parse(body.outcome));
        }
        expect(outcomes).toEqual([
          expect.objectContaining({
            status: "tool_error",
            error: expect.objectContaining({ code: "tool.OCCUPIED" }),
          }),
          { status: "ok", value: { slotId: "morning", reserved: false } },
          { status: "ok", value: { slotId: "morning", reserved: true } },
        ]);
      };
      const first = await runDrills({
        root,
        drill: "retry",
        agent,
        setup: {
          scenario: {
            toolOverrides: [
              once,
              {
                id: "allow-final-attempt",
                operation,
                when: { arguments: { customerId: "customer-c" } },
                outcome: { kind: "original" },
              },
            ],
          },
        },
      });
      expect(first.verdict).toBe("passed");
      const trial = first.drills[0]?.trials[0];
      expect(
        trial?.evidence.filter((entry) => entry.kind === "operation").map((entry) => entry.toolOverride),
      ).toEqual([
        { id: "first-conflict", scope: { kind: "run", drillId: "retry" }, outcome: "error", matchIndex: 1 },
        { id: "availability", scope: { kind: "drill", drillId: "retry" }, outcome: "return", matchIndex: 1 },
        {
          id: "allow-final-attempt",
          scope: { kind: "run", drillId: "retry" },
          outcome: "original",
          matchIndex: 1,
        },
      ]);
      if (trial === undefined) throw new Error("missing report");
      expect(verifyReport({ report: trial.report.directory }).result.verdict).toBe("passed");
      expect(readFileSync(trial.report.files.html, "utf8")).toContain("Override: first-conflict");
      expect(readFileSync(trial.report.files.html, "utf8")).toContain("without running the tool");
      const repeated = await runDrills({ root, drill: "retry", agent, buildHash: first.buildHash });
      expect(repeated.verdict).toBe("passed");
      expect(repeated.drills[0]?.trials[0]?.result.trajectoryHash).toBe(trial.result.trajectoryHash);
    },
  );

  it("restores once counters and rules on full and package reset through the public SDK", async () => {
    const root = repository();
    appendRules(root, "reserve-slot.drill.yaml", [once]);
    const world = await createLocalWorld({ root, drill: "reserve-slot" });
    const call = (key: string) =>
      world.call({
        actorId: "scheduler",
        ...operation,
        arguments: { slotId: "morning", customerId: "customer-a" },
        idempotencyKey: key,
      });
    try {
      expect(call("first").outcome.status).toBe("tool_error");
      expect(call("second").outcome.status).toBe("ok");
      world.reset();
      expect(call("first").outcome.status).toBe("tool_error");
      expect(call("second").outcome.status).toBe("ok");
      world.reset({ packages: ["reservations"] });
      expect(call("first").outcome.status).toBe("tool_error");
      expect(call("second").outcome.status).toBe("ok");
    } finally {
      world.close();
    }
  });
});
