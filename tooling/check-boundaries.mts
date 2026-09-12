import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

type Layer = "adapter" | "app" | "core" | "example" | "tool-pack";

interface PackageInfo {
  directory: string;
  dynamicImports: ReadonlySet<string>;
  layer: Layer;
  name: string;
  manifest: Record<string, unknown>;
}

const root = resolve(import.meta.dirname, "..");
const roots = ["apps", "packages", "tool-packs", "examples"];
const packages: PackageInfo[] = [];

for (const group of roots) {
  const directory = join(root, group);
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDirectory = join(directory, entry.name);
      const manifestPath = join(packageDirectory, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const metadata = manifest.firedrill as
          | { layer?: Layer; dynamicImports?: readonly string[] }
          | undefined;
        if (!metadata?.layer) throw new Error(`${relative(root, manifestPath)} has no firedrill.layer`);
        packages.push({
          directory: packageDirectory,
          dynamicImports: new Set(metadata.dynamicImports ?? []),
          layer: metadata.layer,
          name: String(manifest.name),
          manifest,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const byName = new Map(packages.map((item) => [item.name, item]));
const violations: string[] = [];
const forbiddenOssImports = [
  "@anthropic-ai/sdk",
  "@firedrill/platform",
  "@google-cloud/",
  "@workos-inc/",
  "firebase-admin",
  "@octokit/app",
];
const claudeAgentSdk = "@anthropic-ai/claude-agent-sdk";
const claudeAgentOwner = "@firedrill/agent";

function isForbiddenOssImport(specifier: string): boolean {
  return (
    specifier.includes("firedrill-platform") ||
    forbiddenOssImports.some((prefix) => specifier.startsWith(prefix))
  );
}

for (const canary of ["@firedrill/platform", "@firedrill/platform/control", "firedrill-platform"]) {
  if (!isForbiddenOssImport(canary)) throw new Error(`hosted import canary was not rejected: ${canary}`);
}
if (!isForbiddenOssImport("@anthropic-ai/sdk")) {
  throw new Error("direct Anthropic client SDK canary was not rejected");
}
if (isForbiddenOssImport(claudeAgentSdk)) {
  throw new Error("Claude Agent SDK must remain available to its dedicated package");
}
const allowedWorkspaceLayers: Record<Layer, ReadonlySet<Layer>> = {
  core: new Set(["core"]),
  adapter: new Set(["core", "adapter"]),
  "tool-pack": new Set(["core", "adapter", "tool-pack"]),
  app: new Set(["core", "adapter", "tool-pack", "app"]),
  example: new Set(["core", "adapter", "tool-pack", "app", "example"]),
};

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Local conformance writes compiled artifacts; those are not package source.
      if ([".firedrill", ".git", "coverage", "dist", "node_modules"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(path);
    }
  };
  walk(directory);
  return result;
}

function importsIn(file: string): Array<{ literal: boolean; specifier: string }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: Array<{ literal: boolean; specifier: string }> = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const literal = ts.isStringLiteral(node.moduleSpecifier);
      imports.push({
        literal,
        specifier: literal ? node.moduleSpecifier.text : node.moduleSpecifier.getText(source),
      });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const literal = argument !== undefined && ts.isStringLiteral(argument);
      imports.push({ literal, specifier: literal && argument !== undefined ? argument.text : "<dynamic>" });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const argument = node.arguments[0];
      const literal = argument !== undefined && ts.isStringLiteral(argument);
      imports.push({ literal, specifier: literal && argument !== undefined ? argument.text : "<dynamic>" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function workspacePackage(specifier: string): PackageInfo | undefined {
  return packages
    .toSorted((left, right) => right.name.length - left.name.length)
    .find((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
}

function externalPackage(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

for (const candidate of packages) {
  if (workspacePackage(`${candidate.name}/boundary-canary`) !== candidate) {
    throw new Error(`workspace subpath resolution failed for ${candidate.name}`);
  }
}

for (const owner of packages) {
  const runtimeDependencies = {
    ...((owner.manifest.dependencies as Record<string, string> | undefined) ?? {}),
    ...((owner.manifest.optionalDependencies as Record<string, string> | undefined) ?? {}),
    ...((owner.manifest.peerDependencies as Record<string, string> | undefined) ?? {}),
  };
  const allDependencies = {
    ...runtimeDependencies,
    ...((owner.manifest.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  for (const dependency of Object.keys(allDependencies)) {
    if (isForbiddenOssImport(dependency)) {
      violations.push(`${owner.name}: forbidden OSS dependency ${dependency}`);
    }
    if (dependency === claudeAgentSdk && owner.name !== claudeAgentOwner) {
      violations.push(`${owner.name}: only ${claudeAgentOwner} may depend on ${claudeAgentSdk}`);
    }
    const target = byName.get(dependency);
    if (target && !allowedWorkspaceLayers[owner.layer].has(target.layer)) {
      violations.push(
        `${owner.name}: ${owner.layer} package cannot depend on ${target.layer} package ${target.name}`,
      );
    }
    if (target?.layer === "app" && target.name !== owner.name) {
      violations.push(`${owner.name}: applications may not depend on application ${target.name}`);
    }
  }

  for (const file of sourceFiles(owner.directory)) {
    for (const imported of importsIn(file)) {
      const label = relative(root, file);
      if (!imported.literal) {
        const packagePath = relative(owner.directory, file).split(sep).join("/");
        if (!owner.dynamicImports.has(packagePath)) {
          violations.push(`${label}: non-literal dynamic import/require is not allowed`);
        }
        continue;
      }
      const specifier = imported.specifier;
      if (isForbiddenOssImport(specifier)) {
        violations.push(`${label}: forbidden OSS import ${specifier}`);
      }
      if (specifier === claudeAgentSdk && owner.name !== claudeAgentOwner) {
        violations.push(`${label}: only ${claudeAgentOwner} may import ${claudeAgentSdk}`);
      }
      const target = workspacePackage(specifier);
      if (target && !allowedWorkspaceLayers[owner.layer].has(target.layer)) {
        violations.push(
          `${label}: ${owner.layer} package cannot import ${target.layer} package ${target.name}`,
        );
      }
      if (target?.layer === "app" && target.name !== owner.name) {
        violations.push(`${label}: applications may not import application ${target.name}`);
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("node:") && !target) {
        const dependency = externalPackage(specifier);
        if (!(dependency in allDependencies))
          violations.push(`${label}: undeclared dependency ${dependency}`);
      }
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier);
        const relativeToOwner = relative(owner.directory, resolved);
        if (relativeToOwner === ".." || relativeToOwner.startsWith(`..${sep}`)) {
          violations.push(`${label}: relative import crosses package boundary: ${specifier}`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`boundary check passed for ${packages.length} package(s)\n`);
