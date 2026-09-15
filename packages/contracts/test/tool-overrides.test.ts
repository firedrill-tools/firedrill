import { describe, expect, it } from "vitest";
import {
  AuthoredInlineScenarioDefinitionSchema,
  mergeToolOverrides,
  ResolvedToolOverridesSchema,
  RunWorldSetupSchema,
  ToolOverridesSchema,
} from "../src/index.js";

const rule = {
  id: "read-empty",
  operation: { packageId: "archive", operationId: "documents.search" },
  outcome: { kind: "return", value: [] },
} as const;

describe("declarative Tool overrides", () => {
  it("accepts serializable test-local rules without introducing omitted defaults", () => {
    expect(ToolOverridesSchema.parse([rule])).toEqual([rule]);
    expect(
      RunWorldSetupSchema.parse({ scenario: { toolOverrides: [rule] } }).scenario?.toolOverrides,
    ).toEqual([rule]);
    expect(AuthoredInlineScenarioDefinitionSchema.parse({ virtualTimeUs: 0 })).not.toHaveProperty(
      "toolOverrides",
    );
  });

  it("rejects duplicate identities, invalid counts, callbacks and authored provenance", () => {
    expect(ToolOverridesSchema.safeParse([rule, rule]).success).toBe(false);
    for (const times of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ToolOverridesSchema.safeParse([{ ...rule, times }]).success).toBe(false);
    }
    expect(
      ToolOverridesSchema.safeParse([{ ...rule, outcome: { kind: "return", value: () => [] } }]).success,
    ).toBe(false);
    expect(ToolOverridesSchema.safeParse([{ ...rule, scope: { kind: "baseline" } }]).success).toBe(false);
    expect(
      AuthoredInlineScenarioDefinitionSchema.safeParse({
        virtualTimeUs: 0,
        toolOverrides: [{ ...rule, scope: { kind: "baseline" } }],
      }).success,
    ).toBe(false);
  });

  it("replaces matching identities at the higher-priority position without sorting rule order", () => {
    const baseline = ResolvedToolOverridesSchema.parse([
      { ...rule, scope: { kind: "baseline" } },
      { ...rule, id: "z-first", scope: { kind: "baseline" } },
    ]);
    const overlay = ResolvedToolOverridesSchema.parse([
      { ...rule, id: "a-second", scope: { kind: "scenario", scenarioId: "quiet" } },
      { ...rule, outcome: { kind: "original" }, scope: { kind: "scenario", scenarioId: "quiet" } },
    ]);
    expect(mergeToolOverrides(baseline, overlay).map((item) => item.id)).toEqual([
      "z-first",
      "a-second",
      "read-empty",
    ]);
    expect(mergeToolOverrides(baseline, overlay).at(-1)?.outcome).toEqual({ kind: "original" });
  });
});
