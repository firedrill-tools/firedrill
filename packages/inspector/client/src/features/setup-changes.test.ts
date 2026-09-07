import { describe, expect, it } from "vitest";
import type { SimulationSetup } from "../types.js";
import { describeSetupChanges } from "./setup-changes.js";

function setup(overrides: Partial<SimulationSetup> = {}): SimulationSetup {
  return { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [], ...overrides };
}

function row(rowId: string, value: Extract<SimulationSetup["state"][number], { action: "upsert" }>["value"]) {
  return { action: "upsert" as const, packageId: "archive", namespace: "volumes", rowId, value };
}

function event(label: string): SimulationSetup["initialEvents"][number] {
  return {
    event: { packageId: "observatory", eventId: "sample.ready" },
    payload: { label },
    atUs: 20,
    actorId: "operator",
  };
}

describe("effective starting setup differences", () => {
  it("reports no changes for an unchanged baseline without mutating inputs", () => {
    const baseline = setup({
      actors: [{ id: "operator", grants: [], attributes: { zone: "west" } }],
      state: [row("volume-a", { title: "Field notes" })],
      faults: [{ packageId: "archive", faultId: "index.lag" }],
      initialEvents: [event("first")],
    });
    const before = JSON.stringify(baseline);
    expect(describeSetupChanges(baseline, baseline)).toEqual({
      state: [],
      actors: [],
      removedActors: [],
      addedFaults: [],
      removedFaults: [],
      addedInitialEvents: [],
      removedInitialEvents: [],
      eventOrderChanged: false,
      clockChanged: false,
      hasChanges: false,
    });
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it("compares resolved records rather than repeated, overwritten or no-op patches", () => {
    const baseline = setup({ state: [row("volume-a", { obsolete: true }), row("volume-a", { edition: 2 })] });
    const current = setup({
      state: [
        ...baseline.state,
        row("volume-a", { edition: 9 }),
        row("volume-a", { edition: 2 }),
        row("temporary", { scratch: true }),
        { action: "delete", packageId: "archive", namespace: "volumes", rowId: "temporary" },
        { action: "delete", packageId: "archive", namespace: "volumes", rowId: "missing" },
      ],
    });
    expect(describeSetupChanges(baseline, current).hasChanges).toBe(false);
  });

  it("returns only final changed/new upserts and effective removals", () => {
    const baseline = setup({
      state: [row("changed", { old: true, edition: 1 }), row("removed", { edition: 1 })],
    });
    const finalChanged = row("changed", { edition: 3 });
    const newRow = row("new", { edition: 1 });
    const current = setup({
      state: [
        ...baseline.state,
        row("changed", { edition: 2 }),
        finalChanged,
        newRow,
        { action: "delete", packageId: "archive", namespace: "volumes", rowId: "removed" },
      ],
    });
    expect(describeSetupChanges(baseline, current).state).toEqual([
      finalChanged,
      newRow,
      { action: "delete", packageId: "archive", namespace: "volumes", rowId: "removed" },
    ]);
    expect(describeSetupChanges(baseline, setup()).state).toHaveLength(2);
  });

  it("ignores recursively reordered JSON object keys but preserves array order", () => {
    const baseline = setup({
      state: [row("one", { a: { x: 1, y: 2 }, b: [1, { m: true, n: null }] })],
      actors: [{ id: "operator", grants: [], attributes: { a: 1, b: { c: 2, d: 3 } } }],
      initialEvents: [{ ...event("one"), payload: { a: 1, b: { c: 2, d: 3 } } }],
    });
    const current = setup({
      state: [row("one", { b: [1, { n: null, m: true }], a: { y: 2, x: 1 } })],
      actors: [{ attributes: { b: { d: 3, c: 2 }, a: 1 }, grants: [], id: "operator" }],
      initialEvents: [{ ...event("one"), payload: { b: { d: 3, c: 2 }, a: 1 } }],
    });
    expect(describeSetupChanges(baseline, current).hasChanges).toBe(false);
    current.state = [row("one", { a: { x: 1, y: 2 }, b: [{ m: true, n: null }, 1] })];
    expect(describeSetupChanges(baseline, current).state).toHaveLength(1);
  });

  it("keeps record identities distinct even when delimiter-joined identities would collide", () => {
    const first = { ...row("c", { value: 1 }), packageId: "a:b", namespace: "c" };
    const second = { ...row("c", { value: 1 }), packageId: "a", namespace: "b:c" };
    const changedSecond = { ...second, value: { value: 2 } };
    expect(
      describeSetupChanges(setup({ state: [first, second] }), setup({ state: [first, changedSecond] })).state,
    ).toEqual([changedSecond]);
  });

  it("reports new actors, changed attributes and changed grants without unrelated actors", () => {
    const unchanged = { id: "reader", attributes: {}, grants: [] };
    const baseline = setup({
      actors: [
        unchanged,
        { id: "archivist", attributes: { clearance: 1 }, grants: [] },
        {
          id: "operator",
          attributes: {},
          grants: [{ packageId: "observatory", operationId: "sample.read" }],
        },
      ],
    });
    const changed = [
      { id: "archivist", attributes: { clearance: 2 }, grants: [] },
      { id: "operator", attributes: {}, grants: [] },
      { id: "courier", attributes: {}, grants: [] },
    ];
    const changes = describeSetupChanges(baseline, setup({ actors: [unchanged, ...changed] }));
    expect(changes.actors).toEqual(changed);
    expect(changes.hasChanges).toBe(true);
  });

  it("does not suppress actor removal", () => {
    const actor = { id: "departed", attributes: {}, grants: [] };
    expect(describeSetupChanges(setup({ actors: [actor] }), setup())).toMatchObject({
      actors: [],
      removedActors: [actor],
      hasChanges: true,
    });
  });

  it("recognizes description changes without changing attributes or permissions", () => {
    const actor = {
      id: "operator",
      description: "Reviews incoming observations.",
      attributes: {},
      grants: [],
    };
    const changed = { ...actor, description: "Reviews the overnight observation batch." };
    const baseline = setup({ actors: [actor] });
    expect(describeSetupChanges(baseline, baseline).hasChanges).toBe(false);
    expect(describeSetupChanges(baseline, setup({ actors: [changed] }))).toMatchObject({
      actors: [changed],
      hasChanges: true,
    });
    const withoutDescription = { id: actor.id, attributes: actor.attributes, grants: actor.grants };
    expect(describeSetupChanges(baseline, setup({ actors: [withoutDescription] })).actors).toEqual([
      withoutDescription,
    ]);
    expect(changed.attributes).toEqual(actor.attributes);
    expect(changed.grants).toEqual(actor.grants);
  });

  it("compares actor grants as permission sets, not ordered arrays", () => {
    const grants = [
      { packageId: "observatory", operationId: "sample.read" },
      { packageId: "observatory", operationId: "sample.record" },
    ];
    const baseline = setup({ actors: [{ id: "operator", attributes: {}, grants }] });
    const current = setup({ actors: [{ id: "operator", attributes: {}, grants: [...grants].reverse() }] });
    expect(describeSetupChanges(baseline, current)).toMatchObject({ actors: [], hasChanges: false });
  });

  it("keeps actor attribute arrays order-sensitive", () => {
    const baseline = setup({ actors: [{ id: "operator", attributes: { steps: [1, 2] }, grants: [] }] });
    const current = setup({ actors: [{ id: "operator", attributes: { steps: [2, 1] }, grants: [] }] });
    expect(describeSetupChanges(baseline, current).actors).toEqual(current.actors);
  });

  it("reports added and removed faults by full identity", () => {
    const kept = { packageId: "archive", faultId: "index.lag" };
    const removed = { packageId: "observatory", faultId: "sample.late" };
    const added = { packageId: "other", faultId: "sample.late" };
    const changes = describeSetupChanges(
      setup({ faults: [kept, removed] }),
      setup({ faults: [added, kept] }),
    );
    expect(changes.addedFaults).toEqual([added]);
    expect(changes.removedFaults).toEqual([removed]);
  });

  it("diffs events as a multiset, preserving unmatched duplicates and their order", () => {
    const a = event("a");
    const b = event("b");
    const c = event("c");
    const d = event("d");
    const baseline = setup({ initialEvents: [a, a, b, c, c] });
    const current = setup({ initialEvents: [a, d, b, b, d] });
    const changes = describeSetupChanges(baseline, current);
    expect(changes.addedInitialEvents).toEqual([d, b, d]);
    expect(changes.removedInitialEvents).toEqual([a, c, c]);
    expect(changes.eventOrderChanged).toBe(false);
  });

  it("reports reordered same-clock events even when no occurrences were added or removed", () => {
    const a = event("a");
    const b = event("b");
    const changes = describeSetupChanges(setup({ initialEvents: [a, b] }), setup({ initialEvents: [b, a] }));
    expect(changes).toMatchObject({
      addedInitialEvents: [],
      removedInitialEvents: [],
      eventOrderChanged: true,
      hasChanges: true,
    });
  });

  it("does not report retained event reordering when events are appended, inserted or removed", () => {
    const a = event("a");
    const b = event("b");
    const c = event("c");
    const baseline = setup({ initialEvents: [a, b] });
    for (const events of [[a, b, c], [c, a, c, b], [b], []]) {
      expect(describeSetupChanges(baseline, setup({ initialEvents: events })).eventOrderChanged).toBe(false);
    }
  });

  it("detects retained event order with duplicates and unrelated additions or removals", () => {
    const a = event("a");
    const b = event("b");
    const c = event("c");
    const d = event("d");
    expect(
      describeSetupChanges(setup({ initialEvents: [a, a, b, c] }), setup({ initialEvents: [d, a, b, a] })),
    ).toMatchObject({
      addedInitialEvents: [d],
      removedInitialEvents: [c],
      eventOrderChanged: true,
    });
  });

  it("treats event payload, time and actor changes as removed and added events", () => {
    const original = event("a");
    for (const changed of [
      { ...original, payload: { label: "b" } },
      { ...original, atUs: 30 },
      { ...original, actorId: "other" },
    ]) {
      const changes = describeSetupChanges(
        setup({ initialEvents: [original] }),
        setup({ initialEvents: [changed] }),
      );
      expect(changes.removedInitialEvents).toEqual([original]);
      expect(changes.addedInitialEvents).toEqual([changed]);
    }
  });

  it("reports a clock-only change", () => {
    expect(describeSetupChanges(setup({ virtualTimeUs: 0 }), setup({ virtualTimeUs: 100 }))).toMatchObject({
      state: [],
      actors: [],
      clockChanged: true,
      hasChanges: true,
    });
  });
});
