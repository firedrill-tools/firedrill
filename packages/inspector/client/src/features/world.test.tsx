import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProject, SimulationSetup } from "../types";
import { CatalogView } from "./catalog";
import { WorldView } from "./world";

function setup(overrides: Partial<SimulationSetup> = {}): SimulationSetup {
  return { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [], ...overrides };
}

function record(rowId: string, edition = 1): SimulationSetup["state"][number] {
  return { action: "upsert", packageId: "archive", namespace: "volumes", rowId, value: { edition } };
}

function event(eventId: string): SimulationSetup["initialEvents"][number] {
  return { event: { packageId: "observatory", eventId }, payload: {}, atUs: 20, actorId: "operator" };
}

function project(baseline: SimulationSetup, scenario: SimulationSetup): SimulationProject {
  return {
    schemaVersion: 1,
    world: {
      id: "observatory",
      seed: "1",
      buildHash: `sha256:${"a".repeat(64)}`,
      packageLockHash: `sha256:${"b".repeat(64)}`,
      baseline,
    },
    scenarios: [{ id: "overnight", title: "Overnight observations", ...scenario }],
    tools: [],
    targets: [],
    drills: [],
    suites: [],
    diagnostics: [],
  };
}

function section(markup: string, id: string): string {
  const content = markup.match(
    new RegExp(`<section\\b[^>]*data-scroll-section="${id}"[^>]*>([\\s\\S]*?)</section>`),
  );
  expect(content, `Expected the ${id} section in the initial render`).not.toBeNull();
  return content?.[1] ?? "";
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("scenario starting setup", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows inherited data, failures, events and permissions immediately for an unchanged scenario", () => {
    const baseline = setup({
      state: [record("inherited-volume")],
      actors: [{ id: "operator", attributes: {}, grants: [{ packageId: "archive", operationId: "read" }] }],
      faults: [{ packageId: "archive", faultId: "index.lag" }],
      initialEvents: [event("sample.ready")],
    });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, baseline)} page="scenarios" />);

    expect(text(section(markup, "changes"))).toContain("Uses the world baseline unchanged.");
    expect(section(markup, "changes")).not.toContain("<li");
    expect(section(markup, "data")).toContain("<code>inherited-volume</code>");
    expect(section(markup, "failures")).toContain("<code>archive.index.lag</code>");
    expect(section(markup, "events")).toContain("<code>observatory.sample.ready</code>");
    expect(section(markup, "permissions")).toContain("<code>operator</code>");
    expect(section(markup, "permissions")).toContain("archive.read");
    for (const id of ["data", "failures", "events", "permissions"]) {
      expect(markup.match(new RegExp(`data-scroll-section="${id}"`, "g"))).toHaveLength(1);
    }
    expect(markup).not.toContain("View complete setup");
    expect(markup).not.toContain("Show scenario changes");
    expect(markup).not.toContain("Add or replace");
  });

  it("keeps inherited content beside the resolved changes and summarizes removals absent from the full setup", () => {
    const inheritedActor = { id: "operator", attributes: {}, grants: [] };
    const inheritedEvent = event("sample.ready");
    const baseline = setup({
      state: [record("inherited-volume"), record("updated-volume"), record("removed-volume")],
      actors: [inheritedActor, { id: "departed", attributes: {}, grants: [] }],
      faults: [
        { packageId: "archive", faultId: "index.lag" },
        { packageId: "observatory", faultId: "sample.late" },
      ],
      initialEvents: [inheritedEvent, event("sample.old")],
    });
    const scenario = setup({
      state: [
        ...baseline.state,
        record("updated-volume", 2),
        record("new-volume"),
        { action: "delete", packageId: "archive", namespace: "volumes", rowId: "removed-volume" },
      ],
      actors: [inheritedActor, { id: "courier", attributes: {}, grants: [] }],
      faults: [
        { packageId: "archive", faultId: "index.lag" },
        { packageId: "relay", faultId: "delivery.late" },
      ],
      initialEvents: [inheritedEvent, event("sample.new")],
    });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, scenario)} page="scenarios" />);
    const summary = text(section(markup, "changes"));
    const data = section(markup, "data");

    expect(summary).toContain("Changes from world baseline");
    expect(summary).not.toContain("Uses the world baseline unchanged");
    expect(summary).toContain("Enables relay.delivery.late");
    expect(summary).toContain("Disables observatory.sample.late");
    expect(summary).toContain("2 starting records added or updated.");
    expect(summary).toContain("1 starting record removed.");
    expect(summary).toContain("1 actor added or changed.");
    expect(summary).toContain("1 actor removed.");
    expect(summary).toContain("1 event scheduled.");
    expect(summary).toContain("1 scheduled event removed.");
    for (const id of ["inherited-volume", "updated-volume", "new-volume"]) {
      expect(data.match(new RegExp(`<code>${id}</code>`, "g"))).toHaveLength(1);
    }
    expect(data).not.toContain("removed-volume");
    expect(section(markup, "permissions")).toContain("<code>operator</code>");
    expect(section(markup, "permissions")).toContain("<code>courier</code>");
    expect(section(markup, "permissions")).not.toContain("departed");
    expect(section(markup, "failures")).toContain("archive.index.lag");
    expect(section(markup, "failures")).toContain("relay.delivery.late");
    expect(section(markup, "failures")).not.toContain("observatory.sample.late");
    expect(section(markup, "events")).toContain("observatory.sample.ready");
    expect(section(markup, "events")).toContain("observatory.sample.new");
    expect(section(markup, "events")).not.toContain("observatory.sample.old");
  });

  it("identifies event-order-only changes and displays scheduled events in resolved setup order", () => {
    const first = event("sample.first");
    const second = event("sample.second");
    const baseline = setup({ initialEvents: [first, second] });
    const scenario = setup({ initialEvents: [second, first] });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, scenario)} page="scenarios" />);
    const summary = text(section(markup, "changes"));
    const events = section(markup, "events");

    expect(summary).toContain("The setup order of inherited scheduled events changes.");
    expect(summary).not.toContain("Uses the world baseline unchanged");
    expect(summary).not.toContain("event scheduled");
    expect(summary).not.toContain("event removed");
    expect(events).toContain("<code>observatory.sample.first</code>");
    expect(events).toContain("<code>observatory.sample.second</code>");
    expect(events.indexOf("observatory.sample.second")).toBeLessThan(
      events.indexOf("observatory.sample.first"),
    );
  });

  it("identifies a clock-only change without inventing data or permission differences", () => {
    const baseline = setup();
    const scenario = setup({ virtualTimeUs: 100 });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, scenario)} page="scenarios" />);
    const summary = text(section(markup, "changes"));

    expect(summary).toContain("0 μs → 100 μs");
    expect(summary).not.toContain("Uses the world baseline unchanged");
    expect(summary).not.toContain("record added");
    expect(summary).not.toContain("actor changed");
    expect(section(markup, "data")).toContain("No starting records.");
    expect(section(markup, "permissions")).toContain("No actors are declared in this setup.");
  });

  it("does not describe the world baseline as a scenario difference", () => {
    const baseline = setup({ state: [record("baseline-volume")] });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, baseline)} />);

    expect(section(markup, "data")).toContain("<code>baseline-volume</code>");
    expect(markup).not.toContain('data-scroll-section="changes"');
    expect(markup).not.toContain("Changes from world baseline");
    expect(markup).not.toContain("Uses the world baseline unchanged");
    expect(markup).not.toContain('data-scroll-section="tool-overrides"');
  });

  it("shows inherited and changed Tool overrides without hiding the setup or inventing state changes", () => {
    const inherited = {
      id: "cached-lookup",
      operation: { packageId: "archive", operationId: "lookup" },
      outcome: { kind: "return" as const, value: { found: false } },
      scope: { kind: "baseline" as const },
    };
    const changed = {
      ...inherited,
      id: "restore-lookup",
      outcome: { kind: "original" as const },
      scope: { kind: "scenario" as const, scenarioId: "overnight" },
    };
    const baseline = setup({ toolOverrides: [inherited] });
    const scenario = setup({ toolOverrides: [inherited, changed] });
    const markup = renderToStaticMarkup(<WorldView project={project(baseline, scenario)} page="scenarios" />);
    expect(text(section(markup, "changes"))).toContain("1 Tool override added or changed.");
    expect(text(section(markup, "changes"))).not.toContain("starting record");
    const overrides = section(markup, "tool-overrides");
    expect(overrides).toContain("cached-lookup");
    expect(overrides).toContain("restore-lookup");
    expect(overrides).toContain("Original Tool behavior");
    expect(overrides).toContain("World baseline");
    expect(overrides).toContain("Scenario: overnight");
    expect(markup.match(/data-scroll-section="tool-overrides"/g)).toHaveLength(1);
  });

  it("shows the exact description on the identities page and in the selected scenario setup", () => {
    const actor = {
      id: "operator",
      description: "Reviews daytime observations.",
      attributes: {},
      grants: [],
    };
    const baseline = setup({ actors: [actor] });
    const scenario = setup({ actors: [{ ...actor, description: "Reviews overnight observations." }] });
    const definitions = project(baseline, scenario);
    const catalog = renderToStaticMarkup(<CatalogView project={definitions} page="personas" />);
    expect(catalog).toContain("Reviews daytime observations.");
    expect(catalog).not.toContain("Reviews overnight observations.");
    const scenarioMarkup = renderToStaticMarkup(<WorldView project={definitions} page="scenarios" />);
    expect(section(scenarioMarkup, "permissions")).toContain("Reviews overnight observations.");
    expect(section(scenarioMarkup, "permissions")).not.toContain("Reviews daytime observations.");
  });
});
