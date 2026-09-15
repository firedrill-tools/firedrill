import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProject, SimulationRunSummary } from "../types";
import { RunsView } from "./runs";

const project: SimulationProject = {
  schemaVersion: 1,
  world: {
    id: "archive",
    seed: "1",
    buildHash: `sha256:${"a".repeat(64)}`,
    packageLockHash: `sha256:${"b".repeat(64)}`,
    baseline: { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] },
  },
  scenarios: [],
  tools: [],
  targets: [],
  drills: [],
  suites: [],
  diagnostics: [],
};

function run(index: number): SimulationRunSummary {
  return {
    schemaVersion: 1,
    runId: `run-${index}`,
    worldInstanceId: `world-${index}`,
    drillId: `archive-check-${index}`,
    targetId: "reader",
    seed: String(index),
    trial: 1,
    trialCount: 1,
    attempt: 1,
    attemptLimit: 1,
    status: "sealed",
    verdict: "passed",
    virtualTimeUs: 0,
    evidenceSequence: 0,
    reportAvailable: true,
  };
}

function renderRuns(count: number) {
  const noop = () => {};
  return renderToStaticMarkup(
    <RunsView
      project={project}
      runs={Array.from({ length: count }, (_, index) => run(index + 1))}
      requests={[]}
      starting={false}
      cancelling={false}
      onCancel={noop}
      onRerun={noop}
      onOpenReport={noop}
      onNavigateDrills={noop}
      onError={noop}
    />,
  );
}

describe("run list pagination", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("mounts one page and preserves the full result count and selected run", () => {
    const markup = renderRuns(57);
    expect(markup.match(/class="[^"]*\bfd-run-list-item(?:\s|")/g)).toHaveLength(25);
    expect(markup).toContain('aria-label="Runs pages"');
    expect(markup).toContain("1–25 of 57");
    expect(markup).toContain('aria-label="Previous runs"');
    expect(markup).toContain('aria-label="Next runs"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Archive check 25");
    expect(markup).not.toContain("Archive check 26");
    expect(markup).toContain("<h2>Archive check 1</h2>");
  });

  it.each([1, 25])("avoids redundant page controls for %i runs", (count) => {
    const markup = renderRuns(count);
    expect(markup.match(/class="[^"]*\bfd-run-list-item(?:\s|")/g)).toHaveLength(count);
    expect(markup).not.toContain('aria-label="Runs pages"');
  });

  it("preserves the empty-state action without an empty pager", () => {
    const markup = renderRuns(0);
    expect(markup).toContain("No drill runs yet");
    expect(markup).toContain("Choose a drill");
    expect(markup).not.toContain('aria-label="Runs pages"');
  });
});
