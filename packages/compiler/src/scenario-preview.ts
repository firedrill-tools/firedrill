import { compareStableStrings } from "@firedrill/contracts";
import { type CanonicalWorldIr, CanonicalWorldIrSchema } from "@firedrill/world-ir";
import { resolveScenario } from "./normalize.js";
import { ScenarioSourceSchema } from "./source-schemas.js";
import { validateWorldData, type WorldDataIssue } from "./validate-world-data.js";

/** Validate a source proposal with the same normalization/reference/data gates as compilation. No code runs. */
export function previewScenarioSource(world: CanonicalWorldIr, input: unknown) {
  const source = ScenarioSourceSchema.safeParse(input);
  if (!source.success)
    return {
      status: "failed" as const,
      issues: source.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
    };
  try {
    const scenario = resolveScenario(world.baseline, source.data);
    const candidate = CanonicalWorldIrSchema.safeParse({
      ...world,
      scenarios: [...world.scenarios.filter((item) => item.id !== scenario.id), scenario].sort((a, b) =>
        compareStableStrings(a.id, b.id),
      ),
    });
    if (!candidate.success)
      return {
        status: "failed" as const,
        issues: candidate.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      };
    const issues = validateWorldData(candidate.data);
    if (issues.length > 0) return { status: "failed" as const, issues };
    return {
      status: "success" as const,
      source: source.data,
      scenario,
      issues: [] as readonly WorldDataIssue[],
    };
  } catch {
    return {
      status: "failed" as const,
      issues: [{ path: [], message: "Scenario setup could not be resolved against this world." }],
    };
  }
}
