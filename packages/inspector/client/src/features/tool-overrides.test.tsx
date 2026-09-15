import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProject, SimulationSetup } from "../types";
import { DrillsView } from "./drills";
import { overrideOutcomeLabel, overrideScopeLabel, ToolOverrides } from "./tool-overrides";

const rules: NonNullable<SimulationSetup["toolOverrides"]> = [
  {
    id: "cached-result",
    operation: { packageId: "archive", operationId: "lookup" },
    outcome: { kind: "return", value: null },
    scope: { kind: "baseline" },
  },
  {
    id: "offline",
    operation: { packageId: "archive", operationId: "lookup" },
    when: { actorId: "reader", arguments: { term: "<private>" } },
    outcome: { kind: "error", code: "UNAVAILABLE", message: "Try later", retryable: true },
    times: 1,
    scope: { kind: "scenario", scenarioId: "outage" },
  },
  {
    id: "restore",
    operation: { packageId: "archive", operationId: "lookup" },
    outcome: { kind: "original" },
    scope: { kind: "drill", drillId: "search" },
  },
];

describe("Tool override inspection", () => {
  beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing for absent and empty override collections", () => {
    expect(renderToStaticMarkup(<ToolOverrides rules={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ToolOverrides rules={[]} />)).toBe("");
  });

  it("shows exact scope, limits and outcome modes with wide data actions", () => {
    const markup = renderToStaticMarkup(<ToolOverrides rules={rules} />);
    for (const label of [
      "World baseline",
      "Scenario: outage",
      "Drill: search",
      "Fixed response",
      "Simulated error",
      "Original Tool behavior",
      "First 1 matching call",
      "Every matching call",
      "Actor: reader",
      "Any actor",
    ])
      expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Matching arguments: offline: matching arguments"');
    expect(markup).toContain('aria-label="View response: cached-result: fixed response"');
    expect(markup).toContain("fd-document-dialog");
    expect(markup).toContain("bottom to top");
    expect(markup).toContain("skip the Tool’s original behavior and state changes");
    expect(markup).not.toContain("<private>");
    expect(overrideScopeLabel({ kind: "run", drillId: "search" })).toBe("Test-local setup: search");
    expect(overrideOutcomeLabel("original")).toBe("Original Tool behavior");
  });

  it("shows effective drill rules directly alongside the task and checks", () => {
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
      suites: [],
      diagnostics: [],
      targets: [
        { id: "reader", kind: "external", bindings: ["direct"], runAvailability: "agent_callback_required" },
      ],
      drills: [
        {
          id: "search",
          tags: [],
          targetId: "reader",
          inlineScenario: true,
          trials: { count: 1, classification: "contract" },
          timeline: { interactions: 1, workloads: 0, horizonUs: 0, maxToolCalls: 10, maxEvents: 10 },
          assertions: 1,
          expectations: [],
          toolOverrides: rules,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <DrillsView project={project} starting={false} onStart={async () => undefined} />,
    );
    expect(markup).toContain('data-scroll-section="tool-overrides"');
    expect(markup).toContain("cached-result");
    expect(markup).toContain("Scenario: outage");
    expect(markup).toContain("Drill: search");
    expect(markup).toContain("Tool override rules");
  });
});
