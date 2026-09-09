#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Console } from "node:console";
import { createInterface } from "node:readline/promises";
import { runCli } from "./program.js";

function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", arguments: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", arguments: ["/c", "start", "", url] }
        : { executable: "xdg-open", arguments: [url] };
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const arguments_ = process.argv.slice(2);
// Trusted Tool modules may use console.log. Keep those logs off MCP's wire.
const originalConsole = globalThis.console;
if (arguments_[0] === "mcp") globalThis.console = new Console(process.stderr, process.stderr);
const cancellation = new AbortController();
let signalExitCode: number | undefined;
const onSigint = () => {
  signalExitCode = 130;
  cancellation.abort();
};
const onSigterm = () => {
  signalExitCode = 143;
  cancellation.abort();
};
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

const interactive =
  !arguments_.includes("--json") &&
  !arguments_.includes("--help") &&
  !arguments_.includes("-h") &&
  process.env.CI === undefined &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true;
const guidedInit = arguments_.includes("init") && interactive;
const terminal = guidedInit
  ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  : undefined;
// readline owns terminal SIGINT while the wizard remains attached to serve.
// Forward it through the same cancellation signal as ordinary foreground runs.
terminal?.on("SIGINT", onSigint);

try {
  const exitCode = await runCli(arguments_, {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdio: { input: process.stdin, output: process.stdout },
    environment: process.env,
    signal: cancellation.signal,
    interactive,
    openUrl,
    ...(terminal === undefined
      ? {}
      : {
          ask: (question: string) => terminal.question(question, { signal: cancellation.signal }),
        }),
  });
  process.exitCode = signalExitCode ?? exitCode;
} catch {
  if (!cancellation.signal.aborted)
    process.stderr.write("Firedrill failed internally. No report was produced.\n");
  process.exitCode = signalExitCode ?? 1;
} finally {
  globalThis.console = originalConsole;
  terminal?.removeListener("SIGINT", onSigint);
  terminal?.close();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
