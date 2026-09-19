import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const excludedDirectories = new Set([".firedrill", ".git", "coverage", "dist", "node_modules"]);
const ignoredFiles = new Set([".DS_Store"]);
const violations: string[] = [];

const forbiddenFileNames = [
  /^\.env(?:\..+)?$/,
  /(?:^|[-_.])credentials\.json$/i,
  /(?:^|[-_.])service[-_.]?account(?:[-_.].+)?\.json$/i,
  /\.(?:key|p12|pfx|pem)$/i,
];

const sensitiveText: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    label: "private key material",
    pattern: new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE ${"KEY"}-----`),
  },
  { label: "AWS access key", pattern: new RegExp(`A${"KIA"}[0-9A-Z]{16}`) },
  { label: "GitHub token", pattern: new RegExp(`g${"h[pousr]"}_[A-Za-z0-9]{20,}`) },
  { label: "Slack token", pattern: new RegExp(`x${"ox[baprs]"}-[A-Za-z0-9-]{20,}`) },
  { label: "Anthropic API key", pattern: new RegExp(`s${"k-ant-"}[A-Za-z0-9_-]{20,}`) },
  { label: "OpenAI-style API key", pattern: new RegExp(`s${"k-"}[A-Za-z0-9_-]{20,}`) },
  { label: "WorkOS secret key", pattern: new RegExp(`s${"k_(?:test|prod)_"}[A-Za-z0-9_-]{16,}`) },
  {
    label: "GCP service-account private key",
    pattern: new RegExp(`"type"\\s*:\\s*"service_account"[\\s\\S]{0,2000}"private_${"key"}"\\s*:`),
  },
];

function visit(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (ignoredFiles.has(entry.name)) continue;
    const path = join(directory, entry.name);
    // Wheel assembly is generated release output, not checked-in source.
    const generated = relative(root, path).replaceAll("\\", "/");
    if (
      generated === ".cache/python-runtime" ||
      generated === "python/src/firedrill/_runtime" ||
      generated === "python/src/firedrill_agent_runtime" ||
      generated === "python/agent-runtime/src/firedrill_agent_runtime/node_modules" ||
      generated === "python/build" ||
      ["__pycache__", ".pytest_cache", ".venv", ".mypy_cache", ".ruff_cache"].includes(entry.name)
    )
      continue;
    if (entry.isDirectory()) {
      visit(path);
      continue;
    }

    const repositoryPath = relative(root, path);
    if (
      basename(path) !== ".env.example" &&
      forbiddenFileNames.some((pattern) => pattern.test(basename(path)))
    ) {
      violations.push(`${repositoryPath}: secret-bearing filename is not allowed`);
      continue;
    }
    if (statSync(path).size > 5 * 1024 * 1024) {
      violations.push(`${repositoryPath}: source file exceeds the 5 MiB public-tree limit`);
      continue;
    }

    const contents = readFileSync(path);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const candidate of sensitiveText) {
      if (candidate.pattern.test(text)) {
        violations.push(`${repositoryPath}: possible ${candidate.label}`);
      }
    }
  }
}

visit(root);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("public tree secret and artifact scan passed\n");
