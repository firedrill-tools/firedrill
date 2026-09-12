import { existsSync } from "node:fs";
import { join } from "node:path";
import { NodePackageNameSchema, SemverSchema } from "@firedrill/contracts";
import type { ReadyTool } from "./tool-catalog.js";
import { installToolSource } from "./tool-installation.js";

export function toolInstallPlan(root: string, tool: ReadyTool) {
  NodePackageNameSchema.parse(tool.packageName);
  SemverSchema.parse(tool.version);
  const manager = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  return {
    executable: manager,
    arguments:
      manager === "pnpm"
        ? ["add", "--save-dev", "--ignore-scripts", `${tool.packageName}@${tool.version}`]
        : ["install", "--save-dev", "--ignore-scripts", `${tool.packageName}@${tool.version}`],
  };
}

/** Only called after explicit installation consent; never runs package lifecycle scripts. */
export async function installReadyTool(
  root: string,
  tool: ReadyTool,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    NodePackageNameSchema.parse(tool.packageName);
    SemverSchema.parse(tool.version);
    await installToolSource({
      root,
      source: `${tool.packageName}@${tool.version}`,
      ...(signal ? { signal } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
