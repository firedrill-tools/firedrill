import { EvidenceEntrySchema, type EvidenceEntry } from "@firedrill-run/contracts";
import type Database from "better-sqlite3";
import { decodeStoredCount } from "./codec.js";

const KINDS = new Set(EvidenceEntrySchema.options.map((schema) => schema.shape.kind.value));

/** One indexed extremum query per kind; never deserialize or scan the journal. */
export function latestEvidenceSequence(
  database: Database.Database,
  kinds?: readonly EvidenceEntry["kind"][],
): number {
  if (kinds === undefined) {
    const row = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM evidence").get() as {
      sequence: number;
    };
    return decodeStoredCount(String(row.sequence), "latest evidence sequence");
  }
  if (!Array.isArray(kinds) || kinds.length > KINDS.size || kinds.some((kind) => !KINDS.has(kind)))
    throw new TypeError("evidence kinds must be a bounded array of declared evidence kinds");
  const query = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM evidence WHERE kind = ?",
  );
  let latest = 0;
  for (const kind of new Set(kinds)) {
    const row = query.get(kind) as { sequence: number };
    latest = Math.max(latest, decodeStoredCount(String(row.sequence), "latest evidence sequence"));
  }
  return latest;
}
