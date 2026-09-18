import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectInstalledToolPackage } from "@firedrill-run/compiler";
import { type ToolIndex, type ToolIndexEntry, ToolIndexSchema } from "./tool-index-schema.js";

export interface ReadyTool {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly operations: readonly { readonly id: string; readonly fidelity: string }[];
  readonly limitations: readonly string[];
  readonly installed: boolean;
}

export function bundledToolIndex(): { readonly path: string; readonly index: ToolIndex } {
  const directory = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(directory, "registry/index.json");
  const path = existsSync(bundled) ? bundled : resolve(directory, "../../../registry/index.json");
  const index = ToolIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return { path, index };
}

export function catalogMatches(item: ToolIndexEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [
    item.packageName,
    item.title ?? "",
    item.description,
    item.tool.id,
    ...item.keywords,
    ...item.tool.operations.map((operation) => operation.id),
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export function inspectCatalogEntry(root: string, item: ToolIndexEntry): ReadyTool {
  const inspected = inspectInstalledToolPackage({ repositoryRoot: root, packageName: item.packageName });
  const installed =
    inspected.status === "success" &&
    inspected.package.version === item.packageVersion &&
    inspected.declaration.manifest.id === item.tool.id;
  return {
    id: item.tool.id,
    packageName: item.packageName,
    version: item.packageVersion,
    description: item.description,
    operations: installed
      ? inspected.declaration.manifest.operations.map(({ id, fidelity }) => ({ id, fidelity }))
      : item.tool.operations,
    limitations: (installed ? inspected.declaration.manifest.compatibility : item.tool.compatibility).flatMap(
      (profile) => profile.limitations,
    ),
    installed,
  };
}

/** Bundled discovery metadata only; installation and runtime validation remain explicit. */
export function readyTools(root: string, query = ""): readonly ReadyTool[] {
  return bundledToolIndex()
    .index.packages.filter((item) => item.lifecycle === "active")
    .filter((item) => catalogMatches(item, query))
    .map((item) => inspectCatalogEntry(root, item));
}
