import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { NodePackageNameSchema, PackageIdSchema, SemverSchema } from "@firedrill/contracts";
import { createTool, FiredrillToolSetupError } from "./tool-setup.js";

export interface ToolPackageScaffoldResult {
  readonly schemaVersion: 1;
  readonly kind: "tool-package-created";
  readonly root: string;
  readonly toolId: string;
  readonly packageName: string;
  readonly created: readonly string[];
  readonly nextSteps: readonly string[];
}

/** Creates an independent, self-contained package. Never installs, builds, executes, or publishes code. */
export function createToolPackage(input: {
  readonly root: string;
  readonly id: string;
  readonly packageName?: string;
  readonly template?: "stateful" | "stateless";
}): ToolPackageScaffoldResult {
  const packageName = input.packageName ?? `firedrill-tool-${input.id}`;
  if (
    !PackageIdSchema.safeParse(input.id).success ||
    !NodePackageNameSchema.safeParse(packageName).success ||
    (input.template !== undefined && !["stateful", "stateless"].includes(input.template))
  )
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_INVALID_ARGUMENT",
      "Choose a valid Tool id, npm package name, and stateful or stateless template.",
    );
  const requestedRoot = resolve(input.root);
  if (
    existsSync(requestedRoot) &&
    (lstatSync(requestedRoot).isSymbolicLink() ||
      !lstatSync(requestedRoot).isDirectory() ||
      readdirSync(requestedRoot).length !== 0)
  )
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_CONFLICT",
      "Create a Tool package in a new or empty directory; symbolic links and existing files are never overwritten.",
      [requestedRoot],
    );
  mkdirSync(dirname(requestedRoot), { recursive: true });
  // Canonicalize the selected parent (for example macOS /tmp); the destination itself cannot be a symlink.
  const root = join(realpathSync(dirname(requestedRoot)), basename(requestedRoot));
  const staging = mkdtempSync(join(dirname(root), ".firedrill-tool-package-"));
  const template = input.template ?? "stateful";
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(
      join(staging, path),
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx" },
    );
  };
  try {
    const tool = createTool({ root: staging, id: input.id, template });
    writeFileSync(
      join(staging, ".gitignore"),
      ".firedrill/\nnode_modules/\n/*.tgz\n.env\n.env.*\n!.env.example\n",
    );
    const starter = {
      schemaVersion: 1,
      state:
        template === "stateful"
          ? [
              {
                action: "upsert",
                packageId: input.id,
                namespace: "records",
                rowId: "welcome",
                value: { value: "initial" },
              },
            ]
          : [],
    };
    write("starter.json", starter);
    write("package.json", {
      name: packageName,
      version: "1.0.0",
      description: `Synthetic ${input.id} Tool for Firedrill`,
      type: "module",
      license: "UNLICENSED",
      engines: { node: ">=20.19" },
      exports: { "./package.json": "./package.json" },
      files: ["firedrill", "test", "firedrill.json", "starter.json", "README.md"],
      firedrill: {
        layer: "tool-pack",
        tool: `firedrill/tools/${input.id}/${input.id}.tool.json`,
        starter: "starter.json",
        lifecycle: "active",
        conformance: { schemaVersion: 1, project: "firedrill.json", suite: "conformance" },
      },
      scripts: { validate: "firedrill validate", test: `firedrill tool test ${input.id}` },
      devDependencies: {
        "@firedrill/cli": installedCliVersion(),
        "@firedrill/tool-sdk": installedCliVersion(),
      },
    });
    write("firedrill/baseline.scenario.json", { schemaVersion: 1, id: "baseline", state: starter.state });
    write("firedrill/conformance.suite.json", {
      schemaVersion: 1,
      id: "conformance",
      drills: ["tool-behavior"],
    });
    write("firedrill/agent.target.json", {
      schemaVersion: 1,
      target: {
        id: "conformance-agent",
        kind: "command",
        bindings: ["http"],
        executable: "node",
        arguments: ["test/conformance.mjs"],
        workingDirectory: ".",
        timeoutMs: 10000,
      },
    });
    const counted = (id: string, operationId: string, outcome: string, count: number) => ({
      id,
      kind: "operation.count",
      operation: { packageId: input.id, operationId },
      outcomes: [outcome],
      comparison: { operator: "equals", value: count },
    });
    write("firedrill/tool-behavior.drill.json", {
      schemaVersion: 1,
      id: "tool-behavior",
      title: "Check the Tool's declared behavior",
      targetId: "conformance-agent",
      scenarioId: "baseline",
      actorId: "local-dev",
      task: { instruction: "Exercise every declared operation and error, then verify the resulting state." },
      assertions:
        template === "stateful"
          ? [
              counted("read-existing", "get", "ok", 2),
              counted("wrote-record", "set", "ok", 1),
              counted("missing-record-error", "get", "tool_error", 1),
              {
                id: "record-updated",
                kind: "state.value",
                packageId: input.id,
                namespace: "records",
                rowId: "item",
                path: ["value"],
                comparison: { operator: "equals", value: "updated" },
              },
            ]
          : [counted("echoed-value", "echo", "ok", 1)],
    });
    write("test/conformance.mjs", conformanceTarget(input.id, template));
    write(
      "README.md",
      `# ${packageName}\n\nAn independently owned Firedrill Tool. Source and behavior live in \`firedrill/tools/${input.id}/\`; \`starter.json\` supplies initial synthetic data. The optional test suite lives in \`firedrill/\` and its runner in \`test/conformance.mjs\`. No account, Docker, build step, or contribution to another repository is required.\n\n## Develop\n\nInstall reviewed Firedrill packages (\`@firedrill/cli\` and \`@firedrill/tool-sdk\`) using your package manager. Before packages are published, use the framework's reviewed local archives. Then run:\n\n\`\`\`sh\nnpm run validate\nnpm test\nnpm pack --ignore-scripts\n\`\`\`\n\nThese checks run the ordinary conformance drills twice and compare state and Tool activity. They prove declared coverage and reproducibility, not parity with a real service. Expand them as behavior grows. The package ships its conformance suite so consumers can independently run it using \`firedrill tool test ${input.id}\`.\n\n## Use in another project\n\nInstall this package archive using your package manager with lifecycle scripts disabled, then select its package name:\n\n\`\`\`sh\nfiredrill tool add ${packageName}\nfiredrill serve\n\`\`\`\n\nConsumers can use their own scenarios and test suites; no changes to this package are required. The package's starting license is \`UNLICENSED\`: choose and add your own license before sharing or publishing. You own this Tool and may distribute it from your own repository or registry.\n\n## Safety\n\nTools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep credentials and generated worlds/reports out of the package and repository. The generated package file list excludes \`.firedrill/\`; keep that exclusion when adding assets.\n`,
    );
    const created = [
      ...tool.created,
      "starter.json",
      "package.json",
      "firedrill/baseline.scenario.json",
      "firedrill/conformance.suite.json",
      "firedrill/agent.target.json",
      "firedrill/tool-behavior.drill.json",
      "test/conformance.mjs",
      "README.md",
    ]
      .map((path) => path.split(sep).join("/"))
      .sort();
    if (existsSync(root)) rmdirSync(root);
    renameSync(staging, root);
    return {
      schemaVersion: 1,
      kind: "tool-package-created",
      root,
      toolId: input.id,
      packageName,
      created,
      nextSteps: [
        "Install reviewed @firedrill/cli and @firedrill/tool-sdk packages.",
        "npm run validate",
        "npm test",
        "Choose a license before sharing.",
        "npm pack --ignore-scripts",
      ],
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function conformanceTarget(id: string, template: "stateful" | "stateless"): string {
  return `// A Tool conformance target, not a model-backed agent. Uses only Node's built-in HTTP client.
let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);
const base = process.env.FIREDRILL_HTTP_URL;
const token = process.env.FIREDRILL_HTTP_TOKEN;
if (!base || !token) throw new Error("Firedrill HTTP binding is missing");
async function call(operation, input) {
  const response = await fetch(\`\${base}/v1/operations/${id}/\${operation}\`, {
    method: "POST", headers: { authorization: \`Bearer \${token}\`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: input }),
  });
  const result = await response.json();
  if (!result.outcome) throw new Error(\`Unexpected HTTP status \${response.status}\`);
  return result.outcome;
}
${
  template === "stateful"
    ? `const initial = await call("get", { id: "welcome" });
const written = await call("set", { id: "item", value: "updated" });
const read = await call("get", { id: "item" });
const missing = await call("get", { id: "missing" });
if (initial.status !== "ok" || initial.value.value !== "initial" || written.status !== "ok" || read.value.value !== "updated" || missing.status !== "tool_error" || missing.error.code !== "tool.NOT_FOUND") throw new Error("Unexpected Tool outcome");`
    : `const result = await call("echo", { value: "hello" });
if (result.status !== "ok" || result.value.value !== "hello") throw new Error("Unexpected Tool outcome");`
}
process.stdout.write(JSON.stringify({ completed: true }));
`;
}

function installedCliVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: unknown;
  };
  return SemverSchema.parse(metadata.version);
}
