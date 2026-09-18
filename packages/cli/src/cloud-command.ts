import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliIo } from "./program.js";

/** Explicit opt-in only. Never resolve/install a package for a local command. */
export async function executeCloudCommand(arguments_: readonly string[], io: CliIo): Promise<number> {
  let run: (args: readonly string[], io: CliIo) => Promise<number>;
  try {
    let entry: string;
    try {
      entry = createRequire(join(io.cwd, "package.json")).resolve("@firedrill-run/cloud/cli");
    } catch {
      entry = createRequire(import.meta.url).resolve("@firedrill-run/cloud/cli");
    }
    // Fixed integration name above, not a user-selected path or remote import.
    const extension = (await import(pathToFileURL(entry).href)) as {
      runCloudCli?: (args: readonly string[], io: CliIo) => Promise<number>;
    };
    if (typeof extension.runCloudCli !== "function") throw new Error("Incompatible extension");
    run = extension.runCloudCli;
  } catch {
    const message =
      "The optional cloud client is unavailable or failed to start. Install @firedrill-run/cloud alongside @firedrill-run/cli. Local commands remain available without it.";
    if (arguments_.includes("--json"))
      io.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "cloud", status: "failed", code: "FD_CLOUD_EXTENSION_UNAVAILABLE", message })}\n`,
      );
    else io.stderr.write(`${message}\n`);
    return 2;
  }
  try {
    return await run(arguments_, io);
  } catch {
    const message =
      "The cloud command did not finish. Its remote outcome may be unknown; inspect the saved attempt before retrying.";
    if (arguments_.includes("--json"))
      io.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "cloud", status: "unknown", code: "FD_CLOUD_COMMAND_UNRESOLVED", message })}\n`,
      );
    else io.stderr.write(`${message}\n`);
    return 1;
  }
}
