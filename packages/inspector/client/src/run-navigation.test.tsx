import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsView } from "./features/runs";
import {
  navigateInspector,
  type RunSelection,
  readInspectorLocation,
  readRunSelection,
  readScenarioId,
  resolveLinkedRun,
  runHref,
  scenarioHref,
} from "./navigation";
import type { SimulationProject, SimulationRunDetail, SimulationRunSummary } from "./types";

const firstId = "run_first0001";
const olderId = "run_older0002";
const project: SimulationProject = {
  schemaVersion: 1,
  world: {
    id: "readings",
    seed: "7",
    buildHash: `sha256:${"a".repeat(64)}`,
    packageLockHash: `sha256:${"b".repeat(64)}`,
    baseline: { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] },
  },
  tools: [],
  scenarios: [],
  targets: [],
  drills: [],
  suites: [],
  diagnostics: [],
};

function summary(runId: string, drillId = "selected-reading"): SimulationRunSummary {
  return {
    schemaVersion: 1,
    runId,
    worldInstanceId: `world_${runId.slice(4)}`,
    drillId,
    scenarioId: "night-readings",
    targetId: "reader",
    seed: "7",
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

function detail(runId: string): SimulationRunDetail {
  return {
    schemaVersion: 1,
    summary: summary(runId),
    stateNamespaces: [],
    faults: [],
    scheduledEvents: [],
    callbackDeliveries: [],
  };
}

function view(selection: RunSelection, runs = [summary(firstId, "wrong-first-reading")]) {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <RunsView
      project={project}
      runs={runs}
      selection={selection}
      requests={[]}
      starting={false}
      cancelling={false}
      onCancel={noop}
      onRerun={noop}
      onOpenReport={noop}
      onNavigateDrills={noop}
      onError={noop}
      onSelectRun={noop}
      onClearSelection={noop}
    />,
  );
}

function browser(initial: string) {
  const entries = [initial];
  let index = 0;
  const port = {
    get location() {
      return new URL(entries[index] ?? "/world", "http://127.0.0.1:4318");
    },
    history: {
      pushState(_data: unknown, _unused: string, url?: string | URL | null) {
        entries.splice(index + 1);
        entries.push(String(url));
        index += 1;
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        entries[index] = String(url);
      },
    },
  };
  return {
    port,
    entries,
    back: () => {
      index = Math.max(0, index - 1);
      return readInspectorLocation(port.location);
    },
    forward: () => {
      index = Math.min(entries.length - 1, index + 1);
      return readInspectorLocation(port.location);
    },
  };
}

beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));
afterEach(() => vi.unstubAllGlobals());

describe("exact run navigation", () => {
  it("writes durable run URLs and parses the same selection on initial load or reload", () => {
    const href = runHref(olderId);
    expect(href).toBe(`/runs?run=${olderId}`);
    const loaded = readInspectorLocation(new URL(href, "http://127.0.0.1:4318"));
    expect(loaded.route).toBe("/runs");
    expect(readRunSelection(loaded.search)).toEqual({ kind: "explicit", runId: olderId });
    expect(readRunSelection("")).toEqual({ kind: "automatic" });
    expect(runHref("run_id&run=other")).toBe("/runs?run=run_id%26run%3Dother");
  });

  it("replaces scenario selection but pushes exact run choices for Back and Forward", () => {
    const history = browser("/scenarios");
    navigateInspector(scenarioHref("/scenarios", "day-readings"), history.port, true);
    navigateInspector(scenarioHref("/scenarios", "night-readings"), history.port, true);
    expect(history.entries).toEqual(["/scenarios?scenario=night-readings"]);
    navigateInspector(runHref(firstId), history.port);
    navigateInspector(runHref(olderId), history.port);
    navigateInspector(runHref(olderId), history.port);
    expect(history.entries).toHaveLength(3);
    expect(readRunSelection(history.back().search)).toEqual({ kind: "explicit", runId: firstId });
    const origin = history.back();
    expect(origin.route).toBe("/scenarios");
    expect(readScenarioId(origin.search)).toBe("night-readings");
    expect(readRunSelection(history.forward().search)).toEqual({ kind: "explicit", runId: firstId });
    expect(readRunSelection(history.forward().search)).toEqual({ kind: "explicit", runId: olderId });
  });

  it("preserves World scenario links and clears scenario queries when selecting setup", () => {
    const history = browser("/world?scenario=night-readings");
    navigateInspector(runHref(olderId), history.port);
    expect(readScenarioId(history.back().search)).toBe("night-readings");
    navigateInspector(scenarioHref("/world", undefined), history.port, true);
    expect(history.port.location.search).toBe("");
    expect(readInspectorLocation({ pathname: "/unknown", search: "?run=bad" })).toEqual({
      route: "/tools",
      search: "",
    });
  });

  it("keeps explicit bad scenario links distinct from no selection", () => {
    expect(readScenarioId("")).toBeUndefined();
    expect(readScenarioId("?scenario=")).toBe("");
    expect(readScenarioId("?scenario=../unknown")).toBe("../unknown");
    expect(readScenarioId("?scenario=night&scenario=day")).toBe("");
  });

  it.each([
    "?run=",
    "?run=unknown",
    "?run=../outside",
    "?run=run_first0001&run=run_older0002",
    `?run=run_${"a".repeat(97)}`,
  ])("rejects malformed explicit selection %s without falling back to another run", (search) => {
    const selection = readRunSelection(search);
    expect(selection.kind).toBe("invalid");
    const markup = view(selection);
    expect(markup).toContain("Run unavailable");
    expect(markup).toContain("View loaded runs");
    expect(markup).not.toContain("<h2>Wrong first reading</h2>");
    expect(markup).not.toContain('aria-current="true"');
  });

  it("selects an exact loaded run instead of the first run", () => {
    const markup = view({ kind: "explicit", runId: olderId }, [
      summary(firstId, "wrong-first-reading"),
      summary(olderId),
    ]);
    expect(markup).toContain("<h2>Selected reading</h2>");
    expect(markup).not.toContain("<h2>Wrong first reading</h2>");
    expect(markup).toContain('aria-current="true"');
  });

  it("keeps an unlisted exact run in a loading state rather than selecting the first run or showing no runs", () => {
    for (const runs of [[summary(firstId, "wrong-first-reading")], []]) {
      const markup = view({ kind: "explicit", runId: olderId }, runs);
      expect(markup).toContain("Opening requested run");
      expect(markup).toContain(olderId);
      expect(markup).not.toContain("<h2>Wrong first reading</h2>");
      expect(markup).not.toContain("No drill runs yet");
    }
  });

  it("looks up an older run by exact identity without requiring it in the loaded list", async () => {
    const read = vi.fn(async (runId: string) => detail(runId));
    const selected = await resolveLinkedRun(olderId, read);
    expect(read).toHaveBeenCalledExactlyOnceWith(olderId);
    expect(selected.summary.runId).toBe(olderId);
  });

  it("retains lookup failure and refuses another run returned for the requested ID", async () => {
    await expect(
      resolveLinkedRun(olderId, async () => {
        throw new Error("Saved run not found.");
      }),
    ).rejects.toThrow("Saved run not found.");
    await expect(resolveLinkedRun(olderId, async () => detail(firstId))).rejects.toThrow(
      "does not match the requested run",
    );
    const read = vi.fn(async () => detail(firstId));
    await expect(resolveLinkedRun("../outside", read)).rejects.toThrow("valid run ID");
    expect(read).not.toHaveBeenCalled();
  });
});
