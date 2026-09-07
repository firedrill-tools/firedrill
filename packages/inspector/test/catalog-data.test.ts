import { describe, expect, it } from "vitest";
import { recordCell, schemaFields, startingRecords } from "../client/src/features/catalog-data.js";
import type { SimulationSetup } from "../client/src/types.js";

describe("inspector authored data", () => {
  it("resolves ordered patches without duplicating baseline or merging stale fields", () => {
    const setup: SimulationSetup = {
      virtualTimeUs: 0,
      actors: [],
      faults: [],
      initialEvents: [],
      state: [
        {
          action: "upsert",
          packageId: "one",
          namespace: "items",
          rowId: "a",
          value: { old: true, value: 1 },
        },
        { action: "upsert", packageId: "one", namespace: "items", rowId: "a", value: { value: 2 } },
        { action: "upsert", packageId: "two", namespace: "items", rowId: "a", value: { value: 3 } },
        { action: "delete", packageId: "one", namespace: "items", rowId: "a" },
      ],
    };
    expect(startingRecords(setup)).toEqual([
      { packageId: "two", namespace: "items", rowId: "a", value: { value: 3 } },
    ]);
    expect(startingRecords({ ...setup, state: setup.state.slice(0, 2) })[0]?.value).toEqual({ value: 2 });
  });
  it("shows actual declared types and references, never inferred database relationships", () => {
    expect(
      schemaFields({
        properties: { owner: { $ref: "#/$defs/identity" }, value: { type: ["string", "null"] } },
        required: ["owner"],
      }),
    ).toMatchObject([
      { name: "owner", type: "#/$defs/identity", required: true },
      { name: "value", type: "string | null", required: false },
    ]);
    expect(schemaFields({ oneOf: [{ type: "string" }] })).toEqual([]);
  });
  it("does not confuse zero, false, null, and nested values", () => {
    expect([0, false, null, undefined, [1, 2], { x: 1 }].map(recordCell)).toEqual([
      "0",
      "false",
      "null",
      "—",
      "2 items",
      "Object",
    ]);
  });
});
