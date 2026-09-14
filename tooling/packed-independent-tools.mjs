import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverTools, ToolIndexSchema } from "@firedrill/cli/tool-discovery";
import { createLocalWorld, testTool, verifyReport } from "@firedrill/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Copied to an archive-only consumer by check-pack. No workspace source imports.
const consumer = process.cwd();
const cli = fileURLToPath(new URL("bin.js", import.meta.resolve("@firedrill/cli")));
const root = join(consumer, "independent-tool-flow");
mkdirSync(root);
function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_offline: "true", npm_config_ignore_scripts: "true" },
  });
  assert.equal(result.status, 0, `${executable} ${args[0]} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function firedrill(args, cwd = root) {
  return JSON.parse(command(process.execPath, [cli, ...args, "--json"], cwd));
}
const schema = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@firedrill/cli/schema/tool-index.json")), "utf8"),
);
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
const metadataSchema = JSON.parse(
  readFileSync(
    fileURLToPath(import.meta.resolve("@firedrill/compiler/schema/installed-tool-package")),
    "utf8",
  ),
);
assert.ok(metadataSchema.properties.firedrill);

const author = join(root, "author");
firedrill([
  "tool",
  "create",
  "record-book",
  "--package",
  "--name",
  "@independent/record-book",
  "--root",
  author,
]);
assert.equal(firedrill(["validate"], author).status, "success");
assert.equal(firedrill(["tool", "test", "record-book"], author).status, "passed");
assert.ok(!existsSync(join(author, "node_modules")));

const application = join(root, "application");
mkdirSync(application);
const added = firedrill(["init", "--tool", author, "--install"], application);
assert.equal(added.status, "initialized");
assert.deepEqual(JSON.parse(readFileSync(join(application, "firedrill.json"), "utf8")).toolPackages, [
  "@independent/record-book",
]);
assert.ok(readdirSync(join(application, ".firedrill-tools")).some((path) => path.endsWith(".tgz")));
assert.ok(readFileSync(join(application, ".gitignore"), "utf8").includes(".firedrill/"));
const conformance = await testTool({ root: application, toolId: "record-book" });
assert.equal(conformance.status, "passed");
assert.equal(conformance.suiteSource, "package");
for (const run of conformance.runs)
  for (const drill of run.drills)
    for (const trial of drill.trials) await verifyReport({ report: trial.report.directory });

const world = await createLocalWorld({ root: application });
const binding = await world.listen({ protocols: ["http", "mcp"] });
const client = new Client({ name: "independent-package-check", version: "1.0.0" });
try {
  const response = await fetch(`${binding.environment.FIREDRILL_HTTP_URL}/v1/operations/record-book/set`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${binding.environment.FIREDRILL_HTTP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ arguments: { id: "independent", value: "shared state" } }),
  });
  assert.equal((await response.json()).outcome.status, "ok");
  await client.connect(
    new StreamableHTTPClientTransport(new URL(binding.environment.FIREDRILL_MCP_URL), {
      authProvider: { token: async () => binding.environment.FIREDRILL_MCP_TOKEN },
    }),
  );
  const tools = await client.listTools();
  const get = tools.tools.find((tool) => tool.name.endsWith("get"));
  assert.ok(get);
  const read = await client.callTool({ name: get.name, arguments: { id: "independent" } });
  assert.ok(JSON.stringify(read).includes("shared state"));
  world.reset();
  const reset = await client.callTool({ name: get.name, arguments: { id: "independent" } });
  assert.ok(!JSON.stringify(reset).includes("shared state"));
  assert.ok(JSON.stringify(reset).includes("NOT_FOUND"));
} finally {
  await client.close();
  await binding.close();
  world.close();
}

// A new checkout needs only committed source dependencies, not the author's folder.
const movedAuthor = join(root, "moved-author");
renameSync(author, movedAuthor);
const clone = join(root, "clone");
cpSync(application, clone, {
  recursive: true,
  filter: (path) => !path.includes("node_modules") && !path.split(/[\\/]/).includes(".firedrill"),
});
command("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], clone);
assert.equal(firedrill(["tool", "test", "record-book"], clone).suiteSource, "package");

// Pin an independent Git subfolder; advancing its branch must not alter the consumer.
const gitRoot = join(root, "author-repository");
mkdirSync(gitRoot);
cpSync(movedAuthor, join(gitRoot, "packages", "record-book"), {
  recursive: true,
  filter: (path) => !path.split(/[\\/]/).includes(".firedrill"),
});
command("git", ["init", "--quiet"], gitRoot);
command("git", ["add", "."], gitRoot);
command(
  "git",
  [
    "-c",
    "user.name=Tool fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Define independent Tool",
  ],
  gitRoot,
);
const commit = command("git", ["rev-parse", "HEAD"], gitRoot).trim();
const gitConsumer = join(root, "git-consumer");
mkdirSync(gitConsumer);
const gitAdded = firedrill(
  ["tool", "add", `git+${pathToFileURL(gitRoot).href}#${commit}::packages/record-book`, "--install"],
  gitConsumer,
);
assert.ok(gitAdded.installation.resolvedSource.includes(commit));
assert.equal(firedrill(["tool", "test", "record-book"], gitConsumer).status, "passed");
writeFileSync(join(gitRoot, "unrelated-change.txt"), "The branch advanced after the install.\n");
command("git", ["add", "."], gitRoot);
command(
  "git",
  [
    "-c",
    "user.name=Tool fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Advance fixture branch",
  ],
  gitRoot,
);
assert.notEqual(command("git", ["rev-parse", "HEAD"], gitRoot).trim(), commit);
command("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], gitConsumer);
assert.equal(firedrill(["tool", "test", "record-book"], gitConsumer).status, "passed");
const provenance = JSON.parse(readFileSync(join(gitConsumer, gitAdded.installation.provenancePath), "utf8"));
assert.ok(provenance.resolvedSource.includes(commit));

const index = {
  schemaVersion: 1,
  packages: [
    {
      packageName: "@independent/record-book",
      packageVersion: "1.0.0",
      description: "A synthetic record book",
      lifecycle: "active",
      tool: {
        id: "record-book",
        operations: [
          { id: "get", fidelity: "stateful" },
          { id: "set", fidelity: "stateful" },
        ],
      },
    },
  ],
};
assert.equal(ToolIndexSchema.safeParse(index).success, true);
const indexPath = join(root, "index.json");
writeFileSync(indexPath, JSON.stringify(index));
const discovered = await discoverTools({ root: application, index: indexPath });
assert.equal(discovered.tools[0].packageName, "@independent/record-book");
assert.equal(discovered.tools[0].installed, true);
assert.equal(firedrill(["tool", "list", "--index", indexPath]).total, 1);
writeFileSync(indexPath, JSON.stringify({ ...index, schemaVersion: 99 }));
await assert.rejects(
  discoverTools({ root: application, index: indexPath }),
  (error) => error.code === "framework.TOOL_INDEX_INVALID",
);

// Our maintained packs use the same installed-package conformance path.
const maintained = join(root, "maintained");
mkdirSync(maintained);
for (const id of ["work-queue", "github-issues", "mailbox", "object-storage"]) {
  firedrill(["tool", "add", `@firedrill/tool-${id}`], maintained);
  const result = firedrill(["tool", "test", id], maintained);
  assert.equal(result.status, "passed");
  assert.equal(result.suiteSource, "package");
}
rmSync(root, { recursive: true, force: true });
process.stdout.write(
  "Independent Tool author/install/Git/pinning/HTTP/MCP/reset/conformance/index and maintained-package flows passed.\n",
);
