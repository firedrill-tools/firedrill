import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "examples", "quickstart");
const temporary = mkdtempSync(join(tmpdir(), "firedrill-quickstart-"));
const cli = join(root, "packages", "cli", "dist", "bin.js");

function run(arguments_: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: temporary,
    encoding: "utf8",
    timeout: 30_000,
  });
}

try {
  cpSync(source, temporary, { recursive: true });

  const validation = run(["validate"]);
  if (validation.status !== 0 || !validation.stdout.includes("World valid")) {
    throw new Error(`quickstart validation failed\n${validation.stdout}\n${validation.stderr}`);
  }

  const passing = run([]);
  if (
    passing.status !== 0 ||
    !passing.stdout.includes("PASSED") ||
    !passing.stdout.includes("HTML report:")
  ) {
    throw new Error(`quickstart passing drill failed\n${passing.stdout}\n${passing.stderr}`);
  }

  const drillPath = join(temporary, "firedrill", "set-record.drill.yaml");
  const drill = readFileSync(drillPath, "utf8");
  const changed = drill.replace(
    "comparison: { operator: equals, value: 7 }",
    "comparison: { operator: equals, value: 8 }",
  );
  if (changed === drill) throw new Error("quickstart failure edit no longer matches the documented source");
  writeFileSync(drillPath, changed);

  const failing = run([]);
  if (
    failing.status !== 1 ||
    !failing.stdout.includes("FAILED") ||
    !failing.stdout.includes("HTML report:")
  ) {
    throw new Error(
      `quickstart failing drill did not produce useful evidence\n${failing.stdout}\n${failing.stderr}`,
    );
  }
  const htmlPath = /HTML report: (.+)/.exec(failing.stdout)?.[1]?.trim();
  if (htmlPath === undefined) throw new Error("quickstart failure did not print its HTML report path");
  const report = readFileSync(htmlPath, "utf8");
  if (!report.includes('class="assertion failed"') || !report.includes("<details open>")) {
    throw new Error("quickstart HTML does not expose failed assertion evidence on first view");
  }
  if (report.includes('class="eyebrow"') || report.includes("<strong>completed</strong><p")) {
    throw new Error("quickstart HTML contains redundant report chrome");
  }

  process.stdout.write("quickstart check passed for validation, passing evidence, and failing evidence\n");
} finally {
  if (temporary.startsWith(`${tmpdir()}/firedrill-quickstart-`)) {
    rmSync(temporary, { force: true, recursive: true });
  }
}
