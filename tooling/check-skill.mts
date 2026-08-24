import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillRoot = join(root, "skills", "firedrill");
const skillPath = join(skillRoot, "SKILL.md");
const metadataPath = join(skillRoot, "agents", "openai.yaml");

function fail(message: string): never {
  throw new Error(`canonical Firedrill skill is invalid: ${message}`);
}

function filesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink is not allowed: ${relative(skillRoot, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

function assertSameTree(expectedRoot: string, actualRoot: string, label: string): void {
  if (!existsSync(actualRoot)) fail(`${label} is missing; build the CLI before running this check`);
  const relativeFiles = (directory: string) =>
    filesUnder(directory)
      .map((path) => relative(directory, path))
      .sort();
  const expectedFiles = relativeFiles(expectedRoot);
  const actualFiles = relativeFiles(actualRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    fail(`${label} has a different file set from the canonical source`);
  }
  for (const path of expectedFiles) {
    if (!readFileSync(join(actualRoot, path)).equals(readFileSync(join(expectedRoot, path)))) {
      fail(`${label} differs from the canonical source at ${path}`);
    }
  }
}

if (!existsSync(skillPath)) fail("SKILL.md is missing");
const skill = readFileSync(skillPath, "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!frontmatter) fail("SKILL.md needs YAML frontmatter");
const fields =
  frontmatter[1]
    ?.split("\n")
    .filter(Boolean)
    .map((line) => line.match(/^([a-z_]+):\s+(.+)$/)) ?? [];
if (fields.some((field) => field === null)) fail("frontmatter must contain simple key/value fields");
const metadata = Object.fromEntries(fields.map((field) => [field?.[1], field?.[2]]));
if (Object.keys(metadata).sort().join(",") !== "description,name") {
  fail("frontmatter may contain only name and description");
}
if (metadata.name !== "firedrill") fail("frontmatter name must be firedrill");
if ((metadata.description?.length ?? 0) < 80) fail("description must explain both capability and trigger");
if (/\b(?:TODO|TBD|placeholder)\b/i.test(skill)) fail("unfinished language is not allowed");

for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
  const reference = match[1];
  if (reference === undefined || !existsSync(join(skillRoot, reference))) {
    fail(`referenced file is missing: ${reference ?? "unknown"}`);
  }
}

if (!existsSync(metadataPath)) fail("agents/openai.yaml is missing");
const openAiMetadata = readFileSync(metadataPath, "utf8");
if (!/^interface:\n/m.test(openAiMetadata)) fail("agents/openai.yaml needs an interface mapping");
if (!/\n {2}display_name: "Firedrill"\n/.test(`\n${openAiMetadata}`)) {
  fail("agents/openai.yaml needs the Firedrill display name");
}
const shortDescription = openAiMetadata.match(/short_description:\s+"([^"]+)"/)?.[1];
if (!shortDescription || shortDescription.length < 25 || shortDescription.length > 64) {
  fail("short_description must be 25 through 64 characters");
}
if (!/default_prompt:\s+"[^"]*\$firedrill[^"]*"/.test(openAiMetadata)) {
  fail("default_prompt must explicitly invoke $firedrill");
}

assertSameTree(skillRoot, join(root, "packages", "cli", "dist", "skill"), "CLI-bundled skill");
assertSameTree(
  join(root, "templates", "minimal"),
  join(root, "packages", "cli", "dist", "templates", "minimal"),
  "CLI-bundled minimal template",
);

process.stdout.write("canonical coding-agent skill and CLI assets are valid\n");
