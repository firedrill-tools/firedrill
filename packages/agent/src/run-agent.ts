import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { FIREDRILL_FRAMEWORK_VERSION } from "@firedrill-tools/contracts";
import { checkFiredrillEnvironment, type FiredrillEnvironmentCheck } from "./environment-check.js";
import { createFiredrillAuthoringServer, type FiredrillAuthoringPolicy } from "./firedrill-tools.js";
import { repositoryGuardHook } from "./repository-policy.js";

export type FiredrillAgentEffort = Extract<EffortLevel, "low" | "medium" | "high" | "xhigh" | "max">;

export type FiredrillAgentEvent =
  | { readonly type: "session"; readonly sessionId: string; readonly model: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string }
  | { readonly type: "diagnostic"; readonly message: string };

export interface RunFiredrillAgentOptions extends FiredrillAuthoringPolicy {
  /** Default: prepare usable synthetic tools. Drills are an explicit later task. */
  readonly workflow?: "environment" | "drill";
  readonly root?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly effort?: FiredrillAgentEffort;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: FiredrillAgentEvent) => void;
}

export interface FiredrillAgentResult {
  readonly schemaVersion: 1;
  readonly status: "completed" | "failed";
  readonly sessionId?: string;
  readonly model?: string;
  readonly turns: number;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly result?: string;
  readonly errors: readonly string[];
  readonly readiness?: FiredrillEnvironmentCheck;
}

export class FiredrillAgentError extends Error {
  readonly code:
    | "agent.API_KEY_MISSING"
    | "agent.INVALID_REPOSITORY"
    | "agent.INVALID_OPTIONS"
    | "agent.CANCELLED"
    | "agent.TIMEOUT"
    | "agent.EXECUTION_FAILED";

  constructor(code: FiredrillAgentError["code"], message: string) {
    super(message);
    this.name = "FiredrillAgentError";
    this.code = code;
  }
}

function skillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(moduleDirectory, "skill");
  if (existsSync(bundled)) return bundled;
  const source = resolve(moduleDirectory, "../../../skills/firedrill");
  if (existsSync(source)) return source;
  throw new FiredrillAgentError("agent.EXECUTION_FAILED", "the canonical Firedrill skill is missing");
}

function canonicalInstructions(allowRepositoryExecution: boolean, workflow: "environment" | "drill"): string {
  const directory = skillDirectory();
  const skill = readFileSync(resolve(directory, "SKILL.md"), "utf8");
  const authoring = readFileSync(resolve(directory, "references/authoring.md"), "utf8");
  const bindings = readFileSync(resolve(directory, "references/bindings.md"), "utf8");
  const backend = readFileSync(resolve(directory, "references/backend.md"), "utf8");
  return [
    "You are Firedrill Agent, the optional local authoring assistant for the open-source Firedrill framework.",
    "The following canonical skill and references are authoritative for your task.",
    "Read .agents/firedrill/BRIEF.md when it exists; it contains a bounded detector result, not proven facts.",
    "Use the in-process firedrill MCP tools for bounded repository discovery, search, formatting, validation, planning, Tool checks, and drills; Bash and generic search tools are intentionally unavailable.",
    "Never read or write secrets, .git, .firedrill, node_modules, or files outside the repository. Never commit, push, publish, upload, or call a hosted Firedrill service.",
    "The framework's compiler, runner, assertions, and report verifier—not your prose—decide whether work passes.",
    workflow === "environment"
      ? "This is the synthetic-backend workflow. Prepare the tools, deterministic behavior, starting data and explicit actor access. Do not require targets, scenarios or drills. Use environment_check to verify startup; then report how to start the environment and connect the existing agent. Never call backend startup an agent test."
      : "This is the drill workflow. Follow the skill's drill definition of done; runtime setup alone is insufficient.",
    "When a real target cannot be exercised (for example, caller-owned external execution), explain the exact remaining caller action instead of fabricating evidence.",
    "\n--- CANONICAL SKILL ---\n",
    skill,
    "\n--- AUTHORING REFERENCE ---\n",
    authoring,
    "\n--- BINDING REFERENCE ---\n",
    bindings,
    "\n--- BACKEND REFERENCE ---\n",
    backend,
    ...(allowRepositoryExecution
      ? []
      : [
          "\n--- THIS SESSION'S EXECUTION POLICY ---\n",
          "Repository execution is disabled for this authoring session. Author and compile source only. Do not run drills, Tool validation/conformance, or customer agent code; those tools are unavailable. Treat any skill execution steps as handoff instructions for the repository owner. Report what was compiled and what still needs execution, never claim a runtime result.",
        ]),
  ].join("\n");
}

function defaultPrompt(allowRepositoryExecution: boolean, workflow: "environment" | "drill"): string {
  if (workflow === "environment") {
    return [
      "Inspect this repository's actual dependencies and prepare a useful synthetic backend for its existing agent.",
      "Reuse compatible selected tools; otherwise author repository-owned tool contracts, behavior and starting data matching the actual interface. Preserve production agent code.",
      allowRepositoryExecution
        ? "Format, validate and use environment_check to verify local startup. Exercise supported operations only with appropriate inputs. Finish with firedrill serve and the precise existing connection seam."
        : "Format and validate source without executing repository code. Finish with the exact local startup and connection instructions, marked unverified.",
      "Do not invent drills or scenarios to satisfy a checklist. Tools ready does not mean the customer's agent has been tested.",
    ].join(" ");
  }
  return [
    "Set up or repair Firedrill in this repository and carry the canonical skill to its definition of done.",
    "Start by inspecting the actual product agent, its normal entry point, and the smallest tool/client composition seam.",
    allowRepositoryExecution
      ? "Author one useful domain-neutral vertical slice first, iterate machine-readable Firedrill diagnostics to green, then run the smallest real binding canary."
      : "Author one useful domain-neutral vertical slice first, iterate source-only compiler diagnostics to green, and hand off exact execution instructions without running repository code.",
    "Preserve the product agent's normal behavior. Do not stop at plans or generated files, and do not claim checks you could not execute.",
  ].join(" ");
}

function agentEnvironment(environment: Readonly<Record<string, string | undefined>>, runtimeHome: string) {
  if (environment.ANTHROPIC_BASE_URL !== undefined) {
    try {
      const value = environment.ANTHROPIC_BASE_URL;
      const parsed = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (
        value.length > 8_192 ||
        /[\r\n\0]/.test(value) ||
        !(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("invalid API origin");
    } catch {
      throw new FiredrillAgentError(
        "agent.INVALID_OPTIONS",
        "ANTHROPIC_BASE_URL must be an HTTPS or loopback HTTP URL without credentials, query, or fragment",
      );
    }
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
    const value = environment[name];
    if (value === undefined || value === "") continue;
    try {
      const parsed = new URL(value);
      if (value.length > 8_192 || /[\r\n\0]/.test(value) || !["http:", "https:"].includes(parsed.protocol))
        throw new Error("invalid proxy");
    } catch {
      throw new FiredrillAgentError("agent.INVALID_OPTIONS", `${name} must be an HTTP or HTTPS proxy URL`);
    }
  }
  if (
    environment.NO_PROXY !== undefined &&
    (environment.NO_PROXY.length > 8_192 || /[\r\n\0]/.test(environment.NO_PROXY))
  ) {
    throw new FiredrillAgentError("agent.INVALID_OPTIONS", "NO_PROXY is invalid");
  }
  if (environment.NODE_USE_ENV_PROXY !== undefined && !["0", "1"].includes(environment.NODE_USE_ENV_PROXY)) {
    throw new FiredrillAgentError("agent.INVALID_OPTIONS", "NODE_USE_ENV_PROXY must be 0 or 1");
  }
  const allowed = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
  ] as const;
  return Object.fromEntries([
    ...allowed.flatMap((name) =>
      environment[name] === undefined ? [] : ([[name, environment[name]]] as const),
    ),
    ["HOME", runtimeHome],
    ["XDG_CONFIG_HOME", resolve(runtimeHome, "config")],
    ["CLAUDE_CONFIG_DIR", resolve(runtimeHome, ".claude")],
    ["CLAUDE_AGENT_SDK_CLIENT_APP", `firedrill-agent/${FIREDRILL_FRAMEWORK_VERSION}`],
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    ["DISABLE_TELEMETRY", "1"],
    ["DISABLE_ERROR_REPORTING", "1"],
  ]);
}

function assistantContent(message: SDKMessage): readonly FiredrillAgentEvent[] {
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return [];
  return message.message.content.flatMap((block): readonly FiredrillAgentEvent[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "tool_use") return [{ type: "tool", name: block.name }];
    return [];
  });
}

function validatedOptions(options: RunFiredrillAgentOptions) {
  if (options.workflow !== undefined && !["environment", "drill"].includes(options.workflow)) {
    throw new FiredrillAgentError("agent.INVALID_OPTIONS", "workflow must be environment or drill");
  }
  if (
    options.allowRepositoryExecution !== undefined &&
    typeof options.allowRepositoryExecution !== "boolean"
  ) {
    throw new FiredrillAgentError("agent.INVALID_OPTIONS", "allowRepositoryExecution must be a boolean");
  }
  const root = resolve(options.root ?? process.cwd());
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new FiredrillAgentError("agent.INVALID_REPOSITORY", `repository does not exist: ${root}`);
  }
  const canonicalRoot = realpathSync(root);
  const maxTurns = options.maxTurns ?? 40;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) {
    throw new FiredrillAgentError("agent.INVALID_OPTIONS", "maxTurns must be an integer from 1 through 200");
  }
  const maxBudgetUsd = options.maxBudgetUsd ?? 2;
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 1_000) {
    throw new FiredrillAgentError(
      "agent.INVALID_OPTIONS",
      "maxBudgetUsd must be greater than 0 and at most 1000",
    );
  }
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2 * 60 * 60 * 1_000) {
    throw new FiredrillAgentError(
      "agent.INVALID_OPTIONS",
      "timeoutMs must be an integer from 1000 through 7200000",
    );
  }
  return { root: canonicalRoot, maxTurns, maxBudgetUsd, timeoutMs };
}

export async function runFiredrillAgent(
  options: RunFiredrillAgentOptions = {},
): Promise<FiredrillAgentResult> {
  const validated = validatedOptions(options);
  const environment = options.environment ?? process.env;
  if (!environment.ANTHROPIC_API_KEY) {
    throw new FiredrillAgentError(
      "agent.API_KEY_MISSING",
      "ANTHROPIC_API_KEY is not set. Export your Anthropic API key, then run firedrill agent again.",
    );
  }
  if (options.signal?.aborted) {
    throw new FiredrillAgentError("agent.CANCELLED", "Firedrill Agent was cancelled before it started");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const runtimeHome = mkdtempSync(resolve(tmpdir(), "firedrill-agent-home-"));
  mkdirSync(resolve(runtimeHome, "config"));
  mkdirSync(resolve(runtimeHome, ".claude"));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Firedrill Agent exceeded its wall-clock deadline"));
  }, validated.timeoutMs);
  timeout.unref();

  let sessionId: string | undefined;
  let model: string | undefined;
  let result: FiredrillAgentResult | undefined;
  const allowRepositoryExecution = options.allowRepositoryExecution !== false;
  const workflow = options.workflow ?? "environment";
  const server = createFiredrillAuthoringServer(validated.root, { allowRepositoryExecution });
  try {
    const stream = query({
      prompt: options.prompt?.trim() || defaultPrompt(allowRepositoryExecution, workflow),
      options: {
        abortController: controller,
        cwd: validated.root,
        env: agentEnvironment(environment, runtimeHome),
        model: options.model ?? "sonnet",
        effort: options.effort ?? "high",
        maxTurns: validated.maxTurns,
        maxBudgetUsd: validated.maxBudgetUsd,
        tools: ["Read", "Edit", "Write"],
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "mcp__firedrill__repository_files",
          "mcp__firedrill__repository_search",
          "mcp__firedrill__validate",
          "mcp__firedrill__format",
          "mcp__firedrill__plan",
          "mcp__firedrill__environment_check",
          ...(allowRepositoryExecution ? ["mcp__firedrill__run"] : []),
          "mcp__firedrill__tool_check",
        ],
        disallowedTools: [
          "Bash",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
          "Agent",
          "Task",
          ...(allowRepositoryExecution ? [] : ["mcp__firedrill__run"]),
        ],
        permissionMode: "acceptEdits",
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        mcpServers: { firedrill: server },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: canonicalInstructions(allowRepositoryExecution, workflow),
        },
        hooks: {
          PreToolUse: [{ hooks: [repositoryGuardHook(validated.root)] }],
        },
      },
    });
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        model = message.model;
        options.onEvent?.({ type: "session", sessionId, model });
      }
      for (const event of assistantContent(message)) options.onEvent?.(event);
      if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          result = {
            schemaVersion: 1,
            status: message.is_error ? "failed" : "completed",
            sessionId,
            ...(model === undefined ? {} : { model }),
            turns: message.num_turns,
            durationMs: message.duration_ms,
            estimatedCostUsd: message.total_cost_usd,
            result: message.result,
            errors: message.is_error ? [message.result] : [],
          };
        } else {
          result = {
            schemaVersion: 1,
            status: "failed",
            sessionId,
            ...(model === undefined ? {} : { model }),
            turns: message.num_turns,
            durationMs: message.duration_ms,
            estimatedCostUsd: message.total_cost_usd,
            errors: message.errors,
          };
        }
      }
    }
    if (result?.status === "completed" && workflow === "environment" && !controller.signal.aborted) {
      const readiness = await checkFiredrillEnvironment(validated.root, allowRepositoryExecution);
      result = {
        ...result,
        readiness,
        status: readiness.status === "failed" ? "failed" : "completed",
        errors:
          readiness.status === "failed" ? readiness.diagnostics.map((item) => item.message) : result.errors,
      };
    }
  } catch (error) {
    if (error instanceof FiredrillAgentError) throw error;
    if (timedOut) {
      throw new FiredrillAgentError(
        "agent.TIMEOUT",
        `Firedrill Agent exceeded its ${validated.timeoutMs} ms deadline`,
      );
    }
    if (options.signal?.aborted) {
      throw new FiredrillAgentError("agent.CANCELLED", "Firedrill Agent was cancelled");
    }
    throw new FiredrillAgentError(
      "agent.EXECUTION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      rmSync(runtimeHome, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
    } catch {
      options.onEvent?.({
        type: "diagnostic",
        message: "Firedrill Agent could not remove its temporary SDK configuration directory",
      });
    }
  }
  // Cancellation and the wall deadline own the terminal outcome even if an
  // SDK stream races and emits a final result after its abort signal fires.
  if (timedOut) {
    throw new FiredrillAgentError(
      "agent.TIMEOUT",
      `Firedrill Agent exceeded its ${validated.timeoutMs} ms deadline`,
    );
  }
  if (options.signal?.aborted) {
    throw new FiredrillAgentError("agent.CANCELLED", "Firedrill Agent was cancelled");
  }
  if (result === undefined) {
    throw new FiredrillAgentError("agent.EXECUTION_FAILED", "Claude Agent SDK ended without a result");
  }
  return result;
}
