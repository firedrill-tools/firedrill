import { existsSync } from "node:fs";
import { join } from "node:path";
import { NodePackageNameSchema, SemverSchema } from "@firedrill-run/contracts";
import type { ReadyTool } from "./tool-catalog.js";
import { installToolSource } from "./tool-installation.js";

type InstallableTool = ReadyTool & { readonly installSource?: string };

function sourceFor(tool: InstallableTool): string {
  return tool.installSource ?? `${tool.packageName}@${tool.version}`;
}

export function toolInstallPlan(root: string, tool: InstallableTool) {
  NodePackageNameSchema.parse(tool.packageName);
  SemverSchema.parse(tool.version);
  if (tool.installSource !== undefined) {
    return {
      executable: "firedrill",
      arguments: ["tool", "add", tool.installSource, "--install"],
    };
  }
  if (process.env.FIREDRILL_BUNDLED_NPM_CLI) {
    return {
      executable: "firedrill",
      arguments: ["tool", "add", `${tool.packageName}@${tool.version}`, "--install"],
    };
  }
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
  tool: InstallableTool,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    NodePackageNameSchema.parse(tool.packageName);
    SemverSchema.parse(tool.version);
    await installToolSource({
      root,
      source: sourceFor(tool),
      ...(signal ? { signal } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
