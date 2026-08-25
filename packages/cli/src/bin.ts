#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "./program.js";

const arguments_ = process.argv.slice(2);
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

const guidedInit =
  arguments_.includes("init") &&
  !arguments_.includes("--path") &&
  !arguments_.includes("--json") &&
  !arguments_.includes("--help") &&
  !arguments_.includes("-h") &&
  process.env.CI === undefined &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true;
const terminal = guidedInit
  ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  : undefined;

try {
  const exitCode = await runCli(arguments_, {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    environment: process.env,
    signal: cancellation.signal,
    ...(terminal === undefined
      ? {}
      : {
          ask: (question: string) => terminal.question(question, { signal: cancellation.signal }),
        }),
  });
  process.exitCode = signalExitCode ?? exitCode;
} catch {
  process.stderr.write("Firedrill failed internally. No report was produced.\n");
  process.exitCode = signalExitCode ?? 1;
} finally {
  terminal?.close();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
