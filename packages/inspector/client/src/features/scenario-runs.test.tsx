import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProject, SimulationRunSummary } from "../types";
import type { RunHistoryControls } from "./runs";
import { ScenarioRuns } from "./scenario-runs";
import { WorldView } from "./world";

function run(index: number, scenarioId?: string): SimulationRunSummary {
  return {
    schemaVersion: 1,
    runId: `run_record${index}`,
    worldInstanceId: `world-${index}`,
    drillId: "inspect-records",
    ...(scenarioId === undefined ? {} : { scenarioId }),
    targetId: "reader",
    seed: String(index),
    trial: 1,
    trialCount: 1,
    attempt: 1,
    attemptLimit: 1,
    status: "sealed",
    verdict: index % 2 === 0 ? "failed" : "passed",
    virtualTimeUs: 0,
    evidenceSequence: 0,
    reportAvailable: true,
  };
}

const history: RunHistoryControls = {
  hasMore: true,
  loadingOlder: false,
  refreshing: false,
  olderError: undefined,
  latestError: undefined,
  onLoadOlder: () => {},
  onRetryLatest: () => {},
};
const baseline = { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] };
const project: SimulationProject = {
  schemaVersion: 1,
  world: {
    id: "records",
    seed: "1",
    buildHash: `sha256:${"a".repeat(64)}`,
    packageLockHash: `sha256:${"b".repeat(64)}`,
    baseline,
  },
  scenarios: [
    { id: "day", ...baseline },
    { id: "night", ...baseline },
  ],
  drills: [],
  tools: [],
  targets: [],
  suites: [],
  diagnostics: [],
};

describe("scenario run history", () => {
  beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));
  afterEach(() => vi.unstubAllGlobals());

  it("matches only the recorded scenario, independently of current drill definitions", () => {
    const markup = renderToStaticMarkup(
      <ScenarioRuns scenarioId="night" runs={[run(1, "day"), run(2, "night"), run(3)]} />,
    );
    expect(markup).toContain('href="/runs?run=run_record2"');
    expect(markup).toContain('aria-label="Open run run_record2"');
    expect(markup).toContain("Failed");
    expect(markup).not.toContain("run_record1");
    expect(markup).not.toContain("run_record3");
    expect(markup).toContain("Earlier runs may use an older definition.");
  });

  it("shows five runs per page, accessible actions and continuation into older history", () => {
    const markup = renderToStaticMarkup(
      <ScenarioRuns
        scenarioId="night"
        runs={Array.from({ length: 7 }, (_, index) => run(index + 1, "night"))}
        history={history}
      />,
    );
    expect(markup.match(/href="\/runs\?run=/g)).toHaveLength(5);
    expect(markup).toContain("1–5 of 7");
    expect(markup).toContain('aria-label="Next scenario runs"');
    expect(markup).toContain("Load older runs");
    expect(markup).not.toContain("run_record6");
  });

  it("does not claim there are no runs when history is partial, unavailable or failed", () => {
    for (const props of [
      { history },
      { unavailableRunCount: 1 },
      { history: { ...history, hasMore: false, latestError: "Temporarily unavailable" } },
    ]) {
      const markup = renderToStaticMarkup(<ScenarioRuns scenarioId="night" runs={[]} {...props} />);
      expect(markup).toContain("No loaded runs for this scenario.");
      expect(markup).not.toContain("No runs recorded for this scenario.");
    }
    const complete = renderToStaticMarkup(<ScenarioRuns scenarioId="night" runs={[]} />);
    expect(complete).toContain("No runs recorded for this scenario.");
    expect(complete).not.toContain("Load older runs");
  });

  it.each(["world", "scenarios"] as const)(
    "shows history immediately in a selected scenario on %s",
    (page) => {
      const markup = renderToStaticMarkup(
        <WorldView
          page={page}
          project={project}
          scenarioId="night"
          runs={[run(1, "day"), run(2, "night")]}
        />,
      );
      expect(markup).toContain("<h2>Night</h2>");
      expect(markup).toContain('href="/runs?run=run_record2"');
      expect(markup).not.toContain("run_record1");
      expect(markup).toContain('data-scroll-section="runs"');
      expect(markup.indexOf('data-scroll-section="runs"')).toBeLessThan(
        markup.indexOf('data-scroll-section="data"'),
      );
    },
  );

  it("does not duplicate run history on the baseline world setup", () => {
    const markup = renderToStaticMarkup(<WorldView project={project} runs={[run(1, "night")]} />);
    expect(markup).not.toContain('data-scroll-section="runs"');
  });

  it.each(["deleted-scenario", "", "../unknown"])(
    "does not substitute baseline setup for missing scenario %s",
    (scenarioId) => {
      const markup = renderToStaticMarkup(
        <WorldView page="scenarios" project={project} scenarioId={scenarioId} runs={[run(1, "night")]} />,
      );
      expect(markup).toContain("Scenario unavailable");
      expect(markup).not.toContain('data-scroll-section="data"');
      expect(markup).not.toContain("run_record1");
    },
  );
});
