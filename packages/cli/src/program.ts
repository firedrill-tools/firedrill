import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { CompileWorldResult } from "@firedrill/compiler";
import { compileWorld, formatWorldSources } from "@firedrill/compiler";
import type { Diagnostic } from "@firedrill/contracts";
import { SeedSchema, Sha256Schema, StableIdSchema } from "@firedrill/contracts";
import { startLocalInspector } from "@firedrill/inspector";
import type {
  CallbackReceiver,
  LocalRunComparison,
  ToolConformanceResult,
  ToolInspection,
  VerifiedLocalReport,
} from "@firedrill/sdk";
import {
  compareRuns,
  FiredrillProjectError,
  inspectTool,
  prepareToolContribution,
  runDrills,
  testTool,
  validateTool,
  verifyReport,
} from "@firedrill/sdk";
import { loadWorldBuild } from "@firedrill/world-build";
import { executeAgentCommand } from "./agent-command.js";
import { executeBrowserCommand } from "./browser-command.js";
import { executeCloudCommand } from "./cloud-command.js";
import { executeDataCommand } from "./data-command.js";
import { executeInitCommand, type InitCommandInput } from "./init-command.js";
import type { InitPath } from "./init-project.js";
import { executeMcpCommand } from "./mcp-command.js";
import { executeServeCommand } from "./serve-command.js";
import { executeToolDistributionCommand } from "./tool-distribution-command.js";
import { addToolPackage, createTool, FiredrillToolSetupError } from "./tool-setup.js";
import { watchFiles } from "./watch-files.js";
import { executeWorldCommand } from "./world-command.js";

export interface CliWriter {
  write(value: string): void;
}

export interface CliIo {
  readonly cwd: string;
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  /** Explicit protocol streams when embedding the standalone MCP command. */
  readonly stdio?: { readonly input: Readable; readonly output: Writable };
  /** Defaults to process.env. Injectable so embedding test runners do not mutate global state. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Native terminal capability, independent of whether a prompt reader is allocated. */
  readonly interactive?: boolean;
  /** Present only for an interactive terminal. JSON and CI callers omit it. */
  readonly ask?: (question: string) => Promise<string>;
  /** Browser launch is injected so programmatic callers retain control. */
  readonly openUrl?: (url: string) => Promise<void>;
}

interface ParsedArguments {
  readonly command?:
    | "agent"
    | "build"
    | "compare"
    | "format"
    | "init"
    | "inspect"
    | "plan"
    | "report"
    | "run"
    | "serve"
    | "tool"
    | "validate"
    | "world";
  readonly reportCommand?: "verify";
  readonly reportPath?: string;
  readonly toolCommand?: "add" | "contribute" | "create" | "inspect" | "search" | "test" | "validate";
  readonly toolTemplate?: "stateful" | "stateless";
  readonly toolPackage?: boolean;
  readonly toolName?: string;
  readonly toolIndex?: string;
  readonly toolLimit?: number;
  readonly toolOffset?: number;
  readonly worldCommand?: "call" | "tools";
  readonly toolId?: string;
  readonly worldToolId?: string;
  readonly operationId?: string;
  readonly operationInput?: string;
  readonly idempotencyKey?: string;
  readonly agentWorkflow?: "environment" | "drill";
  readonly agentPrompt?: string;
  readonly agentModel?: string;
  readonly agentEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly agentMaxTurns?: number;
  readonly agentMaxBudgetUsd?: number;
  readonly agentTimeoutMs?: number;
  readonly drillId?: string;
  readonly baselineReport?: string;
  readonly candidateReport?: string;
  readonly suite?: string;
  readonly tags?: readonly string[];
  readonly filter?: string;
  readonly shard?: { readonly index: number; readonly total: number };
  readonly root: string;
  readonly inspectorPort?: number;
  readonly scenarioId?: string;
  readonly actorId?: string;
  readonly mcpPort?: number;
  readonly cliPort?: number;
  readonly noOpen?: boolean;
  readonly reportDirectory?: string;
  readonly callbackReceiverOrigins?: Readonly<Record<string, string>>;
  readonly callbackSecretEnvironment?: Readonly<Record<string, string>>;
  readonly contributionOutput?: string;
  readonly buildHash?: string;
  readonly seed?: string;
  readonly trials?: number;
  readonly retries?: number;
  readonly concurrency?: number;
  readonly watch: boolean;
  readonly initPath?: InitPath;
  readonly initTool?: readonly string[];
  readonly initCustom?: string;
  readonly initSearch?: string;
  readonly initAuthoring?: NonNullable<InitCommandInput["initAuthoring"]>;
  readonly initInstall?: boolean;
  readonly initAllowAgent?: boolean;
  readonly initStart?: boolean;
  readonly json: boolean;
  readonly check: boolean;
  readonly acceptApache2?: boolean;
  readonly help: boolean;
  readonly error?: string;
}

const HELP = `Firedrill — run drills against repository-defined worlds locally

Firedrill starts a fresh synthetic world for each trial, connects your existing
agent through its declared target, then verifies state and tool-call consequences.

Usage:
  firedrill browser <run|verify> [options]  (optional browser tests)
  firedrill data <preview|save> [options]  (review selected data before importing)
  firedrill mcp [--allow-execution] [--root <path>]  (coding-agent control over stdio)
  firedrill cloud <command> [options]  (optional destination extension)
  firedrill agent [--workflow <environment|drill>] [--prompt <task>] [--model <model>] [--effort <level>] [--max-turns <count>] [--max-budget-usd <amount>] [--timeout-ms <milliseconds>] [--json] [--root <path>]
  firedrill [run] [drill-id] [--suite <id>] [--tag <tag>] [--filter <text>] [--shard <index>/<total>] [--trials <count>] [--retries <count>] [--concurrency <count>] [--seed <seed>] [--build-hash <hash>] [--report-dir <path>] [--callback-receiver <id>=<origin>] [--callback-secret-env <id>=<variable>] [--watch] [--json] [--root <path>]
  firedrill validate [--json] [--root <path>]
  firedrill plan [--json] [--root <path>]
  firedrill build [--json] [--root <path>]
  firedrill format [--check] [--json] [--root <path>]
  firedrill compare <baseline-report> <candidate-report> [--json]
  firedrill report verify <report-directory> [--json]
  firedrill init [--tool <source-or-catalog-id> | --custom <tool-id> | --search <text> | --path <path>] [--index <path-or-url>] [--install] [--authoring <manual|firedrill-agent|coding-agent>] [--allow-agent] [--start] [--no-open] [--json] [--root <path>]
  firedrill inspect [--port <port>] [--no-open] [--json] [--root <path>]
  firedrill serve [--scenario <id>] [--actor <id>] [--seed <seed>] [--port <port>] [--mcp-port <port>] [--cli-port <port>] [--no-open] [--json] [--root <path>]
  firedrill tool search [text] [--index <path-or-url>] [--limit <1-100>] [--offset <count>] [--json]
  firedrill tool create <tool-id> [--template <stateful|stateless>] [--package] [--name <npm-name>] [--json] [--root <path>]
  firedrill tool add <source> [--install] [--json] [--root <path>]
  firedrill tool inspect <tool-id> [--json] [--root <path>]
  firedrill tool validate <tool-id> [--json] [--root <path>]
  firedrill tool test <tool-id> [--suite <id>] [--seed <seed>] [--callback-receiver <id>=<origin>] [--callback-secret-env <id>=<variable>] [--json] [--root <path>]
  firedrill tool contribute <tool-id> --accept-apache-2.0 [--output <path>] [--suite <id>] [--seed <seed>] [--callback-receiver <id>=<origin>] [--callback-secret-env <id>=<variable>] [--json] [--root <path>]
  firedrill world tools [--json]
  firedrill world call <tool-id> <operation-id> [--input <json-object>] [--idempotency-key <key>] [--json]

Commands:
  agent     Author or repair Firedrill source with the optional local Firedrill Agent
  run       Run every drill, or one named drill; this is the default command
  serve     Start a local Tool backend without an agent, target, or drill
  validate  Parse and validate source without writing a build
  plan      Show the exact semantic build that source would produce
  build     Materialize and verify an immutable executable world build
  format    Format typed source; --check reports without writing
  compare   Compare two verified local report bundles without inferring quality
  report    Verify a portable local report bundle without contacting a service
  init      Inspect onboarding paths or initialize one without overwriting files
  inspect   Open the local World, Drills, and Runs inspector
  tool      Inspect, load-check, or conformance-test a selected Tool
  world     Discover or call Tools through an active drill's CLI binding

Run options:
  --suite <id>          Run a named drill suite
  --tag <tag>           Select drills with a tag; repeat to match any tag
  --filter <text>       Match drill ids and titles
  --shard <n>/<total>   Run one deterministic, one-based shard
  --trials <count>      Override the drill's declared trial count
  --retries <count>     Retry non-passing trials and retain every attempt
  --concurrency <count> Run up to this many local trials at once
  --seed <seed>         Set the first unsigned 64-bit seed; later trials increment it
  --build-hash <hash>   Run an existing immutable build instead of compiling current source
  --report-dir <path>   Write per-trial report bundles beneath this directory
  --callback-receiver <id>=<origin>
                        Route a world callback to a loopback HTTP origin; repeat per receiver
  --callback-secret-env <id>=<variable>
                        Read that receiver's signing secret from an environment variable
  --watch               Rerun after repository changes; JSON mode emits one object per line

Tool contribution options:
  --accept-apache-2.0   Attest source rights, customer-data review, and Apache-2.0 licensing
  --output <path>       New directory for the local review bundle; never overwritten

Init options:
  --path <path>         Use firedrill-agent, coding-agent, template, or manual
  --tool <source|id>    Select a reusable Tool; repeat to compose several
  --custom <tool-id>    Create your own stateful Tool; no key required
  --search <text>       Search Tool metadata without writing or installing
  --index <path-or-url> Use an independently maintained index for init/tool search
  --install             Authorize pinned dependency installation, scripts disabled
  --authoring <mode>    Optional manual, firedrill-agent, or coding-agent help
  --allow-agent         Authorize the optional Anthropic-backed authoring session
  --start               Start selected Tools and their inspector in the foreground

Bare init is guided only in an interactive terminal. JSON, CI, and piped use is
read-only unless --tool, --custom, or --path explicitly selects a setup.
`;

const COMMAND_HELP: Readonly<
  Record<Exclude<ParsedArguments["command"], undefined | "report" | "tool" | "world">, string>
> = {
  agent: `Author or repair this repository with the optional Firedrill Agent

Usage:
  firedrill agent [--workflow <environment|drill>] [--prompt <task>] [--model <model>] [--effort <level>]
                  [--max-turns <count>] [--max-budget-usd <amount>]
                  [--timeout-ms <milliseconds>]
                  [--json] [--root <path>]

This separately installed, local authoring assistant uses the Claude Agent SDK
and your ANTHROPIC_API_KEY. It can inspect and edit repository files, then call
the real Firedrill formatter, compiler, Tool checks, and drill runner. It cannot
read secret files, use a shell, commit, push, publish, or call Firedrill Cloud.

The normal CLI and SDK work without this package or an Anthropic key.
Defaults: 40 turns, $2 maximum model spend, and a 15-minute deadline.
`,
  run: `Run drills against the repository world

Usage:
  firedrill [run] [drill-id] [--suite <id>] [--tag <tag>] [--filter <text>]
            [--shard <index>/<total>] [--trials <count>] [--retries <count>]
            [--concurrency <count>] [--seed <seed>] [--build-hash <hash>]
            [--report-dir <path>] [--callback-receiver <id>=<origin>]
            [--callback-secret-env <id>=<variable>]
            [--watch] [--json] [--root <path>]

With no drill or suite, Firedrill runs every drill. Each trial gets an isolated
world and terminal, JSON, JUnit, and self-contained HTML evidence. Exit 0 means
every selected drill passed; exit 1 means a completed failure or runtime failure;
exit 2 means the command or selection is invalid.

Callbacks are opt-in runtime bindings. Repository source names a receiver id;
--callback-receiver maps it to a loopback HTTP origin. Use
--callback-secret-env when the callback contract requires HMAC signing. Secrets
are read from the environment and never written to source or reports.
`,
  validate: `Validate Firedrill source without executing Tool modules

Usage:
  firedrill validate [--json] [--root <path>]

Reports stable diagnostics with source locations and repair suggestions. It does
not materialize a build or run the agent.
`,
  plan: `Inspect the exact semantic world build without materializing it

Usage:
  firedrill plan [--json] [--root <path>]

Shows build identity, Tools, scenarios, drills, suites, targets, and provenance.
`,
  build: `Materialize and verify an immutable executable world build

Usage:
  firedrill build [--json] [--root <path>]

Tool source is bundled during compilation, but its module is not executed until
the verified build is loaded for validation or a drill run.
`,
  format: `Format typed Firedrill source deterministically

Usage:
  firedrill format [--check] [--json] [--root <path>]

Use --check in CI to report files that would change without writing them.
`,
  compare: `Compare two verified local report bundles

Usage:
  firedrill compare <baseline-report> <candidate-report> [--json]

Firedrill verifies both bundles, reports input compatibility first, then shows
factual verdict, state, trajectory, Tool-call, and assertion deltas. It does not
infer that one run is better when inputs are incompatible.
`,
  init: `Choose a clear starting path for this repository's local fake tools

Usage:
  firedrill init [--tool <source-or-catalog-id> | --custom <tool-id> | --search <text>]
                [--index <path-or-url>] [--install] [--authoring <manual|firedrill-agent|coding-agent>]
                [--allow-agent] [--start] [--no-open] [--json] [--root <path>]
  firedrill init --path <firedrill-agent|coding-agent|template|manual> [--allow-agent] [--start] [--json]

Interactive init lets you pick/search a ready-made Tool or create your own,
optionally customize it, and start local HTTP, MCP, CLI and inspector interfaces.
No account, model key, agent target, scenario, or drill is needed. Catalog entries
show only their declared operations and limitations, not full-service emulation.
Missing packages require installation consent (--install without a TTY).
Installation pins the resolved package and disables lifecycle scripts; unpublished
packages may require a separately supplied local package archive.

Bare JSON, CI, and piped init remains read-only. --search is always read-only.
--tool selects a package, catalog id, Git source, or local package directory.
--index explicitly reads an independently maintained local/HTTPS Tool index.
--custom creates a stateful get/set Tool scaffold.
--start explicitly runs selected Tool code until Ctrl+C.
The Agent is optional: --authoring firedrill-agent --allow-agent uses your shell's
ANTHROPIC_API_KEY. Never put key text in command arguments. Missing keys leave a
resumable setup. --authoring coding-agent installs the canonical skill and brief.

The existing --path alternatives remain available:
  firedrill-agent Install the skill and brief for Firedrill's optional local agent
  coding-agent  Install the canonical skill and a bounded repository brief
  template      Install a complete neutral world, Tool, target, and passing drill
  manual        Install the smallest compilable shell without a fake drill

Initialization is idempotent and never replaces a conflicting file. A selected
path ensures .firedrill/ is ignored, appending that one rule when needed.
`,
  inspect: `Inspect the local world and drill evidence in a browser

Usage:
  firedrill inspect [--port <port>] [--no-open] [--json] [--root <path>]

The inspector compiles repository source, then serves a loopback-only, offline
UI with World, Drills, and Runs. It reads real local SQLite worlds and verified
report bundles. Repository source stays authoritative and read-only.

External targets remain owned by the caller. Start @firedrill/inspector from the
process that supplies the agent callback when you need to run them from the UI.
Use --no-open for terminal-only launch. JSON mode never opens a browser.
`,
  serve: `Start a standalone local Tool backend

Usage:
  firedrill serve [--scenario <id>] [--actor <id>] [--seed <seed>]
                 [--port <port>] [--mcp-port <port>] [--cli-port <port>]
                 [--no-open] [--json] [--root <path>]

Uses the repository world baseline, or a named scenario, without executing an
agent or any tests. Starts HTTP, MCP, and Firedrill CLI interfaces on loopback.
Opens the inspector on the same running world; --no-open skips browser launch.
Ports default to 0 (choose available ports); --port sets the HTTP interface.
The single available actor is selected automatically; use --actor when needed.

Connection environment values include scoped local tokens: keep them private.
The command stays in the foreground until Ctrl+C. It does not modify .env files.
JSON mode emits a ready event with actual endpoints, then a stopped or failed
event on shutdown. Each launch creates a fresh retained world under .firedrill/.
`,
};

const REPORT_HELP = `Verify a portable local Firedrill report bundle

Usage:
  firedrill report verify <report-directory> [--json]

Verification is entirely local. It checks the manifest, exact file set, hashes,
schemas, identities, evidence ordering, and agreement between every projection.
It detects corruption and inconsistency; an unsigned local bundle does not prove
who authored it.
`;

const TOOL_HELP = `Create, select, inspect, and prove Tool behavior

Usage:
  firedrill tool search [text] [--index <path-or-url>] [--limit <1-100>] [--offset <count>] [--json]
  firedrill tool create <tool-id> [--template <stateful|stateless>] [--package] [--name <npm-name>] [--json] [--root <path>]
  firedrill tool add <source> [--install] [--json] [--root <path>]
  firedrill tool inspect <tool-id> [--json] [--root <path>]
  firedrill tool validate <tool-id> [--json] [--root <path>]
  firedrill tool test <tool-id> [--suite <id>] [--seed <seed>]
            [--callback-receiver <id>=<origin>] [--callback-secret-env <id>=<variable>]
            [--json] [--root <path>]
  firedrill tool contribute <tool-id> --accept-apache-2.0 [--output <path>]

create writes editable behavior and a declaration; it defaults to stateful.
--package scaffolds a distributable Tool with starter state and conformance drills.
add selects an installed package; --install explicitly acquires an npm, Git, or
local source first. No Tool behavior runs. Existing actor grants stay unchanged.
search can read anyone's index; indexing and contributing are never required.
A selected Tool can come from this repository or from an installed package named
once in firedrill.json under toolPackages. inspect never executes behavior.
validate and test execute the selected module locally with your authority. test
runs ordinary conformance drills twice and checks coverage and determinism.
Callback Tools use the same explicit local receiver bindings as firedrill run.
contribute is only for source owned by this repository; it never uploads source.
`;

const WORLD_HELP = `Call the active synthetic world from a CLI-based agent

Usage:
  firedrill world tools [--json]
  firedrill world call <tool-id> <operation-id> [--input <json-object>]
            [--idempotency-key <key>] [--json]

Use the environment printed by firedrill serve, or run this command inside an
agent target whose bindings include cli.
It discovers or invokes the same typed Tool operations used by HTTP, MCP, and
direct bindings. It does not create a world or run a drill by itself.
`;

const TOOL_COMMAND_HELP: Readonly<Record<Exclude<ParsedArguments["toolCommand"], undefined>, string>> = {
  search: `Find independently maintained Tool packages

Usage:
  firedrill tool search [text] [--index <path-or-url>] [--limit <1-100>] [--offset <count>]
            [--json] [--root <path>]

Reads bundled metadata by default. --index explicitly reads a local or HTTPS
index maintained by anyone. No package installation or behavior execution occurs.
Publisher metadata is not a security endorsement or a service-parity certificate.
Install a selected source with firedrill tool add <source> --install.
`,
  create: `Create an editable repository Tool

Usage:
  firedrill tool create <tool-id> [--template <stateful|stateless>] [--package]
            [--name <npm-package-name>] [--json] [--root <path>]

Creates an actual local behavior module and its Tool declaration without
executing behavior. --template defaults to stateful; stateless provides a plain
function. Existing files are never overwritten. A missing Firedrill project is
initialized with a minimal backend world, not an agent target or test drill.
Existing actor permissions are not expanded; follow the printed grant guidance.
Use firedrill serve when ready to connect a client to the local backend.
--package creates a standalone distributable package in a new or empty --root,
including starter state and conformance drills. --name sets its npm name.
You can maintain and distribute it from your own repository; contribution to
Firedrill is optional. No publication or installation happens during creation.
`,
  add: `Select or explicitly install a Tool package

Usage:
  firedrill tool add <source> [--install] [--json] [--root <path>]

Reads the installed package's Tool metadata and adds its exact package name to
firedrill.json under toolPackages. Without --install, the package must already be
installed; no download occurs. With --install, accept npm name[@version], a local
package directory/tarball, github:owner/repo#ref::subdirectory, or
git+https://host/repo.git#ref::subdirectory. Git is pinned to its resolved commit.
Lifecycle scripts are disabled; Tool behavior is not executed by this command.
Commit the dependency manifest/lock and .firedrill-tools/ source archives if created.
Existing actor permissions stay intact. Review third-party code before execution.
`,
  inspect: `Inspect a Tool contract and exact selected source closure without executing its module

Usage:
  firedrill tool inspect <tool-id> [--json] [--root <path>]
`,
  validate: `Load a selected Tool and verify its executable behavior surface

Usage:
  firedrill tool validate <tool-id> [--json] [--root <path>]

This executes the selected repository or installed-package module locally with
the developer's authority.
`,
  test: `Run a Tool's selected conformance drills twice

Usage:
  firedrill tool test <tool-id> [--suite <id>] [--seed <seed>]
            [--callback-receiver <id>=<origin>] [--callback-secret-env <id>=<variable>]
            [--json] [--root <path>]

The result must pass both runs, reproduce state and trajectory with the same seed,
and exercise every declared operation, error, event, fault, subscription, and callback.
`,
  contribute: `Prepare a local, reviewable Tool contribution bundle

Usage:
  firedrill tool contribute <tool-id> --accept-apache-2.0 [--output <path>]
            [--suite <id>] [--seed <seed>] [--callback-receiver <id>=<origin>]
            [--callback-secret-env <id>=<variable>] [--json] [--root <path>]

The Tool must be authored in this repository; installed dependencies cannot be
repackaged from a consumer project. The attestation confirms source rights,
customer-data review, and Apache-2.0 licensing. Firedrill reruns conformance,
scans the exact source closure, and writes a new non-overwriting bundle. Nothing
is uploaded and no pull request is opened.
`,
};

function helpFor(parsed: ParsedArguments): string {
  if (parsed.command === "report") return REPORT_HELP;
  if (parsed.command === "tool") {
    return parsed.toolCommand === undefined ? TOOL_HELP : TOOL_COMMAND_HELP[parsed.toolCommand];
  }
  if (parsed.command === "world") return WORLD_HELP;
  if (parsed.command === undefined) return HELP;
  return COMMAND_HELP[parsed.command];
}

function parseArguments(arguments_: readonly string[], cwd: string): ParsedArguments {
  if (arguments_.some((argument) => argument === "--help" || argument === "-h")) {
    const command = arguments_.find((argument): argument is NonNullable<ParsedArguments["command"]> =>
      [
        "agent",
        "build",
        "compare",
        "format",
        "init",
        "inspect",
        "plan",
        "report",
        "run",
        "serve",
        "tool",
        "validate",
        "world",
      ].includes(argument),
    );
    const toolCommand =
      command === "tool"
        ? arguments_.find((argument): argument is NonNullable<ParsedArguments["toolCommand"]> =>
            ["add", "contribute", "create", "inspect", "search", "test", "validate"].includes(argument),
          )
        : undefined;
    return {
      root: cwd,
      watch: false,
      noOpen: false,
      json: arguments_.includes("--json"),
      check: false,
      help: true,
      ...(command === undefined ? {} : { command }),
      ...(command === "report" ? { reportCommand: "verify" as const } : {}),
      ...(toolCommand === undefined ? {} : { toolCommand }),
    };
  }
  let command: ParsedArguments["command"];
  let root = cwd;
  let json = arguments_.includes("--json");
  let check = false;
  let acceptApache2 = false;
  let help = false;
  let reportCommand: ParsedArguments["reportCommand"];
  let reportPath: string | undefined;
  let toolCommand: ParsedArguments["toolCommand"];
  let worldCommand: ParsedArguments["worldCommand"];
  let toolId: string | undefined;
  let worldToolId: string | undefined;
  let operationId: string | undefined;
  let operationInput: string | undefined;
  let idempotencyKey: string | undefined;
  let agentWorkflow: ParsedArguments["agentWorkflow"];
  let agentPrompt: string | undefined;
  let agentModel: string | undefined;
  let agentEffort: ParsedArguments["agentEffort"];
  let agentMaxTurns: number | undefined;
  let agentMaxBudgetUsd: number | undefined;
  let agentTimeoutMs: number | undefined;
  let drillId: string | undefined;
  let baselineReport: string | undefined;
  let candidateReport: string | undefined;
  let suite: string | undefined;
  const tags: string[] = [];
  let filter: string | undefined;
  let shard: { index: number; total: number } | undefined;
  let reportDirectory: string | undefined;
  const callbackReceiverOrigins: Record<string, string> = {};
  const callbackSecretEnvironment: Record<string, string> = {};
  let contributionOutput: string | undefined;
  let buildHash: string | undefined;
  let seed: string | undefined;
  let trials: number | undefined;
  let retries: number | undefined;
  let concurrency: number | undefined;
  let watch = false;
  let initPath: InitPath | undefined;
  const initTools: string[] = [];
  let initCustom: string | undefined;
  let initSearch: string | undefined;
  let initAuthoring: ParsedArguments["initAuthoring"];
  let initInstall = false;
  let initAllowAgent = false;
  let initStart = false;
  let inspectorPort: number | undefined;
  let scenarioId: string | undefined;
  let actorId: string | undefined;
  let mcpPort: number | undefined;
  let cliPort: number | undefined;
  let toolTemplate: ParsedArguments["toolTemplate"];
  let toolPackage = false;
  let toolName: string | undefined;
  let toolIndex: string | undefined;
  let toolLimit: number | undefined;
  let toolOffset: number | undefined;
  let noOpen = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--accept-apache-2.0") {
      acceptApache2 = true;
      continue;
    }
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    if (argument === "--port") {
      const value = arguments_[index + 1];
      inspectorPort = Number(value);
      if (
        value === undefined ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(inspectorPort) ||
        inspectorPort < 0 ||
        inspectorPort > 65_535
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          noOpen,
          error: "--port must be an integer from 0 through 65535",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--mcp-port" || argument === "--cli-port") {
      const value = arguments_[index + 1];
      const port = Number(value);
      if (
        value === undefined ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(port) ||
        port < 0 ||
        port > 65_535
      )
        return {
          root,
          watch,
          json,
          check,
          help,
          error: `${argument} must be an integer from 0 through 65535`,
        };
      if (argument === "--mcp-port") mcpPort = port;
      else cliPort = port;
      index += 1;
      continue;
    }
    if (argument === "--scenario" || argument === "--actor") {
      const value = arguments_[index + 1];
      if (!StableIdSchema.safeParse(value).success)
        return { root, watch, json, check, help, error: `${argument} requires a valid Firedrill id` };
      if (argument === "--scenario") scenarioId = value;
      else actorId = value;
      index += 1;
      continue;
    }
    if (argument === "--package") {
      toolPackage = true;
      continue;
    }
    if (argument === "--name" || argument === "--index") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-") || value.trim().length === 0 || value.length > 2048)
        return { root, watch, json, check, help, error: `${argument} requires a non-empty value` };
      if (argument === "--name") toolName = value;
      else toolIndex = value;
      index += 1;
      continue;
    }
    if (argument === "--limit" || argument === "--offset") {
      const value = arguments_[index + 1];
      const number = Number(value);
      if (
        value === undefined ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number < (argument === "--limit" ? 1 : 0) ||
        (argument === "--limit" && number > 100)
      )
        return {
          root,
          watch,
          json,
          check,
          help,
          error: `${argument} must be ${argument === "--limit" ? "1 through 100" : "a non-negative integer"}`,
        };
      if (argument === "--limit") toolLimit = number;
      else toolOffset = number;
      index += 1;
      continue;
    }
    if (argument === "--template") {
      const value = arguments_[index + 1];
      if (value !== "stateful" && value !== "stateless")
        return { root, watch, json, check, help, error: "--template must be stateful or stateless" };
      toolTemplate = value;
      index += 1;
      continue;
    }
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (value === undefined) return { root, watch, json, check, help, error: "--root requires a path" };
      root = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument === "--report-dir") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, watch, json, check, help, error: "--report-dir requires a path" };
      }
      reportDirectory = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument === "--callback-receiver") {
      const value = arguments_[index + 1];
      const separator = value?.indexOf("=") ?? -1;
      const receiverId = separator > 0 ? value?.slice(0, separator) : undefined;
      const origin = separator > 0 ? value?.slice(separator + 1) : undefined;
      if (
        receiverId === undefined ||
        origin === undefined ||
        origin.length === 0 ||
        !StableIdSchema.safeParse(receiverId).success
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--callback-receiver requires <receiver-id>=<loopback-origin>",
        };
      }
      if (callbackReceiverOrigins[receiverId] !== undefined) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: `callback receiver ${receiverId} was configured more than once`,
        };
      }
      callbackReceiverOrigins[receiverId] = origin;
      index += 1;
      continue;
    }
    if (argument === "--callback-secret-env") {
      const value = arguments_[index + 1];
      const separator = value?.indexOf("=") ?? -1;
      const receiverId = separator > 0 ? value?.slice(0, separator) : undefined;
      const environmentVariable = separator > 0 ? value?.slice(separator + 1) : undefined;
      if (
        receiverId === undefined ||
        environmentVariable === undefined ||
        !StableIdSchema.safeParse(receiverId).success ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentVariable)
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--callback-secret-env requires <receiver-id>=<environment-variable>",
        };
      }
      if (callbackSecretEnvironment[receiverId] !== undefined) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: `callback secret for ${receiverId} was configured more than once`,
        };
      }
      callbackSecretEnvironment[receiverId] = environmentVariable;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, watch, json, check, help, acceptApache2, error: "--output requires a path" };
      }
      contributionOutput = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument === "--input") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, watch, json, check, help, error: "--input requires a JSON object" };
      }
      operationInput = value;
      index += 1;
      continue;
    }
    if (argument === "--idempotency-key") {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0 || value.length > 255) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--idempotency-key requires 1 through 255 characters",
        };
      }
      idempotencyKey = value;
      index += 1;
      continue;
    }
    if (argument === "--prompt") {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { root, watch, json, check, help, error: "--prompt requires non-empty text" };
      }
      agentPrompt = value;
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0 || value.length > 200) {
        return { root, watch, json, check, help, error: "--model requires 1 through 200 characters" };
      }
      agentModel = value;
      index += 1;
      continue;
    }
    if (argument === "--effort") {
      const value = arguments_[index + 1];
      if (!(["low", "medium", "high", "xhigh", "max"] as const).some((item) => item === value)) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--effort must be low, medium, high, xhigh, or max",
        };
      }
      agentEffort = value as NonNullable<ParsedArguments["agentEffort"]>;
      index += 1;
      continue;
    }
    if (argument === "--max-turns") {
      const value = arguments_[index + 1];
      agentMaxTurns = Number(value);
      if (
        value === undefined ||
        !Number.isSafeInteger(agentMaxTurns) ||
        agentMaxTurns < 1 ||
        agentMaxTurns > 200
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--max-turns must be an integer from 1 through 200",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--max-budget-usd") {
      const value = arguments_[index + 1];
      agentMaxBudgetUsd = Number(value);
      if (
        value === undefined ||
        !Number.isFinite(agentMaxBudgetUsd) ||
        agentMaxBudgetUsd <= 0 ||
        agentMaxBudgetUsd > 1_000
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--max-budget-usd must be greater than 0 and at most 1000",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--timeout-ms") {
      const value = arguments_[index + 1];
      agentTimeoutMs = Number(value);
      if (
        value === undefined ||
        !Number.isSafeInteger(agentTimeoutMs) ||
        agentTimeoutMs < 1_000 ||
        agentTimeoutMs > 7_200_000
      ) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--timeout-ms must be an integer from 1000 through 7200000",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--suite") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, tags, watch, json, check, help, error: "--suite requires an id" };
      }
      suite = value;
      index += 1;
      continue;
    }
    if (argument === "--tag") {
      const value = arguments_[index + 1];
      if (value === undefined)
        return { root, tags, watch, json, check, help, error: "--tag requires a value" };
      tags.push(value);
      index += 1;
      continue;
    }
    if (argument === "--filter") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, tags, watch, json, check, help, error: "--filter requires text" };
      }
      filter = value;
      index += 1;
      continue;
    }
    if (argument === "--shard") {
      const value = arguments_[index + 1];
      const match = value?.match(/^(\d+)\/(\d+)$/);
      const ordinal = Number(match?.[1]);
      const total = Number(match?.[2]);
      if (
        match === null ||
        !Number.isSafeInteger(ordinal) ||
        !Number.isSafeInteger(total) ||
        ordinal < 1 ||
        total < 1 ||
        ordinal > total ||
        total > 1_000
      ) {
        return {
          root,
          tags,
          watch,
          json,
          check,
          help,
          error: "--shard must be a one-based value such as 1/4",
        };
      }
      shard = { index: ordinal - 1, total };
      index += 1;
      continue;
    }
    if (argument === "--seed") {
      const value = arguments_[index + 1];
      if (value === undefined) return { root, watch, json, check, help, error: "--seed requires a value" };
      seed = value;
      index += 1;
      continue;
    }
    if (argument === "--build-hash") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        return { root, watch, json, check, help, error: "--build-hash requires a hash" };
      }
      buildHash = value;
      index += 1;
      continue;
    }
    if (argument === "--trials") {
      const value = arguments_[index + 1];
      if (value === undefined) return { root, watch, json, check, help, error: "--trials requires a count" };
      trials = Number(value);
      if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10_000) {
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--trials must be an integer from 1 through 10000",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--retries") {
      const value = arguments_[index + 1];
      retries = Number(value);
      if (value === undefined || !Number.isSafeInteger(retries) || retries < 0 || retries > 10) {
        return {
          root,
          tags,
          watch,
          json,
          check,
          help,
          error: "--retries must be an integer from 0 through 10",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--concurrency") {
      const value = arguments_[index + 1];
      concurrency = Number(value);
      if (value === undefined || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
        return {
          root,
          tags,
          watch,
          json,
          check,
          help,
          error: "--concurrency must be an integer from 1 through 64",
        };
      }
      index += 1;
      continue;
    }
    if (argument === "--install" || argument === "--allow-agent" || argument === "--start") {
      if (argument === "--install") initInstall = true;
      if (argument === "--allow-agent") initAllowAgent = true;
      if (argument === "--start") initStart = true;
      continue;
    }
    if (argument === "--tool" || argument === "--custom" || argument === "--search") {
      const value = arguments_[index + 1];
      if (
        value === undefined ||
        value.startsWith("-") ||
        value.trim().length === 0 ||
        value.length > (argument === "--tool" ? 4096 : 500)
      )
        return {
          root,
          watch,
          json,
          check,
          help,
          error: `${argument} requires 1 through ${argument === "--tool" ? 4096 : 500} characters`,
        };
      if (argument === "--tool") initTools.push(value);
      if (argument === "--custom") initCustom = value;
      if (argument === "--search") initSearch = value;
      index += 1;
      continue;
    }
    if (argument === "--authoring") {
      const value = arguments_[index + 1];
      if (value !== "manual" && value !== "firedrill-agent" && value !== "coding-agent")
        return {
          root,
          watch,
          json,
          check,
          help,
          error: "--authoring must be manual, firedrill-agent, or coding-agent",
        };
      initAuthoring = value;
      index += 1;
      continue;
    }
    if (argument === "--workflow") {
      const value = arguments_[index + 1];
      if (value !== "environment" && value !== "drill")
        return { root, watch, json, check, help, error: "--workflow must be environment or drill" };
      agentWorkflow = value;
      index += 1;
      continue;
    }
    if (argument === "--path") {
      const value = arguments_[index + 1];
      if (
        value !== "firedrill-agent" &&
        value !== "coding-agent" &&
        value !== "template" &&
        value !== "manual"
      ) {
        return {
          root,
          tags,
          watch,
          json,
          check,
          help,
          error: "--path must be firedrill-agent, coding-agent, template, or manual",
        };
      }
      initPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) {
      return { root, watch, json, check, help, error: `unknown option ${argument}` };
    }
    if (command === "tool") {
      if (toolCommand === undefined) {
        if (
          argument !== "add" &&
          argument !== "contribute" &&
          argument !== "create" &&
          argument !== "inspect" &&
          argument !== "search" &&
          argument !== "test" &&
          argument !== "validate"
        ) {
          return {
            root,
            watch,
            json,
            check,
            help,
            error: `unknown tool command ${argument}; use search, create, add, inspect, validate, test, or contribute`,
          };
        }
        toolCommand = argument;
      } else if (toolId === undefined) {
        toolId = argument;
      } else {
        return { root, watch, json, check, help, error: `unexpected argument ${argument}` };
      }
      continue;
    }
    if (command === "report") {
      if (reportCommand === undefined) {
        if (argument !== "verify") {
          return { root, watch, json, check, help, error: `unknown report command ${argument}; use verify` };
        }
        reportCommand = argument;
      } else if (reportPath === undefined) {
        reportPath = resolve(cwd, argument);
      } else {
        return { root, watch, json, check, help, error: `unexpected argument ${argument}` };
      }
      continue;
    }
    if (command === "world") {
      if (worldCommand === undefined) {
        if (argument !== "call" && argument !== "tools") {
          return {
            root,
            watch,
            json,
            check,
            help,
            error: `unknown world command ${argument}; use tools or call`,
          };
        }
        worldCommand = argument;
      } else if (worldCommand === "call" && worldToolId === undefined) {
        worldToolId = argument;
      } else if (worldCommand === "call" && operationId === undefined) {
        operationId = argument;
      } else {
        return { root, watch, json, check, help, error: `unexpected argument ${argument}` };
      }
      continue;
    }
    if (command === "run" && drillId === undefined) {
      drillId = argument;
      continue;
    }
    if (command === "compare") {
      if (baselineReport === undefined) baselineReport = resolve(cwd, argument ?? "");
      else if (candidateReport === undefined) candidateReport = resolve(cwd, argument ?? "");
      else return { root, watch, json, check, help, error: `unexpected argument ${argument}` };
      continue;
    }
    if (command !== undefined) {
      return { root, watch, json, check, help, error: `unexpected argument ${argument}` };
    }
    if (
      argument === "agent" ||
      argument === "build" ||
      argument === "compare" ||
      argument === "format" ||
      argument === "init" ||
      argument === "inspect" ||
      argument === "plan" ||
      argument === "report" ||
      argument === "run" ||
      argument === "serve" ||
      argument === "tool" ||
      argument === "validate" ||
      argument === "world"
    ) {
      command = argument;
    } else {
      command = "run";
      drillId = argument;
    }
  }
  return {
    ...(command === undefined ? {} : { command }),
    ...(reportCommand === undefined ? {} : { reportCommand }),
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(toolCommand === undefined ? {} : { toolCommand }),
    ...(worldCommand === undefined ? {} : { worldCommand }),
    ...(toolId === undefined ? {} : { toolId }),
    ...(worldToolId === undefined ? {} : { worldToolId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(operationInput === undefined ? {} : { operationInput }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(agentWorkflow === undefined ? {} : { agentWorkflow }),
    ...(agentPrompt === undefined ? {} : { agentPrompt }),
    ...(agentModel === undefined ? {} : { agentModel }),
    ...(agentEffort === undefined ? {} : { agentEffort }),
    ...(agentMaxTurns === undefined ? {} : { agentMaxTurns }),
    ...(agentMaxBudgetUsd === undefined ? {} : { agentMaxBudgetUsd }),
    ...(agentTimeoutMs === undefined ? {} : { agentTimeoutMs }),
    ...(drillId === undefined ? {} : { drillId }),
    ...(baselineReport === undefined ? {} : { baselineReport }),
    ...(candidateReport === undefined ? {} : { candidateReport }),
    ...(suite === undefined ? {} : { suite }),
    tags,
    ...(filter === undefined ? {} : { filter }),
    ...(shard === undefined ? {} : { shard }),
    root,
    ...(inspectorPort === undefined ? {} : { inspectorPort }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(mcpPort === undefined ? {} : { mcpPort }),
    ...(cliPort === undefined ? {} : { cliPort }),
    ...(toolTemplate === undefined ? {} : { toolTemplate }),
    ...(toolPackage ? { toolPackage } : {}),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolIndex === undefined ? {} : { toolIndex }),
    ...(toolLimit === undefined ? {} : { toolLimit }),
    ...(toolOffset === undefined ? {} : { toolOffset }),
    noOpen,
    ...(reportDirectory === undefined ? {} : { reportDirectory }),
    ...(Object.keys(callbackReceiverOrigins).length === 0 ? {} : { callbackReceiverOrigins }),
    ...(Object.keys(callbackSecretEnvironment).length === 0 ? {} : { callbackSecretEnvironment }),
    ...(contributionOutput === undefined ? {} : { contributionOutput }),
    ...(buildHash === undefined ? {} : { buildHash }),
    ...(seed === undefined ? {} : { seed }),
    ...(trials === undefined ? {} : { trials }),
    ...(retries === undefined ? {} : { retries }),
    ...(concurrency === undefined ? {} : { concurrency }),
    watch,
    ...(initPath === undefined ? {} : { initPath }),
    ...(initTools.length === 0 ? {} : { initTool: initTools }),
    ...(initCustom === undefined ? {} : { initCustom }),
    ...(initSearch === undefined ? {} : { initSearch }),
    ...(initAuthoring === undefined ? {} : { initAuthoring }),
    ...(initInstall ? { initInstall } : {}),
    ...(initAllowAgent ? { initAllowAgent } : {}),
    ...(initStart ? { initStart } : {}),
    json,
    check,
    acceptApache2,
    help,
  };
}

function location(diagnostic: Diagnostic): string {
  if (diagnostic.span === undefined) return "firedrill";
  return `${diagnostic.span.path}:${diagnostic.span.start.line}:${diagnostic.span.start.column}`;
}

function resolveCallbackReceivers(
  parsed: ParsedArguments,
  environment: Readonly<Record<string, string | undefined>>,
): { readonly receivers?: Readonly<Record<string, CallbackReceiver>>; readonly error?: string } {
  const origins = parsed.callbackReceiverOrigins ?? {};
  const secretVariables = parsed.callbackSecretEnvironment ?? {};
  for (const receiverId of Object.keys(secretVariables)) {
    if (origins[receiverId] === undefined) {
      return { error: `--callback-secret-env for ${receiverId} requires a matching --callback-receiver` };
    }
  }
  const receivers: Record<string, CallbackReceiver> = {};
  for (const [receiverId, baseUrl] of Object.entries(origins)) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return { error: `callback receiver ${receiverId} has an invalid origin` };
    }
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return {
        error: `callback receiver ${receiverId} must be a credential-free loopback HTTP origin`,
      };
    }
    const variable = secretVariables[receiverId];
    if (variable === undefined) {
      receivers[receiverId] = { baseUrl: url.origin };
      continue;
    }
    const secret = environment[variable];
    if (secret === undefined || secret.length === 0) {
      return { error: `callback receiver ${receiverId} requires environment variable ${variable}` };
    }
    receivers[receiverId] = { baseUrl: url.origin, secret };
  }
  return Object.keys(receivers).length === 0 ? {} : { receivers: Object.freeze(receivers) };
}

function writeDiagnostics(io: CliIo, diagnostics: readonly Diagnostic[]): void {
  for (const item of diagnostics) {
    io.stderr.write(`${location(item)} ${item.code} ${item.message}\n`);
    if (item.suggestion !== undefined) io.stderr.write(`  ${item.suggestion}\n`);
  }
}

function buildSummary(result: Extract<CompileWorldResult, { status: "success" }>) {
  return {
    buildHash: result.build.manifest.buildHash,
    worldId: result.build.worldIr.world.id,
    engineVersion: result.build.manifest.engineVersion,
    compilerVersion: result.build.manifest.compilerVersion,
    packageLockHash: result.build.manifest.packageLockHash,
    tools: result.build.worldIr.tools.map((tool) => {
      const operations = new Map(tool.operations.map((operation) => [operation.id, operation]));
      return {
        id: tool.id,
        version: tool.version,
        operations: tool.operations.length,
        httpRoutes: tool.http.map((route) => {
          const operation = operations.get(route.operationId);
          if (operation === undefined) {
            throw new TypeError(`HTTP route ${tool.id}.${route.id} references a missing operation`);
          }
          return {
            id: route.id,
            operationId: route.operationId,
            method: route.method,
            path: route.path,
            auth: route.auth.kind,
            fidelity: operation.fidelity,
          };
        }),
      };
    }),
    scenarios: result.build.worldIr.scenarios.map((scenario) => scenario.id),
    drills: result.build.worldIr.drills.map((drill) => drill.id),
    drillDetails: result.build.worldIr.drills.map((drill) => ({
      id: drill.id,
      ...(drill.title === undefined ? {} : { title: drill.title }),
      targetId: drill.targetId,
      scenario: drill.scenarioId ?? "inline",
      tags: drill.tags,
      trials: drill.trials.count,
      classification: drill.trials.classification,
    })),
    suites: result.build.worldIr.suites.map((suite) => suite.id),
    suiteDetails: result.build.worldIr.suites.map((suite) => ({
      id: suite.id,
      ...(suite.title === undefined ? {} : { title: suite.title }),
      drills: suite.drills,
      tags: suite.tags,
      trials: suite.trials,
      retries: suite.retries,
      concurrency: suite.concurrency,
    })),
    targets: result.build.worldIr.targets.map((target) => target.id),
    provenance: result.build.sourceProvenance,
    ...(result.build.buildDirectory === undefined ? {} : { buildDirectory: result.build.buildDirectory }),
  };
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLine(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function parsedCommandName(parsed: ParsedArguments): string {
  if (parsed.command === "tool") {
    return parsed.toolCommand === undefined ? "tool" : `tool.${parsed.toolCommand}`;
  }
  if (parsed.command === "report") {
    return parsed.reportCommand === undefined ? "report" : `report.${parsed.reportCommand}`;
  }
  if (parsed.command === "world") {
    return parsed.worldCommand === undefined ? "world" : `world.${parsed.worldCommand}`;
  }
  return parsed.command ?? "run";
}

function writeUsageFailure(parsed: ParsedArguments, io: CliIo, message: string): number {
  if (parsed.json) {
    writeJson(io, {
      schemaVersion: 1,
      command: parsedCommandName(parsed),
      status: "failed",
      code: "framework.INVALID_ARGUMENT",
      message,
    });
  } else {
    io.stderr.write(`${message}\n`);
  }
  return 2;
}

async function compileCommand(
  command: "build" | "plan" | "validate",
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number> {
  const result = await compileWorld({
    repositoryRoot: parsed.root,
    materialize: command === "build",
  });
  if (result.status === "failed") {
    if (parsed.json) {
      writeJson(io, { schemaVersion: 1, command, status: "failed", diagnostics: result.diagnostics });
    } else writeDiagnostics(io, result.diagnostics);
    return 1;
  }

  if (command === "build") {
    if (result.build.buildDirectory === undefined) throw new Error("compiler returned no build directory");
    const loaded = await loadWorldBuild(result.build.buildDirectory);
    if (loaded.status === "failed") {
      if (parsed.json) {
        writeJson(io, { schemaVersion: 1, command, status: "failed", diagnostics: loaded.diagnostics });
      } else writeDiagnostics(io, loaded.diagnostics);
      return 1;
    }
  }

  const summary = buildSummary(result);
  if (parsed.json) {
    writeJson(io, {
      schemaVersion: 1,
      command,
      status: "success",
      diagnostics: result.diagnostics,
      ...summary,
      ...(command === "validate" && summary.drills.length > 0
        ? {
            next: {
              command: "firedrill run",
              local: true,
              accountRequired: false,
            },
          }
        : {}),
    });
    return 0;
  }
  if (result.diagnostics.length > 0) writeDiagnostics(io, result.diagnostics);
  if (command === "validate") {
    io.stdout.write(
      `World valid — ${summary.tools.length} Tool${summary.tools.length === 1 ? "" : "s"}, ${summary.scenarios.length} scenario${summary.scenarios.length === 1 ? "" : "s"}, ${summary.drills.length} drill${summary.drills.length === 1 ? "" : "s"}.\n`,
    );
    if (summary.drills.length > 0) {
      io.stdout.write("Run your first drill: firedrill run (local, no account).\n");
    }
  } else if (command === "plan") {
    io.stdout.write(`World ${summary.worldId}\nBuild ${summary.buildHash}\n`);
    for (const tool of summary.tools) {
      io.stdout.write(
        `Tool ${tool.id}@${tool.version} — ${tool.operations} operation${tool.operations === 1 ? "" : "s"}; ${tool.httpRoutes.length} HTTP route${tool.httpRoutes.length === 1 ? "" : "s"}\n`,
      );
      for (const route of tool.httpRoutes) {
        io.stdout.write(`  HTTP ${route.method} ${route.path} → ${route.operationId}\n`);
      }
    }
    io.stdout.write(
      `${summary.scenarios.length} scenario${summary.scenarios.length === 1 ? "" : "s"}; ${summary.drills.length} drill${summary.drills.length === 1 ? "" : "s"}; ${summary.targets.length} target${summary.targets.length === 1 ? "" : "s"}\n`,
    );
    for (const drill of summary.drillDetails) {
      const label = drill.title === undefined ? drill.id : `${drill.id} — ${drill.title}`;
      const tags = drill.tags.length === 0 ? "" : `; tags ${drill.tags.join(", ")}`;
      io.stdout.write(
        `Drill ${label}\n  target ${drill.targetId}; scenario ${drill.scenario}; ${drill.trials} trial${drill.trials === 1 ? "" : "s"}; ${drill.classification}${tags}\n`,
      );
    }
    for (const suite of summary.suiteDetails) {
      const label = suite.title === undefined ? suite.id : `${suite.id} — ${suite.title}`;
      const selection = [
        suite.drills.length === 0
          ? undefined
          : `${suite.drills.length} explicit drill${suite.drills.length === 1 ? "" : "s"}`,
        suite.tags.length === 0 ? undefined : `${suite.tags.length} tag${suite.tags.length === 1 ? "" : "s"}`,
      ]
        .filter((item): item is string => item !== undefined)
        .join("; ");
      io.stdout.write(
        `Suite ${label}\n  ${selection.length === 0 ? "all drills" : selection}; concurrency ${suite.concurrency}; retries ${suite.retries}\n`,
      );
    }
  } else {
    io.stdout.write(`Built and verified ${summary.worldId}\n${summary.buildDirectory}\n`);
  }
  return 0;
}

async function formatCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const result = await formatWorldSources({ repositoryRoot: parsed.root, check: parsed.check });
  if (result.status === "failed") {
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "format",
        status: "failed",
        diagnostics: result.diagnostics,
      });
    } else writeDiagnostics(io, result.diagnostics);
    return 1;
  }
  const changed = result.files.filter((file) => file.changed).map((file) => file.path);
  const status = parsed.check && changed.length > 0 ? "changes_required" : "success";
  if (parsed.json) {
    writeJson(io, { schemaVersion: 1, command: "format", status, changed });
  } else if (changed.length === 0) {
    io.stdout.write("Source is formatted.\n");
  } else if (parsed.check) {
    for (const path of changed) io.stderr.write(`${path} needs formatting\n`);
  } else {
    for (const path of changed) io.stdout.write(`Formatted ${path}\n`);
  }
  return status === "success" ? 0 : 1;
}

function writeToolInspection(io: CliIo, inspection: ToolInspection): void {
  if (inspection.diagnostics.length > 0) writeDiagnostics(io, inspection.diagnostics);
  const manifest = inspection.manifest;
  io.stdout.write(`Tool ${manifest.id}@${manifest.version}\n`);
  const source =
    inspection.origin.kind === "repository"
      ? `Source ${inspection.sourcePath}`
      : inspection.origin.kind === "npm"
        ? `Installed package ${inspection.origin.packageName}@${inspection.origin.packageVersion}`
        : `Temporary behavior override ${inspection.origin.module}`;
  io.stdout.write(`${source}\n`);
  io.stdout.write(`Artifact ${inspection.artifact.artifactHash}\n`);
  io.stdout.write(
    `${manifest.operations.length} operation${manifest.operations.length === 1 ? "" : "s"}; ${manifest.http.length} HTTP route${manifest.http.length === 1 ? "" : "s"}; ${manifest.state.length} state namespace${manifest.state.length === 1 ? "" : "s"}; ${manifest.events.length} event${manifest.events.length === 1 ? "" : "s"}; ${manifest.callbacks.length} callback${manifest.callbacks.length === 1 ? "" : "s"}; ${manifest.faults.length} fault${manifest.faults.length === 1 ? "" : "s"}; ${manifest.subscriptions.length} subscription${manifest.subscriptions.length === 1 ? "" : "s"}\n`,
  );
  for (const operation of manifest.operations) {
    io.stdout.write(`  ${operation.id} — ${operation.fidelity}\n`);
  }
  for (const route of manifest.http) {
    const fidelity = manifest.operations.find((operation) => operation.id === route.operationId)?.fidelity;
    io.stdout.write(
      `  HTTP ${route.method} ${route.path} → ${route.operationId}${fidelity === undefined ? "" : ` — ${fidelity}`}\n`,
    );
  }
  for (const profile of manifest.compatibility) {
    io.stdout.write(
      `Compatibility ${profile.id}: ${profile.client.name}@${profile.client.version} via ${profile.configuration.endpoint} + ${profile.configuration.credential}\n`,
    );
    for (const route of profile.routes) {
      io.stdout.write(`  ${route.clientMethod} → ${route.routeId}\n`);
    }
    for (const flow of profile.flows) {
      io.stdout.write(`  Flow ${flow.id} — ${flow.description}\n`);
    }
    for (const limitation of profile.limitations) {
      io.stdout.write(`  Limitation — ${limitation}\n`);
    }
  }
}

function summarizedConformance(result: ToolConformanceResult) {
  return {
    schemaVersion: 1,
    command: "tool.test",
    status: result.status,
    tool: result.tool,
    suiteId: result.suiteId,
    suiteSource: result.suiteSource,
    deterministic: result.deterministic,
    coverage: result.coverage,
    violations: result.violations,
    runs: result.runs.map((run) => ({
      verdict: run.verdict,
      buildHash: run.buildHash,
      drills: run.drills.map((drill) => ({
        drillId: drill.drillId,
        verdict: drill.verdict,
        trials: drill.trials.map((trial) => ({
          trial: trial.trial,
          seed: trial.seed,
          status: trial.result.status,
          ...(trial.result.status === "sealed"
            ? {
                stateHash: trial.result.stateHash,
                trajectoryHash: trial.result.trajectoryHash,
              }
            : {}),
          htmlReport: trial.report.files.html,
          jsonReport: trial.report.files.json,
          junitReport: trial.report.files.junit,
        })),
      })),
    })),
  };
}

function writeToolConformance(io: CliIo, result: ToolConformanceResult): void {
  io.stdout.write(`Tool ${result.tool.toolId} conformance ${result.status} — suite ${result.suiteId}\n`);
  io.stdout.write(
    `Suite source: ${result.suiteSource === "package" ? "installed package" : "consumer repository"}\n`,
  );
  io.stdout.write(`Reproducible with identical seed: ${result.deterministic ? "yes" : "no"}\n`);
  const covered = result.coverage.operations.filter(
    (operation) => operation.attempts > 0 && operation.statuses.ok > 0,
  ).length;
  io.stdout.write(`Operations covered successfully: ${covered}/${result.coverage.operations.length}\n`);
  for (const violation of result.violations) {
    io.stderr.write(`${violation.code} ${violation.message}\n`);
  }
  for (const [index, run] of result.runs.entries()) {
    for (const drill of run.drills) {
      for (const trial of drill.trials) {
        io.stdout.write(
          `Pass ${index + 1} · ${drill.drillId} · trial ${trial.trial}: ${trial.report.files.html}\n`,
        );
      }
    }
  }
}

async function toolCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  if (
    parsed.toolCommand === "search" ||
    (parsed.toolCommand === "create" && parsed.toolPackage) ||
    (parsed.toolCommand === "add" && parsed.initInstall)
  )
    return executeToolDistributionCommand(parsed, io);
  if (parsed.toolCommand === undefined || parsed.toolId === undefined) {
    return writeUsageFailure(
      parsed,
      io,
      "tool requires create, inspect, validate, test, or contribute followed by <tool-id>, or add <installed-package>",
    );
  }
  try {
    if (parsed.toolCommand === "create" || parsed.toolCommand === "add") {
      const setup =
        parsed.toolCommand === "create"
          ? createTool({
              root: parsed.root,
              id: parsed.toolId,
              ...(parsed.toolTemplate === undefined ? {} : { template: parsed.toolTemplate }),
            })
          : addToolPackage({ root: parsed.root, packageName: parsed.toolId });
      if (parsed.json)
        writeJson(io, { schemaVersion: 1, command: `tool.${parsed.toolCommand}`, status: "success", setup });
      else {
        io.stdout.write(
          `Tool ${setup.packageId} ${parsed.toolCommand === "create" ? "created" : "selected"}\n`,
        );
        for (const path of setup.created) io.stdout.write(`Created ${path}\n`);
        for (const path of setup.updated) io.stdout.write(`Updated ${path}\n`);
        for (const path of setup.unchanged) io.stdout.write(`Unchanged ${path}\n`);
        for (const guidance of setup.grantGuidance) io.stdout.write(`${guidance}\n`);
        io.stdout.write("No agent or tests were executed. Start the backend with firedrill serve.\n");
      }
      return 0;
    }
    if (parsed.toolCommand === "inspect") {
      const result = await inspectTool({ root: parsed.root, toolId: parsed.toolId });
      if (parsed.json) {
        writeJson(io, { schemaVersion: 1, command: "tool.inspect", status: "success", tool: result });
      } else writeToolInspection(io, result);
      return 0;
    }
    if (parsed.toolCommand === "validate") {
      const result = await validateTool({ root: parsed.root, toolId: parsed.toolId });
      if (parsed.json) {
        writeJson(io, { schemaVersion: 1, command: "tool.validate", status: "success", tool: result });
      } else {
        writeToolInspection(io, result);
        io.stdout.write(`Executable behavior verified in ${result.buildDirectory}\n`);
      }
      return 0;
    }
    const callbacks = resolveCallbackReceivers(parsed, io.environment ?? process.env);
    if (callbacks.error !== undefined) return writeUsageFailure(parsed, io, callbacks.error);
    if (parsed.toolCommand === "contribute") {
      const result = await prepareToolContribution({
        root: parsed.root,
        toolId: parsed.toolId,
        acceptApache2: parsed.acceptApache2 ?? false,
        ...(parsed.suite === undefined ? {} : { suite: parsed.suite }),
        ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
        ...(parsed.contributionOutput === undefined ? {} : { outputDirectory: parsed.contributionOutput }),
        ...(callbacks.receivers === undefined ? {} : { callbackReceivers: callbacks.receivers }),
        hostEnvironment: io.environment ?? process.env,
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      });
      if (parsed.json) {
        writeJson(io, {
          schemaVersion: 1,
          command: "tool.contribute",
          status: "prepared",
          bundle: result,
        });
      } else {
        io.stdout.write(`Prepared Tool contribution review bundle\n${result.directory}\n`);
        for (const path of result.files) io.stdout.write(`  ${path}\n`);
        io.stdout.write("No source was uploaded and no pull request was opened.\n");
      }
      return 0;
    }
    const result = await testTool({
      root: parsed.root,
      toolId: parsed.toolId,
      ...(parsed.suite === undefined ? {} : { suite: parsed.suite }),
      ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
      ...(callbacks.receivers === undefined ? {} : { callbackReceivers: callbacks.receivers }),
      hostEnvironment: io.environment ?? process.env,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    if (parsed.json) writeJson(io, summarizedConformance(result));
    else {
      writeToolConformance(io, result);
      if (result.status === "passed" && result.tool.origin.kind === "repository") {
        io.stdout.write(
          `Prepare this Tool for community review: firedrill tool contribute ${result.tool.toolId} --accept-apache-2.0\n`,
        );
      }
    }
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    if (error instanceof FiredrillToolSetupError) {
      if (parsed.json)
        writeJson(io, {
          schemaVersion: 1,
          command: `tool.${parsed.toolCommand}`,
          status: "failed",
          code: error.code,
          message: error.message,
          paths: error.paths,
        });
      else {
        io.stderr.write(`${error.code} ${error.message}\n`);
        for (const path of error.paths) io.stderr.write(`  ${path}\n`);
      }
      return error.code === "framework.TOOL_SETUP_INVALID_ARGUMENT" ? 2 : 1;
    }
    if (!(error instanceof FiredrillProjectError)) throw error;
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: `tool.${parsed.toolCommand}`,
        status: "failed",
        code: error.code,
        message: error.message,
        details: error.details,
        diagnostics: error.diagnostics,
      });
    } else if (error.diagnostics.length > 0) {
      writeDiagnostics(io, error.diagnostics);
    } else {
      io.stderr.write(`${error.code} ${error.message}\n`);
      const suggestion = error.details.suggestion;
      if (typeof suggestion === "string") io.stderr.write(`  ${suggestion}\n`);
      const available = error.details.available;
      if (Array.isArray(available) && available.length > 0) {
        io.stderr.write(`Available: ${available.join(", ")}\n`);
      }
    }
    return error.code === "framework.INVALID_ARGUMENT" ||
      error.code === "framework.SUITE_NOT_FOUND" ||
      error.code === "framework.TOOL_CONFORMANCE_SUITE_REQUIRED" ||
      error.code === "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED" ||
      error.code === "framework.TOOL_CONTRIBUTION_EXISTS" ||
      error.code === "framework.TOOL_CONTRIBUTION_SOURCE_REQUIRED" ||
      error.code === "framework.TOOL_NOT_FOUND"
      ? 2
      : 1;
  }
}

async function runCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const callbacks = resolveCallbackReceivers(parsed, io.environment ?? process.env);
  if (callbacks.error !== undefined) return writeUsageFailure(parsed, io, callbacks.error);
  try {
    const execution = await runDrills({
      root: parsed.root,
      ...(parsed.drillId === undefined ? {} : { drill: parsed.drillId }),
      ...(parsed.suite === undefined ? {} : { suite: parsed.suite }),
      ...(parsed.tags === undefined || parsed.tags.length === 0 ? {} : { tags: parsed.tags }),
      ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
      ...(parsed.shard === undefined ? {} : { shard: parsed.shard }),
      ...(parsed.trials === undefined ? {} : { trials: parsed.trials }),
      ...(parsed.retries === undefined ? {} : { retries: parsed.retries }),
      ...(parsed.concurrency === undefined ? {} : { concurrency: parsed.concurrency }),
      ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
      ...(parsed.buildHash === undefined ? {} : { buildHash: parsed.buildHash }),
      ...(parsed.reportDirectory === undefined ? {} : { reportDirectory: parsed.reportDirectory }),
      ...(callbacks.receivers === undefined ? {} : { callbackReceivers: callbacks.receivers }),
      hostEnvironment: io.environment ?? process.env,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    if (!parsed.json && execution.diagnostics.length > 0) {
      writeDiagnostics(io, execution.diagnostics);
    }
    const drills = execution.drills.map((drill) => ({
      drillId: drill.drillId,
      verdict: drill.verdict,
      passed: drill.passed,
      failed: drill.failed,
      inconclusive: drill.inconclusive,
      statistics: drill.statistics,
      trials: drill.trials.map((trial) => {
        const attempts = trial.attempts.map((attempt) => {
          if (!parsed.json) {
            io.stdout.write(readFileSync(attempt.report.files.terminal, "utf8"));
            io.stdout.write(`HTML report: ${attempt.report.files.html}\n\n`);
          }
          return {
            result: attempt.result,
            worldFilePath: attempt.worldFilePath,
            reportDirectory: attempt.report.directory,
            htmlReport: attempt.report.files.html,
            jsonReport: attempt.report.files.json,
            junitReport: attempt.report.files.junit,
          };
        });
        return {
          trial: trial.trial,
          seed: trial.seed,
          verdict: trial.verdict,
          result: trial.result,
          worldFilePath: trial.worldFilePath,
          reportDirectory: trial.report.directory,
          htmlReport: trial.report.files.html,
          jsonReport: trial.report.files.json,
          junitReport: trial.report.files.junit,
          attempts,
        };
      }),
    }));
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "run",
        status: "completed",
        verdict: execution.verdict,
        diagnostics: execution.diagnostics,
        buildHash: execution.buildHash,
        selection: execution.selection,
        ...(execution.reportIndex === undefined ? {} : { reportIndex: execution.reportIndex }),
        drills,
      });
    } else if (execution.reportIndex !== undefined) {
      io.stdout.write(`All reports: ${execution.reportIndex}\n`);
    }
    return execution.verdict === "passed" ? 0 : 1;
  } catch (error) {
    if (!(error instanceof FiredrillProjectError)) throw error;
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "run",
        status: "failed",
        code: error.code,
        message: error.message,
        details: error.details,
        diagnostics: error.diagnostics,
      });
    } else if (error.diagnostics.length > 0) {
      writeDiagnostics(io, error.diagnostics);
    } else {
      io.stderr.write(`${error.code} ${error.message}\n`);
      if (error.code === "framework.DRILL_NOT_FOUND" || error.code === "framework.SUITE_NOT_FOUND") {
        const available = error.details.available;
        if (Array.isArray(available) && available.length > 0) {
          io.stderr.write(
            `Available ${error.code === "framework.SUITE_NOT_FOUND" ? "suites" : "drills"}: ${available.join(", ")}\n`,
          );
        }
      }
    }
    return error.code === "framework.DRILL_NOT_FOUND" ||
      error.code === "framework.SUITE_NOT_FOUND" ||
      error.code === "framework.INVALID_ARGUMENT"
      ? 2
      : 1;
  }
}

function verifiedReportSummary(report: VerifiedLocalReport) {
  return {
    directory: report.directory,
    runId: report.manifest.runId,
    runStatus: report.result.status,
    ...(report.result.status === "sealed" ? { verdict: report.result.verdict } : {}),
    drillId: report.manifest.reproduction.drillId,
    targetId: report.manifest.reproduction.targetId,
    buildHash: report.manifest.reproduction.buildHash,
    seed: report.manifest.reproduction.seed,
    redaction: report.manifest.redaction,
    artifacts: report.manifest.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      bytes: artifact.bytes,
      hash: artifact.hash,
    })),
  };
}

function reportCommand(parsed: ParsedArguments, io: CliIo): number {
  if (parsed.reportCommand !== "verify" || parsed.reportPath === undefined) {
    return writeUsageFailure(parsed, io, "report verify requires <report-directory>");
  }
  try {
    const report = verifyReport({ report: parsed.reportPath });
    const summary = verifiedReportSummary(report);
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "report.verify",
        status: "verified",
        ...summary,
      });
    } else {
      const verdict = report.result.status === "sealed" ? ` · ${report.result.verdict}` : "";
      io.stdout.write(`Report verified — ${report.manifest.runId}${verdict}\n`);
      io.stdout.write(
        `Drill ${report.manifest.reproduction.drillId} · build ${report.manifest.reproduction.buildHash} · seed ${report.manifest.reproduction.seed}\n`,
      );
      io.stdout.write(`${report.directory}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof FiredrillProjectError)) throw error;
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "report.verify",
        status: "failed",
        code: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      io.stderr.write(`${error.code} ${error.message}\n`);
    }
    return 1;
  }
}

function captureWriter(): { readonly writer: CliWriter; readonly value: () => string } {
  let value = "";
  return {
    writer: { write: (chunk) => (value += chunk) },
    value: () => value,
  };
}

async function watchCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const cancellation = io.signal ?? new AbortController().signal;
  let lastExitCode = 0;
  if (!parsed.json) {
    io.stdout.write(`Watching ${parsed.root} for changes. Press Ctrl+C to stop.\n\n`);
  }
  try {
    await watchFiles({
      root: parsed.root,
      signal: cancellation,
      ...(parsed.reportDirectory === undefined ? {} : { ignorePaths: [parsed.reportDirectory] }),
      onCycle: async (cycle) => {
        if (parsed.json) {
          const stdout = captureWriter();
          const stderr = captureWriter();
          lastExitCode = await runCommand(parsed, {
            ...io,
            stdout: stdout.writer,
            stderr: stderr.writer,
            signal: cancellation,
          });
          const serialized = stdout.value().trim();
          const result = serialized.length === 0 ? null : (JSON.parse(serialized) as unknown);
          writeJsonLine(io, {
            schemaVersion: 1,
            command: "watch",
            sequence: cycle.sequence,
            trigger: cycle.trigger,
            changedFiles: cycle.changedFiles,
            exitCode: lastExitCode,
            result,
          });
          return;
        }

        if (cycle.trigger === "change") {
          io.stdout.write(`Changed: ${cycle.changedFiles.join(", ")}\n\n`);
        }
        lastExitCode = await runCommand(parsed, io);
        if (!cancellation.aborted) io.stdout.write("Waiting for changes…\n\n");
      },
    });
    return lastExitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "repository watching failed";
    if (parsed.json) {
      writeJsonLine(io, {
        schemaVersion: 1,
        command: "watch",
        status: "failed",
        code: "framework.WATCH_UNAVAILABLE",
        message,
      });
    } else {
      io.stderr.write(`framework.WATCH_UNAVAILABLE ${message}\n`);
    }
    return 1;
  }
}

function comparedVerdict(side: LocalRunComparison["baseline"]): string {
  return side.status === "sealed" ? (side.verdict ?? "inconclusive") : side.status;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function writeComparison(io: CliIo, comparison: LocalRunComparison): void {
  const heading = comparison.compatibility.status.replaceAll("_", " ").toUpperCase();
  io.stdout.write(`${heading} — ${comparison.outcome.replaceAll("_", " ")}\n`);
  io.stdout.write(`${comparison.compatibility.explanation}\n`);
  io.stdout.write(
    `Baseline ${comparedVerdict(comparison.baseline)} (${comparison.baseline.runId}) → candidate ${comparedVerdict(comparison.candidate)} (${comparison.candidate.runId})\n`,
  );
  if (comparison.changes.stateChanged !== undefined) {
    io.stdout.write(`State ${comparison.changes.stateChanged ? "changed" : "unchanged"}\n`);
  }
  if (comparison.changes.trajectoryChanged !== undefined) {
    io.stdout.write(`Trajectory ${comparison.changes.trajectoryChanged ? "changed" : "unchanged"}\n`);
  }
  for (const operation of comparison.changes.operationCounts) {
    io.stdout.write(
      `Tool calls ${operation.subject}: ${operation.baseline} → ${operation.candidate} (${signed(operation.delta)})`,
    );
    if (operation.baselineErrors !== operation.candidateErrors) {
      io.stdout.write(`; errors ${operation.baselineErrors} → ${operation.candidateErrors}`);
    }
    io.stdout.write("\n");
  }
  for (const assertion of comparison.changes.assertions) {
    io.stdout.write(
      `Assertion ${assertion.checkpointId}/${assertion.assertionId}: ${assertion.baseline ?? "missing"} → ${assertion.candidate ?? "missing"}${assertion.actualChanged ? "; actual changed" : ""}\n`,
    );
  }
}

function compareCommand(parsed: ParsedArguments, io: CliIo): number {
  if (parsed.baselineReport === undefined || parsed.candidateReport === undefined) {
    return writeUsageFailure(parsed, io, "compare requires <baseline-report> and <candidate-report>");
  }
  try {
    const comparison = compareRuns({
      baselineReport: parsed.baselineReport,
      candidateReport: parsed.candidateReport,
    });
    if (parsed.json) {
      writeJson(io, { command: "compare", status: "success", ...comparison });
    } else {
      writeComparison(io, comparison);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof FiredrillProjectError)) throw error;
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "compare",
        status: "failed",
        code: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      io.stderr.write(`${error.code} ${error.message}\n`);
    }
    return 1;
  }
}

async function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    if (signal === undefined) return;
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function inspectCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  try {
    const server = await startLocalInspector({
      root: parsed.root,
      ...(parsed.inspectorPort === undefined ? {} : { port: parsed.inspectorPort }),
    });
    try {
      const project = server.supervisor.project();
      if (parsed.json) {
        writeJsonLine(io, {
          schemaVersion: 1,
          command: "inspect",
          status: "ready",
          url: server.url,
          worldId: project.world.id,
          buildHash: project.world.buildHash,
          tools: project.tools.length,
          drills: project.drills.length,
          accountRequired: false,
        });
      } else {
        io.stdout.write(`Inspector ready — ${server.url}\n`);
        io.stdout.write(
          `${project.world.title ?? project.world.id} · ${project.tools.length} Tool${project.tools.length === 1 ? "" : "s"} · ${project.drills.length} drill${project.drills.length === 1 ? "" : "s"}\n`,
        );
      }
      if (!parsed.json && parsed.noOpen !== true && io.openUrl !== undefined) {
        try {
          await io.openUrl(server.url);
        } catch {
          io.stderr.write(`Browser could not be opened. Visit ${server.url}\n`);
        }
      }
      if (!parsed.json) io.stdout.write("Press Ctrl+C to stop.\n");
      await waitForShutdown(io.signal);
      return 0;
    } finally {
      await server.close();
    }
  } catch (error) {
    if (!(error instanceof FiredrillProjectError)) throw error;
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "inspect",
        status: "failed",
        code: error.code,
        message: error.message,
        diagnostics: error.diagnostics,
      });
    } else {
      io.stderr.write(`${error.code} ${error.message}\n`);
      if (error.diagnostics.length > 0) writeDiagnostics(io, error.diagnostics);
    }
    return 1;
  }
}

export async function runCli(arguments_: readonly string[], io: CliIo): Promise<number> {
  if (arguments_[0] === "data") return executeDataCommand(arguments_.slice(1), io);
  if (arguments_[0] === "browser") return executeBrowserCommand(arguments_.slice(1), io);
  if (arguments_[0] === "mcp") return executeMcpCommand(arguments_.slice(1), io);
  if (arguments_[0] === "cloud") {
    return executeCloudCommand(arguments_.slice(1), io);
  }
  const parsed = parseArguments(arguments_, io.cwd);
  try {
    if (parsed.error !== undefined) {
      if (parsed.json) return writeUsageFailure(parsed, io, parsed.error);
      io.stderr.write(`${parsed.error}\n\n${HELP}`);
      return 2;
    }
    if (parsed.help) {
      io.stdout.write(helpFor(parsed));
      return 0;
    }
    const command = parsed.command ?? "run";
    if (parsed.seed !== undefined && !SeedSchema.safeParse(parsed.seed).success) {
      return writeUsageFailure(parsed, io, "--seed must be an unsigned 64-bit integer");
    }
    if (parsed.buildHash !== undefined && !Sha256Schema.safeParse(parsed.buildHash).success) {
      return writeUsageFailure(parsed, io, "--build-hash must be a sha256:<64 lowercase hex> value");
    }
    if (parsed.check && command !== "format") {
      return writeUsageFailure(parsed, io, "--check is only valid with format");
    }
    const toolExecution =
      command === "tool" && (parsed.toolCommand === "test" || parsed.toolCommand === "contribute");
    if (
      command !== "run" &&
      (parsed.trials !== undefined ||
        parsed.retries !== undefined ||
        parsed.concurrency !== undefined ||
        (parsed.tags?.length ?? 0) > 0 ||
        parsed.filter !== undefined ||
        parsed.shard !== undefined ||
        parsed.reportDirectory !== undefined ||
        parsed.buildHash !== undefined)
    ) {
      return writeUsageFailure(
        parsed,
        io,
        "drill selection, retry, concurrency, build, report, and callback options are only valid with run",
      );
    }
    if (
      command !== "run" &&
      !toolExecution &&
      (parsed.suite !== undefined || (parsed.seed !== undefined && command !== "serve"))
    ) {
      return writeUsageFailure(
        parsed,
        io,
        "--suite requires run, tool test, or tool contribute; --seed also supports serve",
      );
    }
    if (
      command !== "run" &&
      !toolExecution &&
      (parsed.callbackReceiverOrigins !== undefined || parsed.callbackSecretEnvironment !== undefined)
    ) {
      return writeUsageFailure(
        parsed,
        io,
        "callback options are only valid with run, tool test, or tool contribute",
      );
    }
    const toolContribution = command === "tool" && parsed.toolCommand === "contribute";
    if (!toolContribution && (parsed.contributionOutput !== undefined || parsed.acceptApache2 === true)) {
      return writeUsageFailure(
        parsed,
        io,
        "--output and --accept-apache-2.0 are only valid with tool contribute",
      );
    }
    const hasInitOptions =
      parsed.initPath !== undefined ||
      parsed.initTool !== undefined ||
      parsed.initCustom !== undefined ||
      parsed.initSearch !== undefined ||
      parsed.initAuthoring !== undefined ||
      (parsed.initInstall && !(command === "tool" && parsed.toolCommand === "add")) ||
      parsed.initAllowAgent ||
      parsed.initStart;
    if (hasInitOptions && command !== "init")
      return writeUsageFailure(parsed, io, "setup options are only valid with init");
    if (
      (parsed.toolPackage || parsed.toolName !== undefined) &&
      !(command === "tool" && parsed.toolCommand === "create" && parsed.toolPackage)
    )
      return writeUsageFailure(parsed, io, "--package and --name are only valid with tool create --package");
    if (
      parsed.toolIndex !== undefined &&
      !(command === "tool" && parsed.toolCommand === "search") &&
      command !== "init"
    )
      return writeUsageFailure(parsed, io, "--index is only valid with tool search or init");
    if (
      (parsed.toolLimit !== undefined || parsed.toolOffset !== undefined) &&
      !(command === "tool" && parsed.toolCommand === "search")
    )
      return writeUsageFailure(parsed, io, "--limit and --offset are only valid with tool search");
    if (command === "init") {
      if (
        parsed.toolIndex !== undefined &&
        (parsed.initPath !== undefined || parsed.initCustom !== undefined)
      )
        return writeUsageFailure(
          parsed,
          io,
          "--index applies to Tool selection or search, not --path or --custom",
        );
      if (
        [parsed.initPath, parsed.initTool, parsed.initCustom, parsed.initSearch].filter(
          (value) => value !== undefined,
        ).length > 1
      )
        return writeUsageFailure(parsed, io, "Choose only one of --path, --tool, --custom, or --search");
      if (
        parsed.initSearch !== undefined &&
        (parsed.initInstall ||
          parsed.initStart ||
          parsed.initAllowAgent ||
          parsed.initAuthoring !== undefined)
      )
        return writeUsageFailure(
          parsed,
          io,
          "--search is read-only and cannot be combined with installation, authoring, or start options",
        );
      if (parsed.initInstall && parsed.initTool === undefined)
        return writeUsageFailure(parsed, io, "--install requires --tool");
      if (
        parsed.initAllowAgent &&
        parsed.initPath !== "firedrill-agent" &&
        parsed.initAuthoring !== "firedrill-agent"
      )
        return writeUsageFailure(
          parsed,
          io,
          "--allow-agent requires --authoring firedrill-agent or --path firedrill-agent",
        );
      if (
        (parsed.initAuthoring !== undefined || parsed.initStart) &&
        parsed.initPath === undefined &&
        parsed.initTool === undefined &&
        parsed.initCustom === undefined
      )
        return writeUsageFailure(
          parsed,
          io,
          "--authoring and --start require an explicit --tool, --custom, or --path",
        );
      if (parsed.initAuthoring !== undefined && parsed.initPath !== undefined)
        return writeUsageFailure(parsed, io, "--authoring cannot be combined with legacy --path");
    }
    if (parsed.toolTemplate !== undefined && (command !== "tool" || parsed.toolCommand !== "create"))
      return writeUsageFailure(parsed, io, "--template is only valid with tool create");
    if (parsed.inspectorPort !== undefined && command !== "inspect" && command !== "serve") {
      return writeUsageFailure(parsed, io, "--port is only valid with inspect or serve");
    }
    if (
      command !== "serve" &&
      (parsed.scenarioId !== undefined ||
        (parsed.actorId !== undefined && !(command === "init" && parsed.initStart)) ||
        parsed.mcpPort !== undefined ||
        parsed.cliPort !== undefined)
    )
      return writeUsageFailure(
        parsed,
        io,
        "--scenario, --actor, --mcp-port, and --cli-port are only valid with serve",
      );
    if (parsed.noOpen === true && command !== "inspect" && command !== "serve" && command !== "init") {
      return writeUsageFailure(parsed, io, "--no-open is only valid with inspect, serve, or init");
    }
    if (
      command !== "agent" &&
      (parsed.agentWorkflow !== undefined ||
        parsed.agentPrompt !== undefined ||
        parsed.agentModel !== undefined ||
        parsed.agentEffort !== undefined ||
        parsed.agentMaxTurns !== undefined ||
        parsed.agentMaxBudgetUsd !== undefined ||
        parsed.agentTimeoutMs !== undefined)
    ) {
      return writeUsageFailure(
        parsed,
        io,
        "--prompt, --model, --effort, --max-turns, --max-budget-usd, and --timeout-ms are only valid with agent",
      );
    }
    if (command !== "world" && (parsed.operationInput !== undefined || parsed.idempotencyKey !== undefined)) {
      return writeUsageFailure(parsed, io, "--input and --idempotency-key are only valid with world call");
    }
    if (
      command === "world" &&
      parsed.worldCommand !== "call" &&
      (parsed.operationInput !== undefined || parsed.idempotencyKey !== undefined)
    ) {
      return writeUsageFailure(parsed, io, "--input and --idempotency-key require world call");
    }
    if (parsed.watch && command !== "run") {
      return writeUsageFailure(parsed, io, "--watch is only valid with run");
    }
    if (parsed.watch && parsed.buildHash !== undefined) {
      return writeUsageFailure(
        parsed,
        io,
        "--watch cannot be combined with --build-hash because immutable builds do not change",
      );
    }
    if (command === "agent") return executeAgentCommand(parsed, io);
    if (command === "inspect") return inspectCommand(parsed, io);
    if (command === "serve")
      return executeServeCommand(
        {
          root: parsed.root,
          ...(parsed.scenarioId === undefined ? {} : { scenario: parsed.scenarioId }),
          ...(parsed.actorId === undefined ? {} : { actorId: parsed.actorId }),
          ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
          ...(parsed.inspectorPort === undefined ? {} : { httpPort: parsed.inspectorPort }),
          ...(parsed.mcpPort === undefined ? {} : { mcpPort: parsed.mcpPort }),
          ...(parsed.cliPort === undefined ? {} : { cliPort: parsed.cliPort }),
          ...(parsed.noOpen === undefined ? {} : { noOpen: parsed.noOpen }),
          json: parsed.json,
        },
        io,
      );
    if (command === "format") return formatCommand(parsed, io);
    if (command === "run") return parsed.watch ? watchCommand(parsed, io) : runCommand(parsed, io);
    if (command === "report") return reportCommand(parsed, io);
    if (command === "tool") return toolCommand(parsed, io);
    if (command === "world") {
      return executeWorldCommand(
        {
          ...(parsed.worldCommand === undefined ? {} : { command: parsed.worldCommand }),
          ...(parsed.worldToolId === undefined ? {} : { packageId: parsed.worldToolId }),
          ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
          ...(parsed.operationInput === undefined ? {} : { input: parsed.operationInput }),
          ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }),
          json: parsed.json,
        },
        {
          stdout: io.stdout,
          stderr: io.stderr,
          ...(io.environment === undefined ? {} : { environment: io.environment }),
          ...(io.signal === undefined ? {} : { signal: io.signal }),
        },
      );
    }
    if (command === "compare") return compareCommand(parsed, io);
    if (command === "init") return executeInitCommand(parsed, io);
    return compileCommand(command, parsed, io);
  } catch {
    const message = "Firedrill failed internally. No report was produced.";
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: parsedCommandName(parsed),
        status: "failed",
        code: "framework.INTERNAL_ERROR",
        message,
      });
    } else {
      io.stderr.write(`${message}\n`);
    }
    return 1;
  }
}
