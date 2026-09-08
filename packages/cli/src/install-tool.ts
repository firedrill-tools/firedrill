import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NodePackageNameSchema, SemverSchema } from "@firedrill/contracts";
import type { ReadyTool } from "./tool-catalog.js";

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
  const plan = toolInstallPlan(root, tool);
  return new Promise((resolve) => {
    // Windows package-manager launchers are .cmd files. Every word below is a
    // fixed flag or a validated package name/version without shell metacharacters.
    const command =
      process.platform === "win32"
        ? {
            executable: "cmd.exe",
            arguments: ["/d", "/s", "/c", `${plan.executable}.cmd ${plan.arguments.join(" ")}`],
          }
        : plan;
    const child = spawn(command.executable, command.arguments, {
      cwd: root,
      stdio: "ignore",
      shell: false,
    });
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (killDeadline !== undefined) clearTimeout(killDeadline);
      signal?.removeEventListener("abort", abort);
      resolve(success);
    };
    const abort = () => {
      child.kill("SIGTERM");
      killDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killDeadline.unref();
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 && !signal?.aborted));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
