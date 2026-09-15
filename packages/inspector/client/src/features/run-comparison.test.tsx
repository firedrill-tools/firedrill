import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectorApi } from "../api";
import type { SimulationRunDetail, SimulationRunSummary } from "../types";
import {
  comparisonChecks,
  defaultComparisonRuns,
  loadRunComparison,
  RunComparison,
  RunComparisonReport,
} from "./run-comparison";

type Result = NonNullable<SimulationRunDetail["result"]>;
type Check = Result["assertionResults"][number];
type Report = Parameters<typeof RunComparisonReport>[0];
const hash = `sha256:${"a".repeat(64)}`;

function summary(runId: string, overrides: Partial<SimulationRunSummary> = {}): SimulationRunSummary {
  return {
    schemaVersion: 1,
    runId,
    worldInstanceId: "world_compare",
    drillId: "inspect-record",
    scenarioId: "ordinary",
    targetId: "agent",
    seed: "41",
    trial: 1,
    trialCount: 1,
    attempt: 1,
    attemptLimit: 1,
    status: "sealed",
    verdict: "passed",
    virtualTimeUs: 0,
    evidenceSequence: 1,
    reportAvailable: true,
    ...overrides,
  };
}

function check(overrides: Partial<Check> = {}): Check {
  return {
    schemaVersion: 1,
    assertionId: "record-count",
    kind: "state.count",
    status: "passed",
    gate: true,
    message: "Count matched.",
    expected: { operator: "equals", value: 2 },
    actual: 2,
    location: { subject: "state", packageId: "records", namespace: "items", path: [] },
    diff: { operator: "equals", matched: true, details: {} },
    evidenceSequences: [],
    ...overrides,
  };
}

function checkpoint(checks: Check[], checkpointId = "final"): Result["checkpoints"][number] {
  return {
    schemaVersion: 1,
    checkpointId,
    kind: "final",
    virtualTimeUs: 0,
    verdict: "passed",
    assertionResults: checks,
  };
}

function detail(runId: string, checks: Check[] = [check()]): Report["baseline"] {
  const runSummary = summary(runId);
  return {
    schemaVersion: 1,
    summary: runSummary,
    stateNamespaces: [],
    faults: [],
    scheduledEvents: [],
    callbackDeliveries: [],
    result: {
      schemaVersion: 1,
      status: "sealed",
      verdict: "passed",
      identity: {
        runId,
        worldInstanceId: runSummary.worldInstanceId,
        drillId: runSummary.drillId,
        scenarioId: "ordinary",
        targetId: runSummary.targetId,
        seed: runSummary.seed,
        buildHash: hash,
        packageLockHash: hash,
        trial: 1,
        trialCount: 1,
        attempt: 1,
        attemptLimit: 1,
      },
      startedAtVirtualUs: 0,
      finishedAtVirtualUs: 0,
      bindingEvidence: "issued",
      worldConsistency: "atomic",
      interactions: [],
      checkpoints: checks.length === 0 ? [] : [checkpoint(checks)],
      assertionResults: checks,
      budgetUsage: {
        toolCalls: { limit: 100, attempted: 0, rejected: 0 },
        scheduledEvents: { limit: 100, processed: 0, exhausted: false },
      },
      evidenceRange: { fromSequence: 1, toSequence: 1 },
      stateHash: hash,
      trajectoryHash: hash,
      evidenceHash: hash,
    },
  };
}

function report(before: Check[] = [check()], after: Check[] = [check()]): Report {
  const compared = {
    status: "sealed" as const,
    verdict: "passed" as const,
    drillId: "inspect-record",
    scenarioId: "ordinary",
    targetId: "agent",
    seed: "41",
    buildHash: hash,
    packageLockHash: hash,
    stateHash: hash,
    trajectoryHash: hash,
  };
  return {
    baseline: detail("run_baseline", before),
    candidate: detail("run_candidate", after),
    comparison: {
      schemaVersion: 1,
      baseline: { ...compared, runId: "run_baseline" },
      candidate: { ...compared, runId: "run_candidate" },
      compatibility: {
        status: "exact_inputs",
        canAttributeBehaviorChange: true,
        differences: [],
        explanation: "The recorded test inputs match.",
      },
      outcome: "unchanged",
      changes: {
        verdictChanged: false,
        stateChanged: false,
        trajectoryChanged: false,
        operationCounts: [],
        stateChangeCounts: [],
        eventCounts: [],
        assertions: [],
        interactions: [],
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("comparison selection and check pairing", () => {
  it("defaults to the selected candidate and a matching drill, scenario and seed before list order", () => {
    const runs = [summary("run_different", { seed: "3" }), summary("run_candidate"), summary("run_match")];
    expect(defaultComparisonRuns(runs, "run_candidate")).toEqual({
      baselineRunId: "run_match",
      candidateRunId: "run_candidate",
    });
  });

  it("excludes unavailable reports, keeps distinct runs and falls back when selection disappeared", () => {
    const runs = [
      summary("run_unavailable", { reportAvailable: false }),
      summary("run_one"),
      summary("run_two", { drillId: "different" }),
    ];
    expect(defaultComparisonRuns(runs, "run_missing")).toEqual({
      baselineRunId: "run_two",
      candidateRunId: "run_one",
    });
    expect(defaultComparisonRuns([runs[1] as SimulationRunSummary], undefined)).toEqual({
      baselineRunId: "",
      candidateRunId: "run_one",
    });
    expect(defaultComparisonRuns([], undefined)).toEqual({ baselineRunId: "", candidateRunId: "" });
  });

  it("matches checkpoint and assertion together, preserving added and removed checks", () => {
    const rows = comparisonChecks(
      { checkpoints: [checkpoint([check()], "first"), checkpoint([check()], "final")] },
      { checkpoints: [checkpoint([check({ actual: 3 })], "first"), checkpoint([check()], "new-checkpoint")] },
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.checkpointId === "first")).toMatchObject({
      actualChanged: true,
      statusChanged: false,
    });
    expect(rows.find((row) => row.checkpointId === "final")).toMatchObject({
      changed: true,
    });
    expect(rows.find((row) => row.checkpointId === "final")?.candidate).toBeUndefined();
    expect(rows.find((row) => row.checkpointId === "new-checkpoint")).toMatchObject({
      changed: true,
    });
    expect(rows.find((row) => row.checkpointId === "new-checkpoint")?.baseline).toBeUndefined();
  });

  it("includes expectation-only and operator-only changes without calling a passed check failed", () => {
    const rows = comparisonChecks(
      { checkpoints: [checkpoint([check()])] },
      { checkpoints: [checkpoint([check({ expected: { operator: "greater_than_or_equal", value: 2 } })])] },
    );
    expect(rows[0]).toMatchObject({
      statusChanged: false,
      actualChanged: false,
      expectedChanged: true,
      changed: true,
    });
    expect(rows[0]?.candidate?.status).toBe("passed");
  });

  it("ignores object key ordering but preserves null, missing values, and array order", () => {
    const before = [
      check({ actual: { a: 1, b: 2 } }),
      check({ assertionId: "array", actual: [1, 2] }),
      check({ assertionId: "null", actual: null }),
    ];
    const after = [check({ actual: { b: 2, a: 1 } }), check({ assertionId: "array", actual: [2, 1] })];
    const rows = comparisonChecks(
      { checkpoints: [checkpoint(before)] },
      { checkpoints: [checkpoint(after)] },
    );
    expect(rows[0]?.changed).toBe(false);
    expect(rows[1]?.actualChanged).toBe(true);
    expect(rows[2]?.actualChanged).toBe(true);
  });
});

describe("inline comparison report", () => {
  it("shows actual and changed expected values inline with conditions and recorded statuses", () => {
    const data = report([check()], [check({ expected: { operator: "greater_than_or_equal", value: 2 } })]);
    const markup = renderToStaticMarkup(<RunComparisonReport {...data} />);
    expect(markup).toContain("1 changed · 1 total");
    expect(markup).toContain("Actual values (unchanged)");
    expect(markup).toContain("Baseline actual");
    expect(markup).toContain("Candidate actual");
    expect(markup).toContain("Baseline expected");
    expect(markup).toContain("Candidate expected");
    expect(markup).toContain("Actual must equal the expected value.");
    expect(markup).toContain("Actual must be at least the expected value.");
    expect(markup).not.toContain("&quot;operator&quot;");
    expect(markup).not.toContain(">Failed<");
    expect(markup).not.toContain("No result changes");
  });

  it("keeps non-comparison business operator/value objects intact", () => {
    const markup = renderToStaticMarkup(
      <RunComparisonReport
        {...report(
          [check({ kind: "operation.arguments", expected: { operator: "equals", value: { a: 1 } } })],
          [check({ kind: "operation.arguments", expected: { operator: "equals", value: { a: 2 } } })],
        )}
      />,
    );
    expect(markup).toContain("&quot;operator&quot;");
    expect(markup).toContain("&quot;value&quot;");
    expect(markup).not.toContain("Actual must equal the expected value.");
  });

  it("renders only changed checks by default and does not repeat unchanged expected diffs", () => {
    const markup = renderToStaticMarkup(
      <RunComparisonReport
        {...report(
          [check(), check({ assertionId: "same-check" })],
          [check({ actual: 3, status: "failed" }), check({ assertionId: "same-check" })],
        )}
      />,
    );
    expect(markup).toContain("Show unchanged checks");
    expect(markup).toContain("1 changed · 2 total");
    expect(markup).not.toContain("same-check");
    expect(markup).toContain("Expected in both runs");
    expect(markup).toContain("<pre>2</pre>");
    expect(markup).not.toContain("Baseline expected");
  });

  it("bounds checks and keeps pagination outside their articles", () => {
    const before = Array.from({ length: 13 }, (_, index) => check({ assertionId: `check-${index}` }));
    const markup = renderToStaticMarkup(
      <RunComparisonReport
        {...report(
          before,
          before.map((item) => ({ ...item, actual: 3 })),
        )}
      />,
    );
    expect(markup).toContain("check-9");
    expect(markup).not.toContain("check-10");
    expect(markup).toContain("1–10 of 13");
    expect(markup.indexOf('aria-label="Compared checks pages"')).toBeGreaterThan(
      markup.lastIndexOf("</article>"),
    );
  });

  it("includes error-only operation changes and paginates the complete count rows", () => {
    const data = report();
    data.comparison.changes.operationCounts = Array.from({ length: 13 }, (_, index) => ({
      subject: `records.read-${index}`,
      baseline: 2,
      candidate: 2,
      delta: 0,
      baselineErrors: 0,
      candidateErrors: 1,
    }));
    const markup = renderToStaticMarkup(<RunComparisonReport {...data} />);
    expect(markup).toContain("Baseline errors");
    expect(markup).toContain("Candidate errors");
    expect(markup).toContain("records.read-9");
    expect(markup).not.toContain("records.read-10");
    expect(markup).toContain("<td>2</td><td>2</td><td>0</td><td>0</td><td>1</td>");
    expect(markup.indexOf('aria-label="Operation changes pages"')).toBeGreaterThan(
      markup.indexOf("</table>"),
    );
  });

  it("states the limits of final-data comparison and shows interaction status changes", () => {
    const data = report([], []);
    delete data.comparison.changes.stateChanged;
    data.comparison.changes.interactions = [
      { interactionId: "inspect-item", baseline: "completed", candidate: "failed" },
    ];
    const markup = renderToStaticMarkup(<RunComparisonReport {...data} />);
    expect(markup).toContain("Final data comparison not recorded.");
    expect(markup).toContain("Both runs need a recorded final state hash");
    expect(markup).toContain("Model-generated responses may still vary");
    expect(markup).toContain("No checks were recorded in either run.");
    expect(markup).toContain("Interaction status changes");
    expect(markup).toContain("inspect-item");
    expect(markup).toContain("<td>Completed</td><td>Failed</td>");
  });

  it("is a selectable inline workspace, not a dialog, and explains the empty state", () => {
    const markup = renderToStaticMarkup(
      <RunComparison
        runs={[summary("run_baseline"), summary("run_candidate")]}
        selectedRunId="run_candidate"
      />,
    );
    expect(markup).toContain('aria-label="Baseline run"');
    expect(markup).toContain('aria-label="Candidate run"');
    expect(markup).toContain("Comparing saved reports");
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain('role="dialog"');
    const empty = renderToStaticMarkup(<RunComparison runs={[]} selectedRunId={undefined} />);
    expect(empty).toContain("At least two saved reports are needed");
  });
});

describe("verified report loading", () => {
  it("loads the comparison and both selected report details without requesting raw state", async () => {
    const data = report();
    const compare = vi.spyOn(inspectorApi, "compareRuns").mockResolvedValue(data.comparison);
    const run = vi
      .spyOn(inspectorApi, "run")
      .mockImplementation(async (runId) => (runId === "run_baseline" ? data.baseline : data.candidate));
    const state = vi.spyOn(inspectorApi, "state");
    expect(
      await loadRunComparison({ baselineRunId: "run_baseline", candidateRunId: "run_candidate" }),
    ).toEqual(data);
    expect(compare).toHaveBeenCalledWith("run_baseline", "run_candidate");
    expect(run.mock.calls).toEqual([["run_baseline"], ["run_candidate"]]);
    expect(state).not.toHaveBeenCalled();
  });

  it("rejects missing reports and mismatched identities instead of presenting stale values", async () => {
    const data = report();
    vi.spyOn(inspectorApi, "compareRuns").mockResolvedValue(data.comparison);
    const { result: _result, ...missing } = data.baseline;
    const run = vi
      .spyOn(inspectorApi, "run")
      .mockImplementation(async (runId) => (runId === "run_baseline" ? missing : data.candidate));
    const pair = { baselineRunId: "run_baseline", candidateRunId: "run_candidate" };
    await expect(loadRunComparison(pair)).rejects.toThrow("A saved report is no longer available");
    run.mockResolvedValue(data.candidate);
    await expect(loadRunComparison(pair)).rejects.toThrow("do not match the selected runs");
  });
});
