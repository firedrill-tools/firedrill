import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Python installations use the executable provided by the official Python Agent SDK. */
export function agentExecutable(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const path = environment.FIREDRILL_AGENT_EXECUTABLE ?? process.env.FIREDRILL_AGENT_EXECUTABLE;
  if (path === undefined) {
    if (process.env.FIREDRILL_BUNDLED_NPM_CLI)
      throw new Error('Install the optional Firedrill Agent with: pip install "firedrill-run[agent]"');
    return undefined;
  }
  if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isFile())
    throw new Error('The agent executable is unavailable. Reinstall "firedrill-run[agent]".');
  return path;
}
