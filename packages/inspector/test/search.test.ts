import { describe, expect, it } from "vitest";
import {
  evidenceSearchText,
  matchesSearch,
  preferredEvidenceSequence,
  runSearchText,
} from "../client/src/search.js";
import type { EvidenceEntry, SimulationRunSummary } from "../client/src/types.js";

const operation = {
  kind: "operation",
  sequence: 4,
  actorId: "support-specialist",
  invocation: {
    operation: { packageId: "case-management", operationId: "ticket.resolve" },
    input: { ticketId: "case-42" },
  },
  outcome: { status: "tool_error", error: { code: "tool.NOT_OWNER" } },
} as unknown as EvidenceEntry;

const failedVerification = {
  kind: "verification",
  sequence: 8,
  result: { assertionId: "ticket-left-open", status: "failed" },
} as unknown as EvidenceEntry;

const laterLifecycle = {
  kind: "lifecycle",
  sequence: 9,
  action: "world_closed",
} as unknown as EvidenceEntry;

const run = {
  drillId: "safe-resolution",
  runId: "run_00000000000000000000000000000001",
  scenarioId: "unauthorized-actor",
  targetId: "support-agent",
  seed: "42",
  trial: 2,
  trialCount: 5,
  attempt: 1,
  attemptLimit: 2,
  status: "sealed",
  verdict: "failed",
} as unknown as SimulationRunSummary;

describe("inspector search", () => {
  it("finds causal evidence by actor, Tool, operation, payload, and result", () => {
    const text = evidenceSearchText(operation);
    expect(matchesSearch(text, "support-specialist ticket.resolve")).toBe(true);
    expect(matchesSearch(text, "case-management case-42 not_owner")).toBe(true);
    expect(matchesSearch(text, "different actor")).toBe(false);
  });

  it("finds runs by drill, scenario, target, result, seed, and trial", () => {
    const text = runSearchText(run);
    expect(matchesSearch(text, "safe resolution unauthorized actor")).toBe(true);
    expect(matchesSearch(text, "support-agent failed seed 42")).toBe(true);
    expect(matchesSearch(text, "trial 2 of 5")).toBe(true);
  });

  it("opens the failed assertion instead of a trailing lifecycle event", () => {
    expect(preferredEvidenceSequence([operation, failedVerification, laterLifecycle])).toBe(8);
  });
});
