import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProject, SimulationSetup, SimulationTool } from "../types";
import { ToolOverrides } from "./tool-overrides";
import { WorldView } from "./world";

const emptySetup: SimulationSetup = {
  virtualTimeUs: 0,
  actors: [],
  state: [],
  faults: [],
  initialEvents: [],
};

function tool(id: string, operationCount = 0): SimulationTool {
  return {
    id,
    version: "1.0.0",
    stateNamespaces: [],
    events: [],
    faults: [],
    httpRoutes: [],
    operations: Array.from({ length: operationCount }, (_, index) => ({
      id: `operation-${index}`,
      fidelity: "stateful",
      idempotency: "none",
    })),
  };
}

function project(baseline = emptySetup): SimulationProject {
  return {
    schemaVersion: 1,
    world: {
      id: "reading-room",
      seed: "1",
      buildHash: `sha256:${"a".repeat(64)}`,
      packageLockHash: `sha256:${"b".repeat(64)}`,
      baseline,
    },
    scenarios: [],
    tools: [],
    targets: [],
    drills: [],
    suites: [],
    diagnostics: [],
  };
}

function rail(markup: string): string {
  return markup.match(/<aside class="fd-workspace-rail">([\s\S]*?)<\/aside>/)?.[1] ?? "";
}

describe("world collection pagination", () => {
  beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));
  afterEach(() => vi.unstubAllGlobals());

  it("bounds the combined rail at 25 entries while preserving setup and only visible group headings", () => {
    const definitions = project();
    definitions.scenarios = Array.from({ length: 30 }, (_, index) => ({
      ...emptySetup,
      id: `scenario-${index}`,
      title: `Scenario ${index}`,
    }));
    definitions.tools = [tool("one-tool")];
    const markup = rail(renderToStaticMarkup(<WorldView project={definitions} />));
    expect(markup.match(/class="[^"]*fd-rail-item[^"]*"/g)).toHaveLength(26);
    expect(markup).toContain("World setup");
    expect(markup).toContain('fd-rail-section-label">Scenarios');
    expect(markup).not.toContain('fd-rail-section-label">Tools');
    expect(markup).toContain("Scenario 24");
    expect(markup).not.toContain("Scenario 25");
    expect(markup).toContain("1–25 of 31");
    expect(markup).toContain('aria-label="Next world contents"');
  });

  it("uses the same bound on tool and scenario rails without adding a setup item", () => {
    const definitions = project();
    definitions.tools = Array.from({ length: 26 }, (_, index) => tool(`tool-${index}`));
    definitions.scenarios = Array.from({ length: 26 }, (_, index) => ({
      ...emptySetup,
      id: `scenario-${index}`,
    }));
    for (const page of ["tools", "scenarios"] as const) {
      const markup = rail(renderToStaticMarkup(<WorldView project={definitions} page={page} />));
      expect(markup.match(/class="[^"]*fd-rail-item[^"]*"/g)).toHaveLength(25);
      expect(markup).not.toContain("World setup");
      expect(markup).toContain("1–25 of 26");
      expect(markup).toContain(`aria-label="Next ${page}"`);
    }
  });

  it("bounds setup records, actors, grants, faults and events independently", () => {
    const many = Array.from({ length: 13 }, (_, index) => index);
    const baseline: SimulationSetup = {
      ...emptySetup,
      state: many.map((index) => ({
        action: "upsert",
        packageId: "archive",
        namespace: "volumes",
        rowId: `record-${String(index).padStart(2, "0")}`,
        value: { edition: index },
      })),
      actors: many.map((index) => ({
        id: `actor-${index}`,
        attributes: {},
        grants: many.map((grant) => ({ packageId: "archive", operationId: `grant-${grant}` })),
      })),
      faults: many.map((index) => ({ packageId: "archive", faultId: `fault-${index}` })),
      initialEvents: many.map((index) => ({
        event: { packageId: "archive", eventId: `event-${index}` },
        atUs: index,
        actorId: "actor-0",
        payload: {},
      })),
    };
    const markup = renderToStaticMarkup(<WorldView project={project(baseline)} />);
    expect(markup).toContain("record-09");
    expect(markup).not.toContain("record-10");
    for (const item of ["actor", "grant", "fault", "event"]) {
      expect(markup).toContain(`${item}-9`);
      expect(markup).not.toContain(`${item}-10`);
    }
    for (const label of [
      "starting records",
      "actors",
      "actor-0 allowed operations",
      "simulated failures",
      "scheduled events",
    ]) {
      expect(markup).toContain(`aria-label="Next ${label}"`);
    }
  });

  it("bounds operations with controls outside the operation table", () => {
    const definitions = project();
    definitions.tools = [tool("archive", 13)];
    const markup = renderToStaticMarkup(<WorldView project={definitions} page="tools" />);
    expect(markup).toContain("operation-9");
    expect(markup).not.toContain("operation-10");
    expect(markup.indexOf('aria-label="Tool operations pages"')).toBeGreaterThan(markup.indexOf("</table>"));
  });

  it("bounds scenario fault-change rows without losing removed-fault access", () => {
    const definitions = project({
      ...emptySetup,
      faults: Array.from({ length: 13 }, (_, index) => ({
        packageId: "archive",
        faultId: `removed-${index}`,
      })),
    });
    definitions.scenarios = [{ id: "clear-failures", ...emptySetup }];
    const markup = renderToStaticMarkup(<WorldView project={definitions} page="scenarios" />);
    expect(markup).toContain("archive.removed-9");
    expect(markup).not.toContain("archive.removed-10");
    expect(markup).toContain('aria-label="Next setup changes"');
    expect(markup).toContain("1–10 of 13");
  });

  it("pages override definitions without implying current-page priority is global", () => {
    const rules: NonNullable<SimulationSetup["toolOverrides"]> = Array.from({ length: 13 }, (_, index) => ({
      id: `override-${index}`,
      operation: { packageId: "archive", operationId: "read" },
      outcome: { kind: "original" },
      scope: { kind: "baseline" },
    }));
    const markup = renderToStaticMarkup(<ToolOverrides rules={rules} />);
    expect(markup).toContain("override-9");
    expect(markup).not.toContain("override-10");
    expect(markup).toContain("bottom to top across all pages");
    expect(markup).toContain('aria-label="Next tool override rules"');
    expect(markup.indexOf('aria-label="Tool override rules pages"')).toBeGreaterThan(
      markup.indexOf("</table>"),
    );
    expect(renderToStaticMarkup(<ToolOverrides rules={rules.slice(0, 10)} />)).not.toContain(
      "Next tool override rules",
    );
  });
});
