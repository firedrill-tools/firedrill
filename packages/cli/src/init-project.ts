import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type InitPath = "coding-agent" | "template" | "manual";

export interface RepositoryDetection {
  readonly languages: readonly string[];
  readonly packageManagers: readonly string[];
  readonly testRunners: readonly string[];
  readonly agentLibraries: readonly string[];
  readonly codingAgents: readonly string[];
  readonly mcpConfiguration: readonly string[];
  readonly candidateAgentFiles: readonly string[];
  readonly firedrillProject: boolean;
}

export interface InitChoice {
  readonly path: InitPath;
  readonly recommended: boolean;
  readonly command: string;
  readonly effect: string;
}

export interface InitInspection {
  readonly schemaVersion: 1;
  readonly status: "inspection";
  readonly repositoryRoot: string;
  readonly detection: RepositoryDetection;
  readonly choices: readonly InitChoice[];
}

export interface InitializedProject {
  readonly schemaVersion: 1;
  readonly status: "initialized";
  readonly path: InitPath;
  readonly repositoryRoot: string;
  readonly detection: RepositoryDetection;
  readonly written: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly next: readonly string[];
}

export type InitProjectResult = InitInspection | InitializedProject;

export class FiredrillInitError extends Error {
  readonly code: "framework.INIT_CONFLICT" | "framework.INIT_INVALID_REPOSITORY";
  readonly paths: readonly string[];

  constructor(code: FiredrillInitError["code"], message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "FiredrillInitError";
    this.code = code;
    this.paths = paths;
  }
}

const IGNORED = new Set([".firedrill", ".git", "dist", "node_modules"]);
const MANIFEST = '{\n  "schemaVersion": 1\n}\n';
const WORLD =
  "schemaVersion: 1\nid: local-world\nactors:\n  - id: operator\n    grants:\n      - packageId: local-probe\n        operationId: ping\n";
const PROBE_TOOL =
  'schemaVersion: 1\nmodule: ./local-probe.mjs\nmanifest:\n  schemaVersion: 1\n  id: local-probe\n  version: 1.0.0\n  engine: ">=0.1.0 <0.2.0"\n  capabilities: []\n  operations:\n    - id: ping\n      inputSchema:\n        type: object\n        additionalProperties: false\n      outputSchema:\n        type: object\n        required: [ready]\n        properties:\n          ready: { type: boolean }\n        additionalProperties: false\n      idempotency: none\n      fidelity: contract\n';
const PROBE_BEHAVIOR = "export default { operations: { ping: () => ({ ready: true }) } };\n";

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function assetDirectory(name: "skill" | "template"): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundled =
    name === "skill" ? resolve(moduleDirectory, "skill") : resolve(moduleDirectory, "templates/minimal");
  if (existsSync(bundled)) return bundled;
  const repository = resolve(moduleDirectory, "../../..");
  const source =
    name === "skill" ? resolve(repository, "skills/firedrill") : resolve(repository, "templates/minimal");
  if (existsSync(source)) return source;
  throw new Error(`Firedrill ${name} asset is missing from this CLI installation`);
}

function shallowFiles(root: string): readonly string[] {
  const result: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 3 || result.length >= 5_000) return;
    let entries: Array<{
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= 5_000) return;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) visit(path, depth + 1);
      } else if (entry.isFile()) {
        result.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root, 0);
  return result.sort();
}

function packageNames(root: string): readonly string[] {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ].sort();
  } catch {
    return [];
  }
}

const PYTHON_LIBRARY_PATTERNS = [
  { name: "anthropic", pattern: /\banthropic\b/i },
  { name: "crewai", pattern: /\bcrewai\b/i },
  { name: "langchain", pattern: /\blangchain(?:[-_][a-z0-9]+)?\b/i },
  { name: "langgraph", pattern: /\blanggraph\b/i },
  { name: "llama-index", pattern: /\bllama[-_]index\b/i },
  { name: "mcp", pattern: /(?:\bmcp\b|\bmodelcontextprotocol\b)/i },
  { name: "openai", pattern: /\bopenai\b/i },
  { name: "semantic-kernel", pattern: /\bsemantic[-_]kernel\b/i },
] as const;

function pythonPackageNames(root: string, files: readonly string[]): readonly string[] {
  const candidates = files
    .filter(
      (file) =>
        file === "pyproject.toml" ||
        /(?:^|\/)requirements(?:[-_.][^/]*)?\.txt$/i.test(file) ||
        /(?:^|\/)(?:agent|assistant|bot|copilot)(?:[-_.][^/]*)?\.py$/i.test(file),
    )
    .slice(0, 50);
  const content: string[] = [];
  for (const file of candidates) {
    const absolutePath = join(root, ...file.split("/"));
    try {
      const metadata = lstatSync(absolutePath);
      if (!metadata.isFile() || metadata.size > 512 * 1024) continue;
      content.push(readFileSync(absolutePath, "utf8"));
    } catch {
      // Detection is a bounded hint, never a reason for init to fail.
    }
  }
  const source = content.join("\n");
  return PYTHON_LIBRARY_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function detectRepository(repositoryRoot: string): RepositoryDetection {
  const root = resolve(repositoryRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new FiredrillInitError(
      "framework.INIT_INVALID_REPOSITORY",
      "init requires an existing repository directory",
    );
  }
  const files = shallowFiles(root);
  const packages = packageNames(root);
  const pythonPackages = pythonPackageNames(root, files);
  const has = (name: string) => files.includes(name);
  const languages = unique([
    ...(files.some((file) => /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(file)) ? ["javascript-typescript"] : []),
    ...(files.some((file) => /\.py$/.test(file)) || has("pyproject.toml") ? ["python"] : []),
    ...(files.some((file) => /\.go$/.test(file)) || has("go.mod") ? ["go"] : []),
    ...(files.some((file) => /\.rs$/.test(file)) || has("Cargo.toml") ? ["rust"] : []),
  ]);
  const packageManagers = unique([
    ...(has("pnpm-lock.yaml") ? ["pnpm"] : []),
    ...(has("yarn.lock") ? ["yarn"] : []),
    ...(has("package-lock.json") ? ["npm"] : []),
    ...(has("bun.lock") || has("bun.lockb") ? ["bun"] : []),
    ...(has("uv.lock") ? ["uv"] : []),
    ...(has("poetry.lock") ? ["poetry"] : []),
  ]);
  const testRunners = unique([
    ...(packages.includes("vitest") ? ["vitest"] : []),
    ...(packages.includes("jest") || packages.includes("@jest/core") ? ["jest"] : []),
    ...(packages.includes("mocha") ? ["mocha"] : []),
    ...(files.some((file) => file === "pytest.ini" || file === "conftest.py") ? ["pytest"] : []),
  ]);
  const libraryPatterns = [
    "@anthropic-ai/sdk",
    "@langchain/core",
    "@modelcontextprotocol/sdk",
    "@openai/agents",
    "ai",
    "langchain",
    "openai",
  ];
  const agentLibraries = unique([
    ...packages.filter(
      (name) => libraryPatterns.includes(name) || /(?:agent|langgraph|semantic-kernel)/i.test(name),
    ),
    ...pythonPackages,
  ]);
  const codingAgents = unique([
    ...(files.some((file) => file === "AGENTS.md" || file.startsWith(".agents/")) ? ["agents"] : []),
    ...(files.some((file) => file === "CLAUDE.md" || file.startsWith(".claude/")) ? ["claude"] : []),
    ...(files.some((file) => file.startsWith(".cursor/")) ? ["cursor"] : []),
  ]);
  const mcpConfiguration = files.filter(
    (file) => /(?:^|\/)(?:\.mcp\.json|mcp\.json|mcp-config\.json)$/.test(file) || /mcp.*\.json$/i.test(file),
  );
  const candidateAgentFiles = files
    .filter((file) =>
      /(?:^|\/)(?:agent|assistant|bot|copilot)(?:[-_.][^/]*)?\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(file),
    )
    .slice(0, 20);
  return {
    languages,
    packageManagers,
    testRunners,
    agentLibraries,
    codingAgents,
    mcpConfiguration,
    candidateAgentFiles,
    firedrillProject: has("firedrill.json"),
  };
}

interface PlannedFile {
  readonly path: string;
  readonly body: Buffer;
}

interface RuntimeIgnorePlan {
  readonly action: "append" | "create" | "none";
  readonly absolutePath: string;
}

const RUNTIME_IGNORE_ENTRY = ".firedrill/";
const RUNTIME_IGNORE_PATTERNS = new Set([".firedrill", ".firedrill/", "/.firedrill", "/.firedrill/"]);

function planRuntimeArtifactsIgnore(root: string): RuntimeIgnorePlan {
  const absolutePath = join(root, ".gitignore");
  if (!existsSync(absolutePath)) return { action: "create", absolutePath };
  const metadata = lstatSync(absolutePath);
  if (!metadata.isFile()) {
    throw new FiredrillInitError(
      "framework.INIT_CONFLICT",
      "init cannot safely update the repository ignore rules",
      [".gitignore"],
    );
  }
  const rules = readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  let lastExactRule: string | undefined;
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule !== undefined && RUNTIME_IGNORE_PATTERNS.has(rule.startsWith("!") ? rule.slice(1) : rule)) {
      lastExactRule = rule;
      break;
    }
  }
  return {
    action: lastExactRule !== undefined && !lastExactRule.startsWith("!") ? "none" : "append",
    absolutePath,
  };
}

function applyRuntimeArtifactsIgnore(plan: RuntimeIgnorePlan): {
  readonly written: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
} {
  if (plan.action === "none") {
    return { written: [], updated: [], unchanged: [".gitignore"] };
  }
  if (plan.action === "create") {
    try {
      writeFileSync(plan.absolutePath, `${RUNTIME_IGNORE_ENTRY}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FiredrillInitError(
          "framework.INIT_CONFLICT",
          "a .gitignore file appeared while init was writing; rerun init to reconcile it",
          [".gitignore"],
        );
      }
      throw error;
    }
    return { written: [".gitignore"], updated: [], unchanged: [] };
  }
  const current = readFileSync(plan.absolutePath, "utf8");
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  appendFileSync(plan.absolutePath, `${separator}${RUNTIME_IGNORE_ENTRY}\n`);
  return { written: [], updated: [".gitignore"], unchanged: [] };
}

function treeFiles(sourceRoot: string, destinationRoot: string): readonly PlannedFile[] {
  const files: PlannedFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`CLI assets cannot contain a symlink: ${source}`);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile()) {
        const relativePath = relative(sourceRoot, source);
        files.push({ path: join(destinationRoot, relativePath), body: readFileSync(source) });
      }
    }
  };
  visit(sourceRoot);
  return files;
}

function projectShell(): readonly PlannedFile[] {
  return [
    { path: "firedrill.json", body: Buffer.from(MANIFEST) },
    { path: "firedrill/world.yaml", body: Buffer.from(WORLD) },
    { path: "firedrill/local-probe.tool.yaml", body: Buffer.from(PROBE_TOOL) },
    { path: "firedrill/local-probe.mjs", body: Buffer.from(PROBE_BEHAVIOR) },
  ];
}

function repositoryBrief(detection: RepositoryDetection): PlannedFile {
  const line = (label: string, values: readonly string[]) =>
    `- ${label}: ${values.length === 0 ? "none detected" : values.map((value) => `\`${value}\``).join(", ")}`;
  const body = [
    "# Firedrill repository brief",
    "",
    "This file records the bounded, read-only inspection performed by `firedrill init`. It does not prove that a detected file is the product agent entry point. Verify every seam in source before editing.",
    "",
    "## Detected context",
    "",
    line("Languages", detection.languages),
    line("Package managers", detection.packageManagers),
    line("Test runners", detection.testRunners),
    line("Agent libraries", detection.agentLibraries),
    line("Coding-agent conventions", unique([...detection.codingAgents, "agents"])),
    line("MCP configuration", detection.mcpConfiguration),
    line("Candidate product-agent files", detection.candidateAgentFiles),
    `- Existing Firedrill project: ${detection.firedrillProject ? "yes" : "no"}`,
    "",
    "## Coding-agent task",
    "",
    "Read `.agents/skills/firedrill/SKILL.md` next. Scout the actual product-agent entry point and tool composition seam, author the smallest generic world vertical slice, iterate `firedrill validate --json` to green, and finish with both passing and deliberately failing local evidence. Do not read secrets, invent a framework integration, or change production behavior merely to make a drill pass.",
    "",
  ].join("\n");
  return { path: ".agents/firedrill/BRIEF.md", body: Buffer.from(body) };
}

function applyPlan(root: string, files: readonly PlannedFile[]) {
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  const pending: Array<PlannedFile & { absolutePath: string; repositoryPath: string }> = [];
  for (const file of files) {
    const absolutePath = resolve(root, file.path);
    if (!contained(root, absolutePath)) throw new Error(`init path escapes repository: ${file.path}`);
    const repositoryPath = relative(root, absolutePath).split(sep).join("/");
    if (existsSync(absolutePath)) {
      const metadata = lstatSync(absolutePath);
      if (!metadata.isFile() || !readFileSync(absolutePath).equals(file.body)) conflicts.push(repositoryPath);
      else unchanged.push(repositoryPath);
    } else {
      pending.push({ ...file, absolutePath, repositoryPath });
    }
  }
  if (conflicts.length > 0) {
    throw new FiredrillInitError(
      "framework.INIT_CONFLICT",
      "init refuses to replace existing files; move or reconcile the listed paths first",
      conflicts.sort(),
    );
  }
  const written: string[] = [];
  for (const file of pending) {
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    try {
      writeFileSync(file.absolutePath, file.body, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FiredrillInitError(
          "framework.INIT_CONFLICT",
          "a file appeared while init was writing; no existing file was replaced",
          [file.repositoryPath],
        );
      }
      throw error;
    }
    written.push(file.repositoryPath);
  }
  return { written: written.sort(), unchanged: unchanged.sort() };
}

function choices(): readonly InitChoice[] {
  return [
    {
      path: "coding-agent",
      recommended: true,
      command: "firedrill init --path coding-agent",
      effect: "Install the canonical Firedrill skill without changing application or world source.",
    },
    {
      path: "template",
      recommended: false,
      command: "firedrill init --path template",
      effect: "Copy a complete local Tool, agent target, scenario, and passing drill.",
    },
    {
      path: "manual",
      recommended: false,
      command: "firedrill init --path manual",
      effect: "Create a compilable world shell with one deterministic local probe Tool.",
    },
  ];
}

export function initProject(repositoryRoot: string, path?: InitPath): InitProjectResult {
  const root = resolve(repositoryRoot);
  const detection = detectRepository(root);
  if (path === undefined) {
    return { schemaVersion: 1, status: "inspection", repositoryRoot: root, detection, choices: choices() };
  }

  let files: readonly PlannedFile[];
  let next: readonly string[];
  if (path === "coding-agent") {
    files = [...treeFiles(assetDirectory("skill"), ".agents/skills/firedrill"), repositoryBrief(detection)];
    next = [
      "Ask your coding agent: Read .agents/firedrill/BRIEF.md, then follow .agents/skills/firedrill/SKILL.md to its definition of done.",
      "Run firedrill validate --json after the agent creates the first vertical slice.",
    ];
  } else if (path === "template") {
    files = treeFiles(assetDirectory("template"), ".");
    next = [
      "Run firedrill validate.",
      "Run firedrill run changes-resource and open the printed HTML report.",
      "Replace the starter Tool and target with this repository's real agent boundary.",
    ];
  } else {
    files = projectShell();
    next = [
      "Run firedrill validate to verify the local world shell.",
      "Define Tool, scenario, target, and drill source under firedrill/.",
      "Run firedrill validate --json until diagnostics are empty.",
    ];
  }
  const runtimeIgnorePlan = planRuntimeArtifactsIgnore(root);
  const applied = applyPlan(root, files);
  const ignored = applyRuntimeArtifactsIgnore(runtimeIgnorePlan);
  return {
    schemaVersion: 1,
    status: "initialized",
    path,
    repositoryRoot: root,
    detection,
    written: [...applied.written, ...ignored.written].sort(),
    updated: ignored.updated,
    unchanged: [...applied.unchanged, ...ignored.unchanged].sort(),
    next,
  };
}
