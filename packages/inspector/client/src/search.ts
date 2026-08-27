import { evidenceLabel, titleFromId } from "./format.js";
import type { EvidenceEntry, SimulationRunSummary } from "./types.js";

function normalizedSearchText(...values: readonly unknown[]): string {
  return values
    .map((value) => {
      if (typeof value === "string" || typeof value === "number") return String(value);
      try {
        return JSON.stringify(value) ?? "";
      } catch {
        return "";
      }
    })
    .join(" ")
    .toLowerCase();
}

export function matchesSearch(text: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => text.includes(token));
}

export function evidenceSearchText(entry: EvidenceEntry): string {
  const label = evidenceLabel(entry);
  return normalizedSearchText(entry, label, titleFromId(label), `event ${entry.sequence}`);
}

export function runSearchText(run: SimulationRunSummary): string {
  return normalizedSearchText(
    run,
    titleFromId(run.drillId),
    run.scenarioId === undefined ? "inline scenario" : titleFromId(run.scenarioId),
    titleFromId(run.targetId),
    titleFromId(run.verdict ?? run.status),
    `trial ${run.trial} of ${run.trialCount}`,
    `attempt ${run.attempt} of ${run.attemptLimit}`,
  );
}

export function preferredEvidenceSequence(entries: readonly EvidenceEntry[]): number | undefined {
  const reversed = [...entries].reverse();
  return (
    reversed.find((entry) => entry.kind === "verification" && entry.result.status === "failed") ??
    reversed.find((entry) => entry.kind === "verification") ??
    reversed.find((entry) => entry.kind === "fault") ??
    reversed[0]
  )?.sequence;
}
