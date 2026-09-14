import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ToolIndexSchema, type ToolIndex } from "../packages/cli/src/tool-index-schema.js";
import { compareStableStrings } from "./stable-order.mts";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly maintainers?: readonly ({ readonly name?: string } | string)[];
  readonly firedrill?: {
    readonly layer?: string;
    readonly tool?: string;
    readonly lifecycle?: "active" | "deprecated" | "revoked";
    readonly conformance?:
      | string
      | { readonly schemaVersion: 1; readonly project: string; readonly suite: string };
    readonly catalog?: { readonly title?: string; readonly description?: string };
  };
}

interface ToolDeclaration {
  readonly ui?: unknown;
  readonly manifest?: {
    readonly id?: string;
    readonly version?: string;
    readonly engine?: string;
    readonly capabilities?: readonly string[];
    readonly state?: readonly { readonly namespace?: string }[];
    readonly operations?: readonly { readonly id?: string; readonly fidelity?: string }[];
    readonly http?: readonly {
      readonly id?: string;
      readonly operationId?: string;
      readonly method?: string;
      readonly path?: string;
    }[];
    readonly compatibility?: readonly unknown[];
    readonly events?: readonly { readonly id?: string }[];
    readonly faults?: readonly { readonly id?: string }[];
    readonly subscriptions?: readonly { readonly id?: string }[];
    readonly connections?: readonly unknown[];
  };
}

const root = resolve(import.meta.dirname, "..");
const registryRoot = join(root, "registry");
const jsonOutputPath = join(registryRoot, "index.json");
const markdownOutputPath = join(registryRoot, "README.md");
const sourceIndex = process.argv.indexOf("--source");
const sourceRepository =
  sourceIndex < 0 ? undefined : resolve(process.cwd(), process.argv[sourceIndex + 1] ?? "");

function fail(message: string): never {
  throw new Error(message);
}

function command(cwd: string, executable: string, arguments_: readonly string[]): string {
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`${executable} ${arguments_.join(" ")} failed\n${result.stderr}`);
  return result.stdout.trim();
}

function gitFile(repository: string, revision: string, path: string): string {
  return command(repository, "git", ["show", `${revision}:${path}`]);
}

function httpsRemote(value: string): string {
  if (value.startsWith("git@github.com:")) return `https://github.com/${value.slice(15)}`;
  if (value.startsWith("ssh://git@github.com/")) return `https://github.com/${value.slice(21)}`;
  if (value.startsWith("https://")) return value;
  fail("The community Tool repository must have a credential-free HTTPS or GitHub SSH origin");
}

const preferredTitles: Readonly<Record<string, string>> = {
  github: "GitHub",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  hubspot: "HubSpot",
  jira: "Jira",
  linear: "Linear",
  notion: "Notion",
  salesforce: "Salesforce",
  slack: "Slack",
  stripe: "Stripe",
};

function titleFor(id: string, declared: string | undefined): string {
  if (declared?.trim()) return declared.trim();
  return (
    preferredTitles[id] ??
    id
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

function requiredText(value: unknown, label: string): string {
  return typeof value === "string" && value.length > 0 ? value : fail(`${label} is missing`);
}

function importCommunityIndex(repository: string): ToolIndex {
  const revision = command(repository, "git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(revision)) fail("community Tool source revision is invalid");
  const remote = httpsRemote(command(repository, "git", ["remote", "get-url", "origin"]));
  const packagePaths = command(repository, "git", ["ls-tree", "-r", "--name-only", revision, "packages"])
    .split("\n")
    .filter((path) => /^packages\/[a-z0-9-]+\/package\.json$/.test(path))
    .sort(compareStableStrings);
  const packages = packagePaths.flatMap((packagePath) => {
    const package_ = JSON.parse(gitFile(repository, revision, packagePath)) as PackageManifest;
    if (package_.firedrill?.layer !== "tool-pack") return [];
    const toolPath = requiredText(package_.firedrill.tool, `${package_.name} firedrill.tool`);
    const packageDirectory = dirname(packagePath);
    const declaration = JSON.parse(
      gitFile(repository, revision, `${packageDirectory}/${toolPath}`),
    ) as ToolDeclaration;
    const manifest = declaration.manifest ?? fail(`${package_.name} Tool manifest is missing`);
    const id = requiredText(manifest.id, `${package_.name} Tool id`);
    if (manifest.version !== package_.version) fail(`${package_.name} package and Tool versions differ`);
    const operations = (manifest.operations ?? []).map((operation) => ({
      id: requiredText(operation.id, `${package_.name} operation id`),
      fidelity: requiredText(operation.fidelity, `${package_.name} operation fidelity`),
    }));
    if (operations.length === 0) fail(`${package_.name} has no operations`);
    const lifecycle = package_.firedrill.lifecycle ?? fail(`${package_.name} lifecycle is missing`);
    if (lifecycle === "revoked") return [];
    const conformance = package_.firedrill.conformance;
    const conformanceSuite = typeof conformance === "string" ? conformance : conformance?.suite;
    const maintainers = (package_.maintainers ?? []).flatMap((maintainer) => {
      const name = typeof maintainer === "string" ? maintainer : maintainer.name;
      return name ? [name] : [];
    });
    return [
      {
        packageName: requiredText(package_.name, `${packagePath} package name`),
        packageVersion: requiredText(package_.version, `${package_.name} package version`),
        title: titleFor(id, package_.firedrill.catalog?.title),
        description: package_.firedrill.catalog?.description ?? package_.description,
        ...(package_.license === undefined ? {} : { license: package_.license }),
        lifecycle,
        maintainers,
        keywords: [...(package_.keywords ?? [])].sort(compareStableStrings),
        ...(conformanceSuite === undefined ? {} : { conformanceSuite }),
        source: {
          kind: "git" as const,
          url: remote,
          commit: revision,
          subdirectory: packageDirectory,
        },
        tool: {
          id,
          version: manifest.version,
          engine: manifest.engine,
          capabilities: manifest.capabilities ?? [],
          state: (manifest.state ?? []).map((state) =>
            requiredText(state.namespace, `${id} state namespace`),
          ),
          operations,
          http: manifest.http ?? [],
          compatibility: manifest.compatibility ?? [],
          events: (manifest.events ?? []).map((event) => requiredText(event.id, `${id} event id`)),
          faults: (manifest.faults ?? []).map((fault) => requiredText(fault.id, `${id} fault id`)),
          subscriptions: (manifest.subscriptions ?? []).map((subscription) =>
            requiredText(subscription.id, `${id} subscription id`),
          ),
          connections: manifest.connections ?? [],
          browserApp: declaration.ui !== undefined,
        },
      },
    ];
  });
  return ToolIndexSchema.parse({
    schemaVersion: 1,
    sourceRepository: remote,
    sourceRevision: revision,
    packages,
  });
}

function readIndex(): ToolIndex {
  return ToolIndexSchema.parse(JSON.parse(readFileSync(jsonOutputPath, "utf8")));
}

function inlineList(values: readonly string[]): string {
  return values.length === 0 ? "None" : values.map((value) => `\`${value}\``).join(", ");
}

function sourceLink(entry: ToolIndex["packages"][number]): string | undefined {
  if (entry.source?.kind !== "git") return undefined;
  const repository = entry.source.url.replace(/\.git$/, "");
  return `${repository}/tree/${entry.source.commit}${
    entry.source.subdirectory === undefined ? "" : `/${entry.source.subdirectory}`
  }`;
}

function renderMarkdown(index: ToolIndex): string {
  const lines = [
    "# Community Tool catalog",
    "",
    "> Generated from a reviewed community-tools revision. Do not edit this file by hand.",
    "",
    "Browse the catalog from any project with `firedrill tool list`, narrow it with `firedrill tool search <text>`, and explicitly install a selected package with the printed `firedrill tool add` command. Listing and searching read metadata only; they never install or run Tool code.",
    "",
    "A Tool may also come from any npm package, Git repository, local directory, or private catalog that follows the same open contract. Inclusion here is optional and does not replace source review or conformance checks.",
    "",
  ];
  for (const entry of index.packages) {
    const link = sourceLink(entry);
    const extended = entry.tool as typeof entry.tool & {
      readonly browserApp?: boolean;
      readonly connections?: readonly { readonly protocol?: string }[];
      readonly http?: readonly unknown[];
    };
    const interfaces = [
      extended.browserApp ? "browser app" : "",
      ...(extended.connections?.map((connection) => connection.protocol?.toLowerCase() ?? "") ?? []),
      ...(extended.http?.length ? ["http"] : []),
      "mcp",
      "cli",
      "function",
    ].filter(Boolean);
    lines.push(
      `## ${link ? `[${entry.title ?? entry.tool.id}](${link})` : (entry.title ?? entry.tool.id)}`,
      "",
      entry.description,
      "",
      `- Package: \`${entry.packageName}@${entry.packageVersion}\``,
      `- Tool ID: \`${entry.tool.id}\``,
      `- Lifecycle: \`${entry.lifecycle}\``,
      `- Operations: ${entry.tool.operations.length}`,
      `- Interfaces: ${inlineList([...new Set(interfaces)])}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatJson(value: unknown): string {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  const formatted = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", jsonOutputPath], {
    cwd: root,
    encoding: "utf8",
    input: output,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (formatted.status !== 0) fail(`cannot format registry metadata\n${formatted.stderr}`);
  return formatted.stdout;
}

const index = sourceRepository === undefined ? readIndex() : importCommunityIndex(sourceRepository);
const jsonOutput = formatJson(index);
const markdownOutput = renderMarkdown(index);
if (process.argv.includes("--check")) {
  const currentJson = readFileSync(jsonOutputPath, "utf8");
  const currentMarkdown = readFileSync(markdownOutputPath, "utf8");
  if (currentJson !== jsonOutput || currentMarkdown !== markdownOutput) {
    process.stderr.write("registry metadata is stale; run pnpm registry:write\n");
    process.exit(1);
  }
} else {
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(jsonOutputPath, jsonOutput);
  writeFileSync(markdownOutputPath, markdownOutput);
  process.stdout.write(`wrote ${index.packages.length} community Tool record(s)\n`);
}
