import type { SimulationSetup } from "../types.js";
import { startingRecords } from "./catalog-data.js";

export interface SetupChanges {
  readonly state: SimulationSetup["state"];
  readonly actors: SimulationSetup["actors"];
  readonly removedActors: SimulationSetup["actors"];
  readonly addedFaults: SimulationSetup["faults"];
  readonly removedFaults: SimulationSetup["faults"];
  readonly addedInitialEvents: SimulationSetup["initialEvents"];
  readonly removedInitialEvents: SimulationSetup["initialEvents"];
  readonly eventOrderChanged: boolean;
  readonly clockChanged: boolean;
  readonly hasChanges: boolean;
}

/** Object property order is not significant; array order remains significant. */
function structuralKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(structuralKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${structuralKey(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function recordKey(record: { packageId: string; namespace: string; rowId: string }): string {
  return JSON.stringify([record.packageId, record.namespace, record.rowId]);
}

/** Matches earliest occurrences, preserving both partitions' order and duplicates. */
function partitionOccurrences<T>(
  items: readonly T[],
  reference: readonly T[],
): { retained: T[]; unmatched: T[] } {
  const counts = new Map<string, number>();
  for (const item of reference) {
    const key = structuralKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const retained: T[] = [];
  const unmatched: T[] = [];
  for (const item of items) {
    const key = structuralKey(item);
    const count = counts.get(key) ?? 0;
    if (count === 0) unmatched.push(item);
    else {
      counts.set(key, count - 1);
      retained.push(item);
    }
  }
  return { retained, unmatched };
}

function actorKey(actor: SimulationSetup["actors"][number]): string {
  const permissions = new Set(
    actor.grants.map((grant) => JSON.stringify([grant.packageId, grant.operationId])),
  );
  return structuralKey({ id: actor.id, attributes: actor.attributes, grants: [...permissions].sort() });
}

/** Compares effective starting conditions, not authored patch history or run-time state. */
export function describeSetupChanges(baseline: SimulationSetup, setup: SimulationSetup): SetupChanges {
  const baselineRows = startingRecords(baseline);
  const rows = startingRecords(setup);
  const baselineByKey = new Map(baselineRows.map((row) => [recordKey(row), row]));
  const currentKeys = new Set(rows.map(recordKey));
  const changedKeys = new Set(
    rows
      .filter((row) => {
        const previous = baselineByKey.get(recordKey(row));
        return previous === undefined || structuralKey(previous.value) !== structuralKey(row.value);
      })
      .map(recordKey),
  );
  const latestUpserts = new Map<string, Extract<SimulationSetup["state"][number], { action: "upsert" }>>();
  for (const patch of setup.state) {
    if (patch.action === "upsert") latestUpserts.set(recordKey(patch), patch);
  }
  const state: SimulationSetup["state"] = [...latestUpserts.entries()]
    .filter(([key]) => changedKeys.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, patch]) => patch);
  for (const row of baselineRows) {
    if (!currentKeys.has(recordKey(row))) {
      state.push({ action: "delete", packageId: row.packageId, namespace: row.namespace, rowId: row.rowId });
    }
  }

  const baselineActors = new Map(baseline.actors.map((actor) => [actor.id, actor]));
  const currentActorIds = new Set(setup.actors.map((actor) => actor.id));
  const actors = setup.actors.filter((actor) => {
    const previous = baselineActors.get(actor.id);
    return previous === undefined || actorKey(previous) !== actorKey(actor);
  });
  const removedActors = baseline.actors.filter((actor) => !currentActorIds.has(actor.id));
  const addedFaults = partitionOccurrences(setup.faults, baseline.faults).unmatched;
  const removedFaults = partitionOccurrences(baseline.faults, setup.faults).unmatched;
  const currentEvents = partitionOccurrences(setup.initialEvents, baseline.initialEvents);
  const previousEvents = partitionOccurrences(baseline.initialEvents, setup.initialEvents);
  const addedInitialEvents = currentEvents.unmatched;
  const removedInitialEvents = previousEvents.unmatched;
  const eventOrderChanged = structuralKey(currentEvents.retained) !== structuralKey(previousEvents.retained);
  const clockChanged = baseline.virtualTimeUs !== setup.virtualTimeUs;
  return {
    state,
    actors,
    removedActors,
    addedFaults,
    removedFaults,
    addedInitialEvents,
    removedInitialEvents,
    eventOrderChanged,
    clockChanged,
    hasChanges:
      clockChanged ||
      eventOrderChanged ||
      [
        state,
        actors,
        removedActors,
        addedFaults,
        removedFaults,
        addedInitialEvents,
        removedInitialEvents,
      ].some((items) => items.length > 0),
  };
}
