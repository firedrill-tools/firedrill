#!/usr/bin/env node
import { runCli } from "./program.js";

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

try {
  const exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    signal: cancellation.signal,
  });
  process.exitCode = signalExitCode ?? exitCode;
} catch {
  process.stderr.write("Firedrill failed internally. No report was produced.\n");
  process.exitCode = signalExitCode ?? 1;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
