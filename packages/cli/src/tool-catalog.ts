import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectInstalledToolPackage } from "@firedrill/compiler";

interface CatalogPackage {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly description: string;
  readonly lifecycle: string;
  readonly keywords: readonly string[];
  readonly tool: {
    readonly id: string;
    readonly operations: readonly { readonly id: string; readonly fidelity: string }[];
    readonly compatibility: readonly { readonly limitations: readonly string[] }[];
  };
}

export interface ReadyTool {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly operations: readonly { readonly id: string; readonly fidelity: string }[];
  readonly limitations: readonly string[];
  readonly installed: boolean;
}

/** Bundled discovery metadata only; installation and runtime validation remain explicit. */
export function readyTools(root: string, query = ""): readonly ReadyTool[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(directory, "registry/index.json");
  const path = existsSync(bundled) ? bundled : resolve(directory, "../../../registry/index.json");
  const index = JSON.parse(readFileSync(path, "utf8")) as {
    readonly schemaVersion: number;
    readonly packages: readonly CatalogPackage[];
  };
  if (index.schemaVersion !== 1 || !Array.isArray(index.packages))
    throw new Error("The bundled Tool catalog is invalid.");
  const needle = query.trim().toLowerCase();
  const packages: readonly CatalogPackage[] = index.packages;
  return packages
    .filter((item) => item.lifecycle === "active")
    .filter((item) =>
      [
        item.packageName,
        item.description,
        item.tool.id,
        ...item.keywords,
        ...item.tool.operations.map((operation) => operation.id),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    )
    .map((item) => {
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
        limitations: (installed
          ? inspected.declaration.manifest.compatibility
          : item.tool.compatibility
        ).flatMap((profile) => profile.limitations),
        installed,
      };
    });
}
