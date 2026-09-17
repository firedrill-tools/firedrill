import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserTestDefinitionInput } from "@firedrill-tools/browser-tests";
import type { CliIo } from "./program.js";

const HELP = `Optional browser tests for an existing application

Usage:
  firedrill browser run <test.browser.json> [options]
  firedrill browser run --url <url> --task <task> --agent --allow-model [options]
  firedrill browser verify <report-directory> [--root <path>] [--json]

Install once: pnpm add -D @firedrill-tools/browser-tests
Browser install: pnpm dlx playwright@1.62.1 install chromium
For the optional task driver: pnpm add -D @firedrill-tools/agent

Options:
  --root <path>             Project directory; defaults to the current directory
  --headed                  Show the controlled browser instead of running headless
  --agent --allow-model     Use Claude Agent SDK with your ANTHROPIC_API_KEY
  --model <model>           Optional browser agent model
  --max-budget-usd <amount> Explicit model budget; defaults to $2
  --timeout-ms <ms>         Entire test deadline; defaults to 120000
  --step-timeout-ms <ms>    Wait per action/assertion; defaults to 5000, maximum 60000
  --allow-remote            Permit a remote application you are authorized to test
  --allow-origin <origin>   Additional application origin; repeat as needed
  --param-env <name>=<var>  Read a test parameter from a host environment variable
  --video                   Retain a recording, which may contain sensitive page data
  --trace                   Retain a Playwright trace, which may contain sensitive data
  --save <id>               Save observed steps as a new reusable local test
  --open                    Open the generated local HTML report
  --json                    Print one machine-readable result

Saved steps need no model key. Independent assertions decide pass or fail.
Without assertions the outcome is completed, NOT passed; browser results alone
do not prove synthetic world state. Your app and agent remain caller-owned.
Local reports stay under .firedrill/browser/ and must not be committed.
`;

class BrowserCliError extends Error {}

/** Browser dependencies and model execution are opt-in, never part of ordinary local commands. */
export async function executeBrowserCommand(args: readonly string[], io: CliIo): Promise<number> {
  const json = args.includes("--json");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(HELP);
    return 0;
  }
  const flags = new Set([
    "--json",
    "--headed",
    "--agent",
    "--allow-model",
    "--allow-remote",
    "--video",
    "--trace",
    "--open",
  ]);
  const valued = new Set([
    "--root",
    "--url",
    "--task",
    "--model",
    "--max-budget-usd",
    "--timeout-ms",
    "--step-timeout-ms",
    "--allow-origin",
    "--param-env",
    "--save",
  ]);
  const values = new Map<string, string[]>();
  const selected = new Set<string>();
  let file: string | undefined;
  let library: typeof import("@firedrill-tools/browser-tests") | undefined;
  try {
    const command = args[0];
    if (command !== "run" && command !== "verify")
      throw new BrowserCliError("Use firedrill browser run or firedrill browser verify. See --help.");
    for (let index = 1; index < args.length; index++) {
      const arg = args[index] ?? "";
      if (flags.has(arg)) {
        if (selected.has(arg)) throw new BrowserCliError(`${arg} must not be repeated.`);
        selected.add(arg);
      } else if (valued.has(arg)) {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new BrowserCliError(`${arg} needs a value.`);
        if (values.has(arg) && arg !== "--allow-origin" && arg !== "--param-env")
          throw new BrowserCliError(`${arg} must not be repeated.`);
        values.set(arg, [...(values.get(arg) ?? []), value]);
      } else if (arg.startsWith("-") || file !== undefined) {
        throw new BrowserCliError(`Unexpected argument ${arg}. See firedrill browser --help.`);
      } else file = arg;
    }
    const value = (name: string) => values.get(name)?.[0];
    const root = resolve(io.cwd, value("--root") ?? ".");
    if (
      command === "verify" &&
      (file === undefined ||
        [...selected].some((flag) => flag !== "--json") ||
        [...values.keys()].some((flag) => flag !== "--root"))
    )
      throw new BrowserCliError("Use browser verify <report-directory> with only --root and --json.");
    if (command === "run") {
      if (file !== undefined && (values.has("--url") || values.has("--task")))
        throw new BrowserCliError("Choose a saved test file OR --url and --task, not both.");
      if (file === undefined && (!value("--url") || !value("--task")))
        throw new BrowserCliError("Provide a saved test file, or both --url and --task.");
      if (selected.has("--agent") !== selected.has("--allow-model"))
        throw new BrowserCliError("The optional browser agent requires both --agent and --allow-model.");
      if (!selected.has("--agent") && (values.has("--model") || values.has("--max-budget-usd")))
        throw new BrowserCliError("Model options require --agent --allow-model.");
      if (file === undefined && !selected.has("--agent"))
        throw new BrowserCliError(
          "A new natural-language task needs --agent --allow-model. Saved steps do not.",
        );
    }
    try {
      library = await import("@firedrill-tools/browser-tests");
    } catch {
      throw new BrowserCliError(
        "Install the optional browser package beside the CLI: pnpm add -D @firedrill-tools/browser-tests",
      );
    }
    if (command === "verify") {
      const result = library.verifyBrowserTestReport(resolve(root, file ?? ""));
      if (json) io.stdout.write(`${JSON.stringify({ command: "browser verify", ...result })}\n`);
      else io.stdout.write("Browser report verified. Its recorded files match their hashes.\n");
      return 0;
    }
    const definition: BrowserTestDefinitionInput =
      file === undefined
        ? {
            schemaVersion: 1,
            id: value("--save") ?? "browser-task",
            startUrl: value("--url") ?? "",
            task: value("--task") ?? "",
          }
        : library.loadBrowserTest({ root, path: file });
    if (selected.has("--agent") && (definition.steps?.length ?? 0) > 0)
      throw new BrowserCliError(
        "This saved test already contains steps. Replay it without --agent --allow-model; use a new URL/task to record a different flow.",
      );
    const parameters: Record<string, string> = {};
    const environment = io.environment ?? process.env;
    for (const entry of values.get("--param-env") ?? []) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,95})=([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry);
      if (!match) throw new BrowserCliError("--param-env uses parameter=ENVIRONMENT_VARIABLE.");
      const name = match[1] ?? "";
      const variable = match[2] ?? "";
      if (Object.hasOwn(parameters, name)) throw new BrowserCliError("Each parameter must be mapped once.");
      const parameter = environment[variable];
      if (parameter === undefined)
        throw new BrowserCliError(`Set ${variable} before running this browser test.`);
      parameters[name] = parameter;
    }
    const timeoutMs = value("--timeout-ms") === undefined ? undefined : Number(value("--timeout-ms"));
    const stepTimeoutMs =
      value("--step-timeout-ms") === undefined ? undefined : Number(value("--step-timeout-ms"));
    const maxBudgetUsd =
      value("--max-budget-usd") === undefined ? undefined : Number(value("--max-budget-usd"));
    let driver: import("@firedrill-tools/browser-tests").BrowserTestDriver | undefined;
    if (selected.has("--agent")) {
      const model = value("--model");
      let agent: typeof import("@firedrill-tools/agent/browser");
      try {
        agent = await import("@firedrill-tools/agent/browser");
      } catch {
        throw new BrowserCliError("Install the optional browser agent: pnpm add -D @firedrill-tools/agent");
      }
      driver = agent.createBrowserAgentDriver({
        environment,
        ...(model === undefined ? {} : { model }),
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      });
    }
    const result = await library.runBrowserTest({
      root,
      definition,
      parameters,
      ...(driver === undefined ? {} : { driver }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs }),
      headless: !selected.has("--headed"),
      allowRemote: selected.has("--allow-remote"),
      allowedOrigins: values.get("--allow-origin") ?? [],
      capture: {
        screenshot: "always",
        video: selected.has("--video") ? "always" : "off",
        trace: selected.has("--trace") ? "always" : "off",
      },
      ...(json
        ? {}
        : {
            onEvent: (event: import("@firedrill-tools/browser-tests").BrowserTestEvent) =>
              io.stdout.write(`${event.message}\n`),
          }),
    });
    let savedPath: string | undefined;
    let saveError: string | undefined;
    if (value("--save") !== undefined) {
      try {
        savedPath = library.saveBrowserTest({
          root,
          definition: library.browserTestDefinitionFromResult({
            result,
            id: value("--save") ?? result.definition.id,
          }),
        });
      } catch (failure) {
        saveError =
          failure instanceof library.BrowserTestError
            ? `${failure.code}: ${failure.message}`
            : "Test ran, but its reusable source was not saved. Inspect the report and choose an unused ID before retrying.";
      }
    }
    if (json)
      io.stdout.write(
        `${JSON.stringify({ command: "browser run", ...result, ...(savedPath ? { savedPath } : {}), ...(saveError ? { saveError } : {}) })}\n`,
      );
    else {
      io.stdout.write(
        `\nBrowser test ${result.status} · ${result.assertions.filter((assertion) => assertion.passed).length}/${result.assertions.length} assertions\nReport: ${result.reportPath}\n`,
      );
      if (result.definition.assertions.length === 0)
        io.stdout.write(
          "No assertions were configured; this is an observed browser session, not a passing test.\n",
        );
      else if (result.assertions.length < result.definition.assertions.length)
        io.stdout.write("Some configured assertions were not reached before execution stopped.\n");
      if (savedPath) {
        io.stdout.write(`Saved test: ${savedPath}\n`);
        const names = [
          ...new Set(
            result.steps.flatMap((step) =>
              step.action === "fill" && step.parameter ? [step.parameter] : [],
            ),
          ),
        ];
        if (names.length)
          io.stdout.write(
            `Runtime inputs: ${names.join(", ")}. Supply each with --param-env <name>=<ENVIRONMENT_VARIABLE> when replaying.\n`,
          );
      }
      if (saveError) io.stderr.write(`${saveError}\n`);
    }
    if (selected.has("--open") && io.openUrl) {
      try {
        await io.openUrl(pathToFileURL(result.reportPath).href);
      } catch {
        io.stderr.write("The report could not open automatically. Open the printed report path manually.\n");
      }
    }
    return saveError || result.status === "failed" || result.status === "cancelled" ? 1 : 0;
  } catch (error) {
    const known = library !== undefined && error instanceof library.BrowserTestError;
    const message =
      error instanceof BrowserCliError || known
        ? error.message
        : "Browser test could not start. Check the source and run firedrill browser --help.";
    const code = known ? error.code : "browser.COMMAND_INVALID";
    if (json)
      io.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "browser", status: "failed", code, message })}\n`,
      );
    else io.stderr.write(`${code} ${message}\n`);
    return 2;
  }
}
