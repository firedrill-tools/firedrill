import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { packPublicPackages } from "./public-packages.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "firedrill-portability-"));
const workspace = join(temporaryRoot, "Firedrill üser project with spaces");
const artifactsDirectory = join(temporaryRoot, "packed artifacts ü");
// Windows cold installs can spend several minutes compiling native SQLite
// bindings even when the exact same packed consumer succeeds on every other
// supported platform. Keep the product commands tightly bounded below, but
// give the package-manager phase enough room to prove a real cold install.
const installTimeoutMs = 10 * 60_000;
const commandTimeoutMs = 60_000;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface RunOutput {
  readonly verdict: "passed" | "failed" | "inconclusive";
  readonly buildHash: string;
  readonly drills: readonly {
    readonly drillId: string;
    readonly trials: readonly {
      readonly result: {
        readonly identity: { readonly seed: string };
        readonly stateHash?: string;
        readonly trajectoryHash?: string;
        readonly assertionResults: readonly unknown[];
      };
      readonly reportDirectory: string;
      readonly htmlReport: string;
      readonly jsonReport: string;
      readonly junitReport: string;
      readonly worldFilePath: string;
    }[];
  }[];
}

function run(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeout?: number;
    readonly windowsShell?: boolean;
  } = {},
): CommandResult {
  const result = spawnSync(command, [...arguments_], {
    cwd: options.cwd ?? workspace,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    shell: options.windowsShell === true && process.platform === "win32",
    stdio: "pipe",
    timeout: options.timeout ?? commandTimeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function requireStatus(result: CommandResult, expected: number, description: string): CommandResult {
  if (result.status !== expected || result.error !== undefined) {
    throw new Error(
      `${description} exited ${String(result.status)} instead of ${expected}\n${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
    );
  }
  return result;
}

function parseJson<T>(result: CommandResult, description: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`${description} did not emit one JSON document\n${result.stdout}\n${result.stderr}`, {
      cause: error,
    });
  }
}

function requireFile(path: string, description: string): void {
  if (!existsSync(path)) throw new Error(`${description} was not written: ${path}`);
}

function installedCli(arguments_: readonly string[], expectedStatus = 0): CommandResult {
  const cli = join(workspace, "node_modules", "@firedrill", "cli", "dist", "bin.js");
  requireFile(cli, "installed CLI entrypoint");
  return requireStatus(
    run(process.execPath, [cli, ...arguments_], { env: executionEnvironment }),
    expectedStatus,
    `firedrill ${arguments_.join(" ")}`,
  );
}

function firstTrial(output: RunOutput) {
  const trial = output.drills[0]?.trials[0];
  if (trial === undefined) throw new Error("run output contains no trial");
  return trial;
}

function assertEvidence(output: RunOutput): void {
  const trial = firstTrial(output);
  requireFile(trial.worldFilePath, "trial SQLite world");
  requireFile(trial.htmlReport, "HTML report");
  requireFile(trial.jsonReport, "JSON report");
  requireFile(trial.junitReport, "JUnit report");
  requireFile(join(trial.reportDirectory, "evidence.jsonl"), "ordered evidence log");
  requireFile(join(trial.reportDirectory, "manifest.json"), "portable report manifest");
}

const executionEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  CI: "true",
  LANG: "de_DE.UTF-8",
  LC_ALL: "de_DE.UTF-8",
  NO_COLOR: "1",
  npm_config_offline: "true",
};

try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifactsDirectory, { recursive: true });
  const artifacts = packPublicPackages({
    repositoryRoot,
    outputDirectory: artifactsDirectory,
  });
  if (artifacts.length === 0) throw new Error("no public packages were packed");

  const dependencies = Object.fromEntries(
    artifacts.map((artifact) => [
      artifact.name,
      `file:${relative(workspace, join(artifactsDirectory, artifact.archive)).split(sep).join("/")}`,
    ]),
  );
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "firedrill-portable-consumer",
        private: true,
        version: "1.0.0",
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );

  requireStatus(
    run("npm", ["install", "--ignore-scripts=false", "--no-audit", "--no-fund"], {
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
      timeout: installTimeoutMs,
      windowsShell: true,
    }),
    0,
    "npm install from packed artifacts",
  );

  const shim = join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "firedrill.cmd" : "firedrill",
  );
  requireFile(shim, "installed firedrill executable");
  requireStatus(
    run("npm", ["exec", "--offline", "--", "firedrill", "--help"], {
      env: executionEnvironment,
      windowsShell: process.platform === "win32",
    }),
    0,
    "installed firedrill executable",
  );

  const initialized = parseJson<{ readonly status: string }>(
    installedCli(["init", "--path", "template", "--json"]),
    "init",
  );
  if (initialized.status !== "initialized") throw new Error("template init did not initialize a project");
  if (!readFileSync(join(workspace, ".gitignore"), "utf8").split(/\r?\n/).includes(".firedrill/")) {
    throw new Error("template init did not ignore local Firedrill runtime artifacts");
  }

  const format = parseJson<{ readonly status: string; readonly changed: readonly string[] }>(
    installedCli(["format", "--check", "--json"]),
    "format",
  );
  if (format.status !== "success" || format.changed.length !== 0) {
    throw new Error("initialized template is not canonically formatted");
  }
  const validation = parseJson<{ readonly status: string; readonly diagnostics: readonly unknown[] }>(
    installedCli(["validate", "--json"]),
    "validate",
  );
  if (validation.status !== "success" || validation.diagnostics.length !== 0) {
    throw new Error("initialized template did not validate cleanly");
  }

  const passing = parseJson<RunOutput>(installedCli(["run", "changes-resource", "--json"]), "passing drill");
  if (passing.verdict !== "passed") throw new Error("starter drill did not pass");
  assertEvidence(passing);

  const drillPath = join(workspace, "firedrill", "drills", "changes-resource.drill.yaml");
  const originalDrill = readFileSync(drillPath, "utf8");
  const failingDrill = originalDrill.replace(
    "    comparison:\n      operator: equals\n      value: 7",
    "    comparison:\n      operator: equals\n      value: 8",
  );
  if (failingDrill === originalDrill) throw new Error("starter failure edit no longer matches source");
  writeFileSync(drillPath, failingDrill);

  const failing = parseJson<RunOutput>(
    installedCli(["run", "changes-resource", "--json"], 1),
    "failing drill",
  );
  if (failing.verdict !== "failed") throw new Error("wrong expectation did not fail the drill");
  assertEvidence(failing);
  const failedTrial = firstTrial(failing);

  const verification = parseJson<{ readonly status: string }>(
    installedCli(["report", "verify", failedTrial.reportDirectory, "--json"]),
    "report verification",
  );
  if (verification.status !== "verified") throw new Error("failed report was not independently verified");

  const reproduced = parseJson<RunOutput>(
    installedCli(
      [
        "run",
        "changes-resource",
        "--build-hash",
        failing.buildHash,
        "--seed",
        failedTrial.result.identity.seed,
        "--trials",
        "1",
        "--json",
      ],
      1,
    ),
    "failure reproduction",
  );
  const reproducedTrial = firstTrial(reproduced);
  if (
    reproduced.verdict !== "failed" ||
    reproducedTrial.result.stateHash !== failedTrial.result.stateHash ||
    reproducedTrial.result.trajectoryHash !== failedTrial.result.trajectoryHash ||
    JSON.stringify(reproducedTrial.result.assertionResults) !==
      JSON.stringify(failedTrial.result.assertionResults)
  ) {
    throw new Error("same build and seed did not reproduce the failed consequence trajectory");
  }

  writeFileSync(drillPath, originalDrill);
  const restored = parseJson<RunOutput>(
    installedCli(["run", "changes-resource", "--json"]),
    "restored drill",
  );
  if (restored.verdict !== "passed") throw new Error("restored drill did not return to passing");

  const tool = parseJson<{ readonly status: string }>(
    installedCli(["tool", "test", "resource-store", "--json"]),
    "Tool conformance",
  );
  if (tool.status !== "passed") throw new Error("starter Tool conformance did not pass");

  process.stdout.write(
    `portable packed install passed on ${process.platform}/${process.arch} Node ${process.versions.node} (${artifacts.length} packages)\n`,
  );
} finally {
  if (temporaryRoot.startsWith(`${tmpdir()}/firedrill-portability-`)) {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
