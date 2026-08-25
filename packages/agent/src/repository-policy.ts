import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

const FILE_TOOLS = new Set(["Read", "Edit", "Write"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const BLOCKED_SEGMENTS = new Set([".firedrill", ".git", ".ssh", ".aws", "node_modules"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.(?:netrc|npmrc|pypirc|yarnrc)$/i,
  /^(?:id_rsa|id_ed25519)$/i,
  /^(?:credentials|secrets?)(?:\..+)?$/i,
  /\.(?:key|p12|pfx|pem)$/i,
] as const;

export interface RepositoryAccessDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function resolvedDestination(path: string): string {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  return resolve(realExisting, relative(existing, path));
}

export function isRestrictedRepositoryPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment, index) => {
    const normalized = segment.toLowerCase();
    if (BLOCKED_SEGMENTS.has(normalized)) return true;
    if (normalized === ".config" && segments[index + 1]?.toLowerCase() === "gcloud") return true;
    return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

export function authorizeRepositoryTool(
  repositoryRoot: string,
  toolName: string,
  input: Record<string, unknown>,
): RepositoryAccessDecision {
  const root = realpathSync(resolve(repositoryRoot));
  if (!FILE_TOOLS.has(toolName) && !SEARCH_TOOLS.has(toolName)) return { allowed: true };
  if (SEARCH_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: "use Firedrill's repository_files or repository_search Tool for bounded secret-safe discovery",
    };
  }
  const requested = typeof input.file_path === "string" ? input.file_path : undefined;
  if (requested === undefined) {
    return { allowed: false, reason: `${toolName} requires a repository file path` };
  }
  const absolute = resolve(root, requested);
  const destination = resolvedDestination(absolute);
  if (!contained(root, destination)) {
    return { allowed: false, reason: "Firedrill Agent cannot access files outside the repository" };
  }
  const repositoryPath = relative(root, destination).split(sep).join("/");
  if (isRestrictedRepositoryPath(repositoryPath)) {
    return {
      allowed: false,
      reason:
        "Firedrill Agent cannot read or write secrets, generated evidence, Git metadata, or dependencies",
    };
  }
  return { allowed: true };
}

export function repositoryGuardHook(repositoryRoot: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const toolInput = (input as PreToolUseHookInput).tool_input;
    const parsedInput =
      typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {};
    const decision = authorizeRepositoryTool(repositoryRoot, input.tool_name, parsedInput);
    if (decision.allowed) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason ?? "repository access denied",
      },
    };
  };
}
