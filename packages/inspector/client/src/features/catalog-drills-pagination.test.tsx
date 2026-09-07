import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationDrill, SimulationProject } from "../types";
import { CatalogView } from "./catalog";
import { DrillsView } from "./drills";

function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

function project(): SimulationProject {
  return {
    schemaVersion: 1,
    world: {
      id: "archive",
      seed: "1",
      buildHash: `sha256:${"a".repeat(64)}`,
      packageLockHash: `sha256:${"b".repeat(64)}`,
      baseline: { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] },
    },
    tools: [],
    scenarios: [],
    drills: [],
    suites: [],
    targets: [],
    diagnostics: [],
  };
}

function drill(id: string): SimulationDrill {
  return {
    id,
    title: id,
    tags: [],
    targetId: "reader",
    inlineScenario: true,
    trials: { count: 1, classification: "contract" },
    timeline: { interactions: 11, workloads: 11, horizonUs: 100, maxToolCalls: 100, maxEvents: 100 },
    assertions: 11,
    expectations: names("check", 11).map((name) => ({
      id: name,
      checkpoint: "final",
      gate: true,
      kind: "operation.count",
    })),
    execution: {
      horizonUs: 100,
      maxToolCalls: 100,
      maxEvents: 100,
      stopOnInvariantFailure: true,
      stopOnTargetFailure: true,
      invariants: [],
      interactions: names("interaction", 11).map((name) => ({
        id: name,
        actorId: "reader",
        afterStartUs: 0,
        task: { instruction: `Instruction ${name}` },
      })),
      workloads: names("workload", 11).map((name) => ({
        id: name,
        actorIds: names("actor", 11),
        occurrences: 2,
        startAfterUs: 0,
        everyUs: 1,
        task: { instruction: `Instruction ${name}` },
      })),
    },
  };
}

describe("catalog and drill pagination", () => {
  beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));
  afterEach(() => vi.unstubAllGlobals());

  it("bounds the drill rail, task collections, workload actors and checks independently", () => {
    const source = project();
    source.drills = names("drill", 26).map(drill);
    const markup = renderToStaticMarkup(
      <DrillsView project={source} starting={false} onStart={async () => undefined} />,
    );
    for (const label of [
      "Drills",
      "Task interactions",
      "Task workloads",
      "Drill checks",
      "Actors for workload-01",
    ]) {
      expect(markup).toContain(`aria-label="${label} pages"`);
    }
    expect(markup).toContain("drill-25");
    expect(markup).not.toContain("drill-26");
    expect(markup).toContain("Instruction interaction-10");
    expect(markup).not.toContain("Instruction interaction-11");
    expect(markup).toContain("Instruction workload-10");
    expect(markup).not.toContain("Instruction workload-11");
    expect(markup).toContain("actor-10");
    expect(markup).not.toContain("actor-11");
    expect(markup).toContain('<ol class="fd-drill-checks" start="1">');
    expect(markup).toContain("Check 10");
    expect(markup).not.toContain("Check 11");
  });

  it("bounds identities and each actor's grants without removing descriptions or allowed-operation meaning", () => {
    const source = project();
    source.world.baseline.actors = names("reader", 26).map((id) => ({
      id,
      description: `Description ${id}`,
      attributes: {},
      grants: names("lookup", 11).map((operationId) => ({ packageId: "archive", operationId })),
    }));
    const markup = renderToStaticMarkup(<CatalogView project={source} page="personas" />);
    expect(markup).toContain('aria-label="Identities pages"');
    expect(markup).toContain('aria-label="Allowed operations for reader-01 pages"');
    expect(markup).toContain("Description reader-25");
    expect(markup).not.toContain("Description reader-26");
    expect(markup).toContain("archive.lookup-10");
    expect(markup).not.toContain("archive.lookup-11");
  });

  it("uses the shared pages for tables, schema fields and records while keeping full schema access", () => {
    const source = project();
    source.tools = [
      {
        id: "archive",
        version: "1.0.0",
        operations: [],
        stateNamespaces: names("table", 26),
        stateDefinitions: [
          {
            namespace: "table-01",
            schema: {
              type: "object",
              properties: Object.fromEntries(names("field", 26).map((name) => [name, { type: "string" }])),
            },
          },
        ],
        events: [],
        faults: [],
        httpRoutes: [],
      },
    ];
    source.world.baseline.state = names("record", 26).map((rowId) => ({
      action: "upsert",
      packageId: "archive",
      namespace: "table-01",
      rowId,
      value: { status: "ready" },
    }));
    const schema = renderToStaticMarkup(<CatalogView project={source} page="schema" />);
    expect(schema).toContain('aria-label="Tables pages"');
    expect(schema).toContain('aria-label="Fields pages"');
    expect(schema).toContain("Full schema");
    expect(schema).toContain("<code>field-25</code>");
    expect(schema).not.toContain("<code>field-26</code>");
    const data = renderToStaticMarkup(<CatalogView project={source} page="data" />);
    expect(data).toContain('aria-label="Records pages"');
    expect(data).toContain("record-25");
    expect(data).not.toContain("record-26");
  });

  it("does not add pagination controls to small or empty catalogs", () => {
    const source = project();
    source.world.baseline.actors = [{ id: "reader", attributes: {}, grants: [] }];
    const actors = renderToStaticMarkup(<CatalogView project={source} page="personas" />);
    expect(actors).not.toContain('class="fd-pagination');
    expect(actors).toContain("No operations permitted");
    const empty = renderToStaticMarkup(<CatalogView project={source} page="data" />);
    expect(empty).not.toContain('class="fd-pagination');
    expect(empty).toContain("No starting records");
  });
});
