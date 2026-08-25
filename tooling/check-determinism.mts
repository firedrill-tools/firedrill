import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const violations: string[] = [];
const excluded = new Set([".firedrill", ".git", "coverage", "dist", "node_modules"]);

function visit(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      if (/\.localeCompare\s*\(/.test(source)) {
        violations.push(`${relative(root, path)}: localeCompare is forbidden in deterministic code`);
      }
      if (/\bIntl\.Collator\s*\(/.test(source)) {
        violations.push(`${relative(root, path)}: Intl.Collator is forbidden in deterministic code`);
      }
    }
  }
}

for (const directory of ["packages", "tool-packs", "tooling"]) visit(join(root, directory));

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("deterministic ordering scan passed\n");
