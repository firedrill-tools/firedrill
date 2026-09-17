import type { PackageId, StableId } from "@firedrill-tools/contracts";
import { PackageIdSchema, StableIdSchema } from "@firedrill-tools/contracts";
import type Database from "better-sqlite3";
import { decodeStoredCount } from "./codec.js";

// Existing schema-version-1 worlds may have no usage keys. Keeping controller-only
// counters in world_meta preserves read-only compatibility with retained worlds.
function packagePrefix(packageId: PackageId): string {
  return `tool_override_usage:${PackageIdSchema.parse(packageId)}:`;
}

export function toolOverrideUsageKey(packageId: PackageId, overrideId: StableId): string {
  return `${packagePrefix(packageId)}${StableIdSchema.parse(overrideId)}`;
}

export interface ToolOverrideUsageRow {
  readonly key: string;
  readonly value: string;
}

export function readPackageToolOverrideUsage(
  database: Database.Database,
  packageId: PackageId,
): readonly ToolOverrideUsageRow[] {
  const prefix = packagePrefix(packageId);
  const rows = database
    .prepare("SELECT key, value FROM world_meta WHERE substr(key, 1, ?) = ? ORDER BY key")
    .all(prefix.length, prefix) as ToolOverrideUsageRow[];
  for (const row of rows) {
    StableIdSchema.parse(row.key.slice(prefix.length));
    decodeStoredCount(row.value, "Tool override match count");
  }
  return rows;
}

export function clearPackageToolOverrideUsage(database: Database.Database, packageId: PackageId): void {
  const prefix = packagePrefix(packageId);
  database.prepare("DELETE FROM world_meta WHERE substr(key, 1, ?) = ?").run(prefix.length, prefix);
}
