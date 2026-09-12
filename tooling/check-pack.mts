import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packPublicPackages } from "./public-packages.mts";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "firedrill-pack-"));

function run(command: string, arguments_: string[], cwd: string): void {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(directory);
  return files;
}

function assertSameTree(expectedRoot: string, actualRoot: string, label: string): void {
  const relativeFiles = (root: string) =>
    filesUnder(root)
      .map((file) => file.slice(root.length + 1))
      .sort();
  const expectedFiles = relativeFiles(expectedRoot);
  const actualFiles = relativeFiles(actualRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${label} file set differs from its canonical source\nexpected: ${expectedFiles.join(", ")}\nactual: ${actualFiles.join(", ")}`,
    );
  }
  for (const relativeFile of expectedFiles) {
    const expected = readFileSync(join(expectedRoot, relativeFile));
    const actual = readFileSync(join(actualRoot, relativeFile));
    if (!actual.equals(expected)) {
      throw new Error(`${label} differs from its canonical source: ${relativeFile}`);
    }
  }
}

function inspectArchive(archivePath: string, name: string): void {
  const packedManifest = spawnSync("tar", ["-xOf", archivePath, "package/package.json"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (packedManifest.status !== 0) throw new Error(packedManifest.stderr);
  const manifestText = packedManifest.stdout;
  if (manifestText.includes("firedrill-platform") || manifestText.includes("/Users/")) {
    throw new Error(`${name} packed manifest leaks a private repository or local absolute path`);
  }
  const packageManifest = JSON.parse(manifestText) as {
    private?: boolean;
    license?: string;
    sideEffects?: boolean;
    engines?: { node?: string };
    publishConfig?: { access?: string };
  };
  if (packageManifest.private === true) throw new Error(`${name} is marked private`);
  if (packageManifest.license !== "Apache-2.0") throw new Error(`${name} has the wrong license`);
  if (packageManifest.sideEffects !== false) throw new Error(`${name} must declare sideEffects: false`);
  if (packageManifest.engines?.node !== ">=20.19") throw new Error(`${name} has no supported Node range`);
  if (packageManifest.publishConfig?.access !== "public") throw new Error(`${name} is not public-scoped`);
  if (manifestText.includes("workspace:")) throw new Error(`${name} retains a workspace dependency`);

  const unpacked = join(temporary, `unpacked-${name.replaceAll("/", "-")}`);
  mkdirSync(unpacked);
  run("tar", ["-xzf", archivePath, "-C", unpacked], temporary);
  const packedFiles = filesUnder(unpacked);
  const license = packedFiles.find((file) => file.endsWith("/dist/LICENSE"));
  if (!license || !readFileSync(license, "utf8").includes("Apache License")) {
    throw new Error(`${name} does not contain the Apache-2.0 license text`);
  }
  const notice = packedFiles.find((file) => file.endsWith("/dist/NOTICE"));
  if (!notice || !readFileSync(notice, "utf8").includes("Copyright 2026 Reload Tech Inc.")) {
    throw new Error(`${name} does not contain NOTICE`);
  }
  for (const file of packedFiles) {
    const text = readFileSync(file, "utf8");
    if (text.includes("firedrill-platform") || text.includes("/Users/")) {
      throw new Error(`${name} leaks a private repository or local path: ${file}`);
    }
  }
  if (name === "@firedrill/agent" && !packedFiles.some((file) => file.endsWith("/dist/skill/SKILL.md"))) {
    throw new Error("@firedrill/agent does not contain the canonical bundled skill");
  }
  if (name === "@firedrill/agent" && !packedFiles.some((file) => file.endsWith("/THIRD_PARTY.md"))) {
    throw new Error("@firedrill/agent does not contain its third-party terms notice");
  }
}

try {
  const publishable = packPublicPackages({ repositoryRoot: root, outputDirectory: temporary });
  const reproduced = packPublicPackages({
    repositoryRoot: root,
    outputDirectory: join(temporary, "reproduced"),
  });
  if (
    JSON.stringify(
      publishable.map(({ name, version, archive, sha256 }) => ({ name, version, archive, sha256 })),
    ) !==
    JSON.stringify(
      reproduced.map(({ name, version, archive, sha256 }) => ({ name, version, archive, sha256 })),
    )
  ) {
    throw new Error("public package archives are not byte-for-byte reproducible");
  }
  const archives = new Map(publishable.map((package_) => [package_.name, join(temporary, package_.archive)]));
  const publint = join(root, "node_modules", ".bin", "publint");
  const typesWrong = join(root, "node_modules", ".bin", "attw");
  for (const package_ of publishable) {
    const archive = join(temporary, package_.archive);
    inspectArchive(archive, package_.name);
    run(publint, [archive, "--strict"], root);
    run(typesWrong, [archive, "--profile", "esm-only", "--quiet"], root);
  }

  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "firedrill-pack-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries([...archives].map(([name, archivePath]) => [name, `file:${archivePath}`])),
          "@modelcontextprotocol/client": "2.0.0",
        },
        pnpm: {
          overrides: Object.fromEntries(
            [...archives].map(([name, archivePath]) => [name, `file:${archivePath}`]),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumer, "index.mjs"),
    [
      'import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      'import { spawn, spawnSync } from "node:child_process";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { evaluateAssertions } from "@firedrill/assertions";',
      'import { createFiredrillAuthoringTools, runFiredrillAgent } from "@firedrill/agent";',
      'import { compileWorld } from "@firedrill/compiler";',
      'import { createDrillWorld } from "@firedrill/drills";',
      'import { startLocalInspector } from "@firedrill/inspector";',
      'import { invokeCliWorldOperation, listCliWorldTools, startCliWorldBinding } from "@firedrill/protocol-cli";',
      'import { startHttpWorldBinding } from "@firedrill/protocol-http";',
      'import { mcpToolName, startMcpWorldBinding } from "@firedrill/protocol-mcp";',
      'import { createLocalWorld, runDrills, verifyReport } from "@firedrill/sdk";',
      'import { mockTool } from "@firedrill/sdk/testing";',
      'import { startLocalSimulationServer } from "@firedrill/simulation";',
      'import { defineTool } from "@firedrill/tool-sdk";',
      'import { loadWorldBuild } from "@firedrill/world-build";',
      'import { SqliteWorldStore } from "@firedrill/world-store-sqlite";',
      'import { WorldKernel } from "@firedrill/world-kernel";',
      'import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";',
      'const directory = mkdtempSync(join(tmpdir(), "firedrill-packed-consumer-"));',
      'const runChild = (command, arguments_, options = {}) => new Promise((resolve_, reject) => { const child = spawn(command, arguments_, { ...options, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.once("error", reject); child.once("close", (code) => resolve_({ code, stdout, stderr })); });',
      "const tool = defineTool({",
      '  manifest: { schemaVersion: 1, id: "counter", version: "1.0.0", engine: ">=0.1.0 <0.2.0",',
      '    capabilities: ["state.read", "state.write"], state: [{ namespace: "values", schema: { type: "object" } }], operations: [',
      '      { id: "value.increment", inputSchema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } }, additionalProperties: false }, idempotency: "required", fidelity: "stateful" },',
      '      { id: "value.read", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } }, additionalProperties: false }, idempotency: "none", fidelity: "stateful" }',
      "    ] },",
      "  operations: {",
      '    "value.increment": (input, context) => { const value = Number(context.state.get("values", "main")?.value ?? 0) + Number(input.amount); context.state.put("values", "main", { value }); return { value }; },',
      '    "value.read": (_input, context) => context.state.get("values", "main") ?? { value: 0 }',
      "  }",
      "});",
      'const store = SqliteWorldStore.create({ filePath: join(directory, "world.sqlite"), worldInstanceId: "world_packed01", buildHash: "sha256:" + "a".repeat(64), packageLockHash: "sha256:" + "b".repeat(64), seed: "7", virtualTimeUs: 0, correlationId: "corr_create01", actors: [{ bindingId: "actor_packed01", actorId: "developer", grants: [{ packageId: "counter", operationId: "value.increment" }, { packageId: "counter", operationId: "value.read" }] }] });',
      "try {",
      '  const kernel = new WorldKernel({ store, packageLockHash: "sha256:" + "b".repeat(64), tools: [tool] });',
      '  const changed = kernel.invoke({ schemaVersion: 1, callId: "call_packed01", correlationId: "corr_packed01", operation: { packageId: "counter", operationId: "value.increment" }, actorBindingId: "actor_packed01", arguments: { amount: 3 }, idempotencyKey: "increment-1" });',
      '  const read = kernel.invoke({ schemaVersion: 1, callId: "call_packed02", correlationId: "corr_packed02", operation: { packageId: "counter", operationId: "value.read" }, actorBindingId: "actor_packed01", arguments: {} });',
      '  if (changed.outcome.status !== "ok" || read.outcome.status !== "ok" || read.outcome.value.value !== 3 || store.readEvidence().length < 3) process.exitCode = 1;',
      "} finally { store.close(); rmSync(directory, { force: true, recursive: true }); }",
      'const repository = join(process.cwd(), "packed-source");',
      "try {",
      "  mkdirSync(repository, { recursive: true });",
      '  mkdirSync(join(repository, "world"), { recursive: true });',
      '  mkdirSync(join(repository, "test-support"), { recursive: true });',
      '  writeFileSync(join(repository, "firedrill.json"), JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }));',
      '  writeFileSync(join(repository, "world", "world.json"), JSON.stringify({ schemaVersion: 1, id: "packed-world", seed: "8", actors: [{ id: "operator", grants: [{ packageId: "packed-tool", operationId: "records.put" }] }, { id: "reviewer", grants: [{ packageId: "packed-tool", operationId: "records.put" }] }], state: [{ action: "upsert", packageId: "packed-tool", namespace: "records", rowId: "one", value: { count: 0 } }] }));',
      '  writeFileSync(join(repository, "world", "packed.tool.json"), JSON.stringify({ schemaVersion: 1, module: "./packed-tool.js", manifest: { schemaVersion: 1, id: "packed-tool", version: "1.0.0", engine: ">=0.1.0 <0.2.0", capabilities: ["clock.read", "clock.schedule", "event.emit", "state.read", "state.write"], state: [{ namespace: "records", schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }], operations: [{ id: "records.put", inputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }, idempotency: "required", fidelity: "stateful" }], events: [{ id: "record.changed", payloadSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }, { id: "record.check", payloadSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }], http: [{ id: "put-record", operationId: "records.put", method: "PUT", path: "/api/records/{recordId}", auth: { kind: "header", name: "x-api-key" }, requestBody: "json", response: { successStatus: 200, errors: [] } }] } }));',
      '  writeFileSync(join(repository, "world", "packed-tool.js"), `export default { operations: { "records.put": (input, context) => { const value = { count: Number(input.count) }; context.state.put("records", "one", value); context.events.emit("record.changed", value); context.events.scheduleAt("record.check", value, context.clock.nowUs() + 7200000000); return value; } }, http: { "put-record": { decode: (request) => ({ arguments: { count: Number(request.body.kind === "json" && request.body.value && typeof request.body.value === "object" && !Array.isArray(request.body.value) ? request.body.value.count : Number.NaN) }, idempotencyKey: request.headers["idempotency-key"]?.[0] }), encode: ({ outcome }) => ({ body: outcome.status === "ok" ? { kind: "json", value: { stored: outcome.value.count } } : { kind: "json", value: { error: outcome.error.message } } }) } } };`);',
      '  writeFileSync(join(repository, "world", "audit.tool.json"), JSON.stringify({ schemaVersion: 1, module: "./audit-tool.js", manifest: { schemaVersion: 1, id: "audit-tool", version: "1.0.0", engine: ">=0.1.0 <0.2.0", capabilities: ["state.read", "state.write"], state: [{ namespace: "checks", schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }, { namespace: "entries", schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }], operations: [{ id: "entries.read", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }, idempotency: "none", fidelity: "stateful" }], subscriptions: [{ id: "capture-record-change", event: { packageId: "packed-tool", eventId: "record.changed" } }, { id: "capture-record-check", event: { packageId: "packed-tool", eventId: "record.check" } }] } }));',
      '  writeFileSync(join(repository, "world", "audit-tool.js"), `export default { operations: { "entries.read": (_input, context) => context.state.get("entries", "latest") ?? { count: 0 } }, subscriptions: { "capture-record-change": (payload, context) => context.state.put("entries", "latest", { count: Number(payload.count) }), "capture-record-check": (payload, context) => context.state.put("checks", "check-" + String(payload.count), { count: Number(payload.count) }) } };`);',
      '  writeFileSync(join(repository, "world", "default.scenario.json"), JSON.stringify({ schemaVersion: 1, id: "default-state" }));',
      '  const faultDeclarationPath = join(repository, "world", "packed.tool.json"); const faultDeclaration = JSON.parse(readFileSync(faultDeclarationPath, "utf8")); faultDeclaration.manifest.operations[0].declaredErrors = ["UNAVAILABLE"]; faultDeclaration.manifest.faults = [{ id: "unavailable", appliesTo: ["records.put"], timing: "before", error: { code: "UNAVAILABLE", message: "Record storage unavailable", retryable: true } }]; faultDeclaration.manifest.http[0].response.errors = [{ code: "UNAVAILABLE", status: 503 }]; writeFileSync(faultDeclarationPath, JSON.stringify(faultDeclaration));',
      '  writeFileSync(join(repository, "world", "consumer.target.json"), JSON.stringify({ schemaVersion: 1, target: { id: "consumer-agent", kind: "external", bindings: ["mcp"], timeoutMs: 30000 } }));',
      '  writeFileSync(join(repository, "world", "put-record.drill.json"), JSON.stringify({ schemaVersion: 1, id: "put-record", targetId: "consumer-agent", actorId: "operator", scenarioId: "default-state", task: { instruction: "Set the record count." }, assertions: [{ id: "record-updated", kind: "state.value", packageId: "packed-tool", namespace: "records", rowId: "one", path: ["count"], comparison: { operator: "equals", value: 9 } }, { id: "audit-updated", kind: "state.value", packageId: "audit-tool", namespace: "entries", rowId: "latest", path: ["count"], comparison: { operator: "equals", value: 9 } }] }));',
      '  writeFileSync(join(repository, "world", "setup-only.drill.json"), JSON.stringify({ schemaVersion: 1, id: "setup-only", targetId: "consumer-agent", actorId: "operator", scenarioId: "default-state", task: { instruction: "Inspect the prepared world without changing it." }, assertions: [{ id: "injected-record-visible", kind: "state.value", packageId: "packed-tool", namespace: "records", rowId: "one", path: ["count"], comparison: { operator: "equals", value: 5 } }] }));',
      '  writeFileSync(join(repository, "world", "package-setup.drill.json"), JSON.stringify({ schemaVersion: 1, id: "package-setup", targetId: "consumer-agent", actorId: "operator", scenarioId: "default-state", task: { instruction: "Claim and complete the prepared work item." }, assertions: [{ id: "base-tool-not-called", kind: "operation.count", operation: { packageId: "packed-tool", operationId: "records.put" }, comparison: { operator: "equals", value: 0 } }] }));',
      '  writeFileSync(join(repository, "test-support", "packed-override.js"), `export default { operations: { "records.put": (input, context) => { const value = { count: Number(input.count) + 1 }; context.state.put("records", "one", value); context.events.emit("record.changed", value); context.events.scheduleAt("record.check", value, context.clock.nowUs() + 7200000000); return value; } }, http: { "put-record": { decode: (request) => ({ arguments: { count: Number(request.body.kind === "json" && request.body.value && typeof request.body.value === "object" && !Array.isArray(request.body.value) ? request.body.value.count : Number.NaN) }, idempotencyKey: request.headers["idempotency-key"]?.[0] }), encode: ({ outcome }) => ({ body: outcome.status === "ok" ? { kind: "json", value: { stored: outcome.value.count } } : { kind: "json", value: { error: outcome.error.message } } }) } } };`);',
      '  writeFileSync(join(repository, "world", "timed-workload.drill.json"), JSON.stringify({ schemaVersion: 1, id: "timed-workload", targetId: "consumer-agent", scenarioId: "default-state", timeline: { horizonUs: 21600000000, maxEvents: 10, stopOnInvariantFailure: true, interactions: [{ id: "initial-update", afterStartUs: 0, actorId: "operator", task: { instruction: "Set the first value.", input: { count: 1 } } }, { id: "review-update", afterStartUs: 14400000000, actorId: "reviewer", task: { instruction: "Set the reviewed value.", input: { count: 2 } } }], invariants: [{ id: "checks-bounded", kind: "state.count", packageId: "audit-tool", namespace: "checks", comparison: { operator: "less_than_or_equal", value: 2 } }] }, assertions: [{ id: "final-value", kind: "state.value", packageId: "packed-tool", namespace: "records", rowId: "one", path: ["count"], comparison: { operator: "equals", value: 2 } }, { id: "two-checks", kind: "state.count", packageId: "audit-tool", namespace: "checks", comparison: { operator: "equals", value: 2 } }, { id: "two-agent-actions", kind: "operation.count", operation: { packageId: "packed-tool", operationId: "records.put" }, comparison: { operator: "equals", value: 2 } }] }));',
      '  writeFileSync(join(repository, "world", "timed-failure.drill.json"), JSON.stringify({ schemaVersion: 1, id: "timed-failure", targetId: "consumer-agent", scenarioId: "default-state", timeline: { horizonUs: 21600000000, maxEvents: 10, stopOnInvariantFailure: true, interactions: [{ id: "initial-update", afterStartUs: 0, actorId: "operator", task: { instruction: "Set the first value.", input: { count: 1 } } }, { id: "blocked-follow-up", afterStartUs: 14400000000, actorId: "reviewer", task: { instruction: "This must not run after the invariant fails.", input: { count: 2 } } }], invariants: [{ id: "no-check-fired", kind: "state.count", packageId: "audit-tool", namespace: "checks", comparison: { operator: "equals", value: 0 } }] }, assertions: [{ id: "one-agent-action", kind: "operation.count", operation: { packageId: "packed-tool", operationId: "records.put" }, comparison: { operator: "equals", value: 1 } }] }));',
      '  writeFileSync(join(repository, "world", "command.target.json"), JSON.stringify({ schemaVersion: 1, target: { id: "command-agent", kind: "command", bindings: ["http"], executable: "node", arguments: ["agent.mjs"], workingDirectory: ".", timeoutMs: 30000 } }));',
      '  writeFileSync(join(repository, "world", "cli-put-record.drill.json"), JSON.stringify({ schemaVersion: 1, id: "cli-put-record", targetId: "command-agent", actorId: "operator", scenarioId: "default-state", task: { instruction: "Set the record count from the CLI." }, assertions: [{ id: "cli-record-updated", kind: "state.value", packageId: "packed-tool", namespace: "records", rowId: "one", path: ["count"], comparison: { operator: "equals", value: 6 } }, { id: "cli-audit-updated", kind: "state.value", packageId: "audit-tool", namespace: "entries", rowId: "latest", path: ["count"], comparison: { operator: "equals", value: 6 } }] }));',
      '  writeFileSync(join(repository, "agent.mjs"), `let input = ""; for await (const chunk of process.stdin) input += chunk; const invocation = JSON.parse(input); const response = await fetch(process.env.FIREDRILL_HTTP_URL + "/api/records/one", { method: "PUT", headers: { "x-api-key": process.env.FIREDRILL_HTTP_TOKEN, "idempotency-key": invocation.runId + "-" + invocation.interactionId, "content-type": "application/json" }, body: JSON.stringify({ count: 6 }) }); const result = await response.json(); if (!response.ok) { process.stderr.write(JSON.stringify(result)); process.exit(1); } process.stdout.write(JSON.stringify({ stored: result.stored }));`);',
      '  const cli = spawnSync(join(process.cwd(), "node_modules", ".bin", "firedrill"), ["validate", "--json", "--root", repository], { encoding: "utf8" });',
      '  if (cli.status !== 0 || JSON.parse(cli.stdout).status !== "success") throw new Error("packed CLI failed: " + cli.stdout + cli.stderr);',
      '  const cliRun = spawnSync(join(process.cwd(), "node_modules", ".bin", "firedrill"), ["run", "cli-put-record", "--json", "--root", repository], { encoding: "utf8", timeout: 30000 });',
      "  const cliRunOutput = cliRun.stdout ? JSON.parse(cliRun.stdout) : null;",
      '  if (cliRun.status !== 0 || cliRunOutput?.verdict !== "passed" || !existsSync(cliRunOutput.drills?.[0]?.trials?.[0]?.htmlReport)) throw new Error("packed CLI run failed: " + cliRun.stdout + cliRun.stderr);',
      '  const cliReportDirectory = cliRunOutput.drills?.[0]?.trials?.[0]?.reportDirectory; if (!cliReportDirectory) throw new Error("packed CLI returned no report directory");',
      '  const cliVerify = spawnSync(join(process.cwd(), "node_modules", ".bin", "firedrill"), ["report", "verify", cliReportDirectory, "--json"], { encoding: "utf8" });',
      '  if (cliVerify.status !== 0 || JSON.parse(cliVerify.stdout).status !== "verified") throw new Error("packed CLI report verification failed: " + cliVerify.stdout + cliVerify.stderr);',
      '  const simulation = await startLocalSimulationServer({ root: repository, token: "packed-simulation-token-000001" });',
      "  try {",
      '    const simulationHeaders = { authorization: "Bearer " + simulation.token };',
      '    const projectResponse = await fetch(simulation.baseUrl + "/api/v1/project", { headers: simulationHeaders }); const projectView = await projectResponse.json(); if (!projectResponse.ok || projectView.world.id !== "packed-world" || !projectView.drills.some((item) => item.id === "cli-put-record")) throw new Error("packed simulation project projection failed");',
      '    const sourceResponse = await fetch(simulation.baseUrl + "/api/v1/sources/world/packed-world", { headers: simulationHeaders }); const sourceView = await sourceResponse.json(); if (!sourceResponse.ok || sourceView.path !== "world/world.json" || !sourceView.content.includes("packed-world")) throw new Error("packed simulation source projection failed");',
      '    const startResponse = await fetch(simulation.baseUrl + "/api/v1/runs", { method: "POST", headers: { ...simulationHeaders, "content-type": "application/json" }, body: JSON.stringify({ drillId: "cli-put-record", seed: "61" }) }); const started = await startResponse.json(); if (startResponse.status !== 202) throw new Error("packed simulation run did not start: " + JSON.stringify(started));',
      '    let completed; for (let index = 0; index < 200; index += 1) { const response = await fetch(simulation.baseUrl + "/api/v1/run-requests/" + started.requestId, { headers: simulationHeaders }); const value = await response.json(); if (["completed", "failed", "cancelled"].includes(value.status)) { completed = value; break; } await new Promise((resolve) => setTimeout(resolve, 10)); }',
      '    if (completed?.status !== "completed" || completed.verdict !== "passed" || completed.runIds.length !== 1) throw new Error("packed simulation run did not pass: " + JSON.stringify(completed));',
      '    const runResponse = await fetch(simulation.baseUrl + "/api/v1/runs/" + completed.runIds[0], { headers: simulationHeaders }); const runView = await runResponse.json(); if (!runResponse.ok || runView.summary.runId !== completed.runIds[0] || runView.summary.verdict !== "passed" || !runView.summary.reportAvailable) throw new Error("packed simulation run projection failed");',
      '    const stateResponse = await fetch(simulation.baseUrl + "/api/v1/runs/" + completed.runIds[0] + "/state?packageId=packed-tool&namespace=records", { headers: simulationHeaders }); const stateView = await stateResponse.json(); if (!stateResponse.ok || stateView.records[0]?.value.count !== 6) throw new Error("packed simulation state projection failed");',
      '    const repeatResponse = await fetch(simulation.baseUrl + "/api/v1/runs", { method: "POST", headers: { ...simulationHeaders, "content-type": "application/json" }, body: JSON.stringify({ drillId: "cli-put-record", seed: "61" }) }); const repeatStarted = await repeatResponse.json(); if (repeatResponse.status !== 202) throw new Error("packed simulation repeat did not start");',
      '    let repeatCompleted; for (let index = 0; index < 200; index += 1) { const response = await fetch(simulation.baseUrl + "/api/v1/run-requests/" + repeatStarted.requestId, { headers: simulationHeaders }); const value = await response.json(); if (["completed", "failed", "cancelled"].includes(value.status)) { repeatCompleted = value; break; } await new Promise((resolve) => setTimeout(resolve, 10)); }',
      '    if (repeatCompleted?.status !== "completed" || repeatCompleted.verdict !== "passed" || repeatCompleted.runIds.length !== 1) throw new Error("packed simulation repeat did not pass");',
      '    const compareResponse = await fetch(simulation.baseUrl + "/api/v1/comparisons", { method: "POST", headers: { ...simulationHeaders, "content-type": "application/json" }, body: JSON.stringify({ baselineRunId: completed.runIds[0], candidateRunId: repeatCompleted.runIds[0] }) }); const comparison = await compareResponse.json(); if (!compareResponse.ok || comparison.compatibility.status !== "exact_inputs" || comparison.outcome !== "unchanged" || comparison.baseline.reportDirectory !== undefined || comparison.candidate.reportDirectory !== undefined) throw new Error("packed simulation comparison failed: " + JSON.stringify(comparison));',
      "  } finally { await simulation.close(); }",
      "  const inspector = await startLocalInspector({ root: repository });",
      "  try {",
      '    const inspectorPageResponse = await fetch(inspector.url + "/world"); const inspectorPage = await inspectorPageResponse.text(); if (!inspectorPageResponse.ok || !inspectorPage.includes("firedrill-token") || inspectorPage.includes("__FIREDRILL_TOKEN__")) throw new Error("packed inspector page failed");',
      '    const inspectorToken = /name="firedrill-token" content="([^"]+)"/.exec(inspectorPage)?.[1]; if (!inspectorToken) throw new Error("packed inspector did not inject a local token");',
      '    const inspectorProjectResponse = await fetch(inspector.url + "/api/v1/project", { headers: { authorization: "Bearer " + inspectorToken } }); const inspectorProject = await inspectorProjectResponse.json(); if (!inspectorProjectResponse.ok || inspectorProject.world.id !== "packed-world") throw new Error("packed inspector API failed");',
      '    const inspectorSourceResponse = await fetch(inspector.url + "/api/v1/sources/drill/cli-put-record", { headers: { authorization: "Bearer " + inspectorToken } }); const inspectorSource = await inspectorSourceResponse.json(); if (!inspectorSourceResponse.ok || inspectorSource.path !== "world/cli-put-record.drill.json" || !inspectorSource.content.includes("cli-put-record")) throw new Error("packed inspector source viewer API failed");',
      "    const inspectorAssetPath = inspectorPage.split('src=\"')[1]?.split('\"')[0]; if (!inspectorAssetPath?.startsWith('/assets/') || !inspectorAssetPath.endsWith('.js') || !(await fetch(inspector.url + inspectorAssetPath)).ok) throw new Error('packed inspector client asset failed');",
      "  } finally { await inspector.close(); }",
      '  const invalidCli = spawnSync(join(process.cwd(), "node_modules", ".bin", "firedrill"), ["--not-an-option", "--json"], { encoding: "utf8" });',
      '  if (invalidCli.status !== 2 || invalidCli.stderr !== "" || JSON.parse(invalidCli.stdout).code !== "framework.INVALID_ARGUMENT") throw new Error("packed CLI JSON usage failure is unstable: " + invalidCli.stdout + invalidCli.stderr);',
      "  const compiled = await compileWorld({ repositoryRoot: repository });",
      '  if (compiled.status !== "success" || compiled.build.buildDirectory === undefined) throw new Error("packed compiler failed: " + JSON.stringify(compiled.diagnostics));',
      "  const loaded = await loadWorldBuild(compiled.build.buildDirectory);",
      '  if (loaded.status !== "success") throw new Error("packed loader failed: " + JSON.stringify(loaded.diagnostics));',
      '  const local = createDrillWorld({ build: loaded.build, drillId: "put-record", filePath: join(repository, "world.sqlite"), worldInstanceId: "world_packed02", correlationId: "corr_create02" });',
      "  try {",
      '    const localActor = local.materialized.actors.find((actor) => actor.actorId === "operator"); if (!localActor) throw new Error("packed actor missing");',
      '    const localClient = local.clients.get("operator"); if (!localClient) throw new Error("packed client missing");',
      '    const result = local.kernel.invoke({ schemaVersion: 1, callId: "call_packed03", correlationId: "corr_packed03", operation: { packageId: "packed-tool", operationId: "records.put" }, actorBindingId: localActor.bindingId, arguments: { count: 9 }, idempotencyKey: "put-9" });',
      '    if (result.outcome.status !== "ok" || local.store.readState("packed-tool", "records", "one")?.value.count !== 9 || local.store.readState("audit-tool", "entries", "latest")?.value.count !== 9) process.exitCode = 1;',
      "    const assertions = evaluateAssertions({ assertions: local.materialized.drill.assertions, state: local.store, evidence: local.store.readEvidence() });",
      '    if (assertions.length !== 2 || assertions.some((assertion) => assertion.status !== "passed" || assertion.actual !== 9)) process.exitCode = 1;',
      "    const manifests = loaded.build.tools.map((item) => item.manifest);",
      '    const http = await startHttpWorldBinding({ client: localClient, tools: loaded.build.tools, token: "packed-http-token-000001" });',
      "    try {",
      '      const response = await fetch(http.baseUrl + "/api/records/one", { method: "PUT", headers: { "x-api-key": http.token, "idempotency-key": "put-10", "content-type": "application/json" }, body: JSON.stringify({ count: 10 }) });',
      "      const body = await response.json();",
      "      if (!response.ok || body.stored !== 10) process.exitCode = 1;",
      "    } finally { await http.close(); }",
      '    const mcpBinding = await startMcpWorldBinding({ client: localClient, tools: manifests, token: "packed-mcp-token-0000001" });',
      '    const mcp = new Client({ name: "packed-consumer", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });',
      "    try {",
      "      await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpBinding.url), { authProvider: { token: async () => mcpBinding.token } }));",
      '      const called = await mcp.callTool({ name: mcpToolName("packed-tool", "records.put"), arguments: { count: 11 }, _meta: { "dev.firedrill/idempotency-key": "put-11" } });',
      '      if (called.isError || called.structuredContent?.count !== 11 || local.store.readState("packed-tool", "records", "one")?.value.count !== 11) process.exitCode = 1;',
      "    } finally { await mcp.close(); await mcpBinding.close(); }",
      '    const cliBinding = await startCliWorldBinding({ client: localClient, tools: loaded.build.tools, token: "packed-cli-token-0000001" });',
      "    try {",
      '      const listed = await listCliWorldTools({ connection: cliBinding }); if (listed.length !== 2 || !listed.some((item) => item.id === "packed-tool")) process.exitCode = 1;',
      '      const directCli = await invokeCliWorldOperation({ packageId: "packed-tool", operationId: "records.put", arguments: { count: 12 }, idempotencyKey: "put-12", connection: cliBinding }); if (directCli.outcome.status !== "ok" || directCli.outcome.value.count !== 12) process.exitCode = 1;',
      '      const installedCli = join(process.cwd(), "node_modules", ".bin", "firedrill");',
      '      const cliListed = await runChild(installedCli, ["world", "tools", "--json"], { env: { ...process.env, ...cliBinding.environment } }); if (cliListed.code !== 0 || !JSON.parse(cliListed.stdout).tools.some((item) => item.id === "packed-tool")) throw new Error("packed CLI Tool discovery failed: " + cliListed.stdout + cliListed.stderr);',
      '      const cliCalled = await runChild(installedCli, ["world", "call", "packed-tool", "records.put", "--input", "{\\"count\\":13}", "--idempotency-key", "put-13", "--json"], { env: { ...process.env, ...cliBinding.environment } }); const cliCallResult = cliCalled.stdout ? JSON.parse(cliCalled.stdout) : null; if (cliCalled.code !== 0 || cliCallResult?.outcome?.status !== "ok" || local.store.readState("packed-tool", "records", "one")?.value.count !== 13) throw new Error("packed CLI operation failed: " + cliCalled.stdout + cliCalled.stderr);',
      "    } finally { await cliBinding.close(); }",
      "  } finally { local.store.close(); }",
      '  const controlled = await createLocalWorld({ root: repository, drill: "put-record", seed: "57" });',
      "  try {",
      '    const fault = { packageId: "packed-tool", faultId: "unavailable" }; const activated = controlled.setFault({ ...fault, active: true }); if (!activated.changed || activated.evidence[0]?.kind !== "fault_control" || controlled.faults().length !== 1) throw new Error("packed fault activation lost its state/evidence");',
      '    const faultCall = controlled.call({ actorId: "operator", packageId: "packed-tool", operationId: "records.put", arguments: { count: 99 }, idempotencyKey: "controlled-faulted" }); if (faultCall.outcome.status !== "tool_error" || faultCall.outcome.error.code !== "tool.UNAVAILABLE" || controlled.state({ packageId: "packed-tool", namespace: "records" })[0]?.value.count !== 0) throw new Error("packed declared fault did not block the mutation");',
      '    if (!controlled.setFault({ ...fault, active: false }).changed || controlled.faults().length !== 0) throw new Error("packed fault deactivation failed");',
      '    const controlledCall = controlled.call({ actorId: "operator", packageId: "packed-tool", operationId: "records.put", arguments: { count: 14 }, idempotencyKey: "controlled-put-14" });',
      '    if (controlledCall.outcome.status !== "ok" || controlled.state({ packageId: "packed-tool", namespace: "records" })[0]?.value.count !== 14 || controlled.state({ packageId: "audit-tool", namespace: "entries" })[0]?.value.count !== 14) throw new Error("packed high-level local world call failed");',
      '    const scopedReset = controlled.reset({ packages: ["packed-tool"] });',
      '    if (scopedReset.scope !== "packages" || controlled.state({ packageId: "packed-tool", namespace: "records" })[0]?.value.count !== 0 || controlled.state({ packageId: "audit-tool", namespace: "entries" })[0]?.value.count !== 14) throw new Error("packed high-level scoped reset failed");',
      "    const fullReset = controlled.reset();",
      '    if (fullReset.scope !== "world" || controlled.metadata().virtualTimeUs !== 0 || controlled.state({ packageId: "packed-tool", namespace: "records" })[0]?.value.count !== 0 || controlled.state({ packageId: "audit-tool", namespace: "entries" }).length !== 0) throw new Error("packed high-level full reset failed");',
      "  } finally { controlled.close(); }",
      "  const drill = await runDrills({",
      '    root: repository, drill: "put-record", runDirectory: "runs", reportDirectory: "report",',
      "    agent: async ({ binding }) => {",
      '      const runnerMcp = new Client({ name: "packed-runner", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });',
      "      await runnerMcp.connect(new StreamableHTTPClientTransport(new URL(binding.environment.FIREDRILL_MCP_URL), { authProvider: { token: async () => binding.environment.FIREDRILL_MCP_TOKEN } }));",
      "      try {",
      '        const result = await runnerMcp.callTool({ name: mcpToolName("packed-tool", "records.put"), arguments: { count: 9 }, _meta: { "dev.firedrill/idempotency-key": "runner-put-9" } });',
      "        return { isError: result.isError ?? false, output: result.structuredContent ?? null };",
      "      } finally { await runnerMcp.close(); }",
      "    }",
      "  });",
      '  if (drill.verdict !== "passed" || drill.drills[0]?.trials.length !== 1) process.exitCode = 1;',
      '  const trial = drill.drills[0]?.trials[0]; if (!trial) throw new Error("packed SDK returned no trial");',
      "  if (!existsSync(trial.worldFilePath) || !existsSync(trial.report.files.html) || !existsSync(trial.report.files.json) || !existsSync(trial.report.files.junit) || trial.report.manifest.reproduction.buildHash !== loaded.build.manifest.buildHash || trial.evidence.length === 0) process.exitCode = 1;",
      "  const verifiedReport = verifyReport({ report: trial.report.directory }); if (verifiedReport.manifest.runId !== trial.result.identity.runId) process.exitCode = 1;",
      '  const injectedData = await runDrills({ root: repository, drill: "setup-only", setup: { scenario: { state: [{ action: "upsert", packageId: "packed-tool", namespace: "records", rowId: "one", value: { count: 5 } }] } }, agent: () => ({ inspected: true }) });',
      '  const injectedDataTrial = injectedData.drills[0]?.trials[0]; if (injectedData.verdict !== "passed" || !injectedData.setup || injectedDataTrial?.result.identity.setupHash !== injectedData.setup.setupHash || verifyReport({ report: injectedDataTrial?.report.directory ?? "" }).result.identity.setupHash !== injectedData.setup.setupHash) throw new Error("packed test-local data setup failed");',
      '  const setupAgent = async ({ binding }) => { if (!binding.environment.PACKED_MCP_URL || !binding.environment.PACKED_MCP_TOKEN || binding.environment.PACKED_MCP_URL !== binding.environment.FIREDRILL_MCP_URL || binding.environment.PACKED_MCP_TOKEN !== binding.environment.FIREDRILL_MCP_TOKEN) throw new Error("packed binding projection failed"); const runnerMcp = new Client({ name: "packed-setup-runner", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } }); await runnerMcp.connect(new StreamableHTTPClientTransport(new URL(binding.environment.PACKED_MCP_URL), { authProvider: { token: async () => binding.environment.PACKED_MCP_TOKEN } })); try { const result = await runnerMcp.callTool({ name: mcpToolName("packed-tool", "records.put"), arguments: { count: 8 }, _meta: { "dev.firedrill/idempotency-key": "runner-setup-put-8" } }); return { isError: result.isError ?? false, output: result.structuredContent ?? null }; } finally { await runnerMcp.close(); } };',
      '  const injectedBehavior = await runDrills({ root: repository, drill: "put-record", setup: { tools: { behaviorOverrides: [{ packageId: "packed-tool", module: "test-support/packed-override.js" }] }, bindings: { environment: { PACKED_MCP_URL: "FIREDRILL_MCP_URL", PACKED_MCP_TOKEN: "FIREDRILL_MCP_TOKEN" } } }, agent: setupAgent });',
      '  const injectedBehaviorTrial = injectedBehavior.drills[0]?.trials[0]; if (injectedBehavior.verdict !== "passed" || injectedBehaviorTrial?.result.bindingEvidence !== "observed" || injectedBehaviorTrial?.result.assertionResults.some((assertion) => assertion.status !== "passed")) throw new Error("packed Tool behavior setup failed");',
      '  const setupLock = JSON.parse(readFileSync(join(repository, ".firedrill", "builds", injectedBehavior.buildHash.slice("sha256:".length), "packages.lock.json"), "utf8")); const overriddenPackage = setupLock.packages.find((item) => item.packageId === "packed-tool"); if (overriddenPackage?.source?.kind !== "repository_override" || overriddenPackage.source.module !== "test-support/packed-override.js") throw new Error("packed Tool override provenance missing");',
      '  const reproducedSetup = await runDrills({ root: repository, drill: "put-record", buildHash: injectedBehavior.buildHash, agent: setupAgent }); if (reproducedSetup.verdict !== "passed" || reproducedSetup.setup?.setupHash !== injectedBehavior.setup?.setupHash || reproducedSetup.buildHash !== injectedBehavior.buildHash) throw new Error("packed setup reproduction failed");',
      '  const stubbedMcp = await runDrills({ root: repository, drill: "put-record", setup: { bindings: { environment: { PACKED_MCP_URL: "FIREDRILL_MCP_URL", PACKED_MCP_TOKEN: "FIREDRILL_MCP_TOKEN" } }, scenario: { toolOverrides: [{ id: "one-response", operation: { packageId: "packed-tool", operationId: "records.put" }, times: 1, outcome: { kind: "return", value: { count: 77 } } }] } }, agent: setupAgent });',
      '  const stubTrial = stubbedMcp.drills[0]?.trials[0]; const stubCalls = stubTrial?.evidence.filter((entry) => entry.kind === "operation") ?? []; if (stubbedMcp.verdict !== "failed" || stubCalls.length !== 1 || stubCalls[0].outcome.value?.count !== 77 || stubCalls[0].toolOverride?.scope.kind !== "run" || !readFileSync(stubTrial.report.files.html, "utf8").includes("Override: one-response")) throw new Error("packed MCP override fabricated a state effect or lost its provenance");',
      "  verifyReport({ report: stubTrial.report.directory });",
      '  writeFileSync(join(repository, "world", "native.target.json"), JSON.stringify({ schemaVersion: 1, target: { id: "native-agent", kind: "external", bindings: ["direct"], timeoutMs: 5000 } }));',
      '  const nativeDrill = JSON.parse(readFileSync(join(repository, "world", "put-record.drill.json"), "utf8")); nativeDrill.id = "native-record"; nativeDrill.targetId = "native-agent"; writeFileSync(join(repository, "world", "native-record.drill.json"), JSON.stringify(nativeDrill));',
      '  writeFileSync(join(repository, "test-support", "client.mjs"), `export const records = { async save(count) { throw new Error("Real client not configured"); } };`);',
      '  writeFileSync(join(repository, "test-support", "agent.mjs"), `import { records } from "./client.mjs"; export async function run() { return "Saved " + await records.save(9); }`);',
      '  const { records } = await import(join(repository, "test-support", "client.mjs")); const { run: nativeAgent } = await import(join(repository, "test-support", "agent.mjs")); const realSave = records.save;',
      '  const nativeResult = await runDrills({ root: repository, drill: "native-record", agent: async ({ binding }) => { records.save = mockTool(binding, { mode: "async", operation: { packageId: "packed-tool", operationId: "records.put" }, input: (count) => ({ count }), output: (value) => value.count, idempotencyKey: (count) => "native-" + count }); try { const reply = await nativeAgent(); if (reply !== "Saved 9") throw new Error("native result mapping failed"); return reply; } finally { records.save = realSave; } } });',
      '  if (nativeResult.verdict !== "passed" || records.save !== realSave) throw new Error("packed native mock did not preserve state or restore the original dependency"); verifyReport({ report: nativeResult.drills[0].trials[0].report.directory });',
      '  const selectedPackage = await runDrills({ root: repository, drill: "package-setup", setup: { scenario: { actors: [{ id: "operator", grants: [{ packageId: "work-queue", operationId: "items.claim" }, { packageId: "work-queue", operationId: "items.complete" }] }], state: [{ action: "upsert", packageId: "work-queue", namespace: "items", rowId: "item-1", value: { title: "Prove run-local package selection", status: "available" } }] }, tools: { packages: ["@firedrill/tool-work-queue"] } }, agent: async ({ binding }) => { const runnerMcp = new Client({ name: "packed-package-runner", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } }); await runnerMcp.connect(new StreamableHTTPClientTransport(new URL(binding.environment.FIREDRILL_MCP_URL), { authProvider: { token: async () => binding.environment.FIREDRILL_MCP_TOKEN } })); try { const claimed = await runnerMcp.callTool({ name: mcpToolName("work-queue", "items.claim"), arguments: { id: "item-1" }, _meta: { "dev.firedrill/idempotency-key": "runner-claim-item-1" } }); const completed = await runnerMcp.callTool({ name: mcpToolName("work-queue", "items.complete"), arguments: { id: "item-1", result: "done" }, _meta: { "dev.firedrill/idempotency-key": "runner-complete-item-1" } }); return { claimed: !claimed.isError, completed: !completed.isError }; } finally { await runnerMcp.close(); } } });',
      '  const selectedPackageTrial = selectedPackage.drills[0]?.trials[0]; const selectedPackageCalls = selectedPackageTrial?.evidence.filter((entry) => entry.kind === "operation" && entry.invocation.operation.packageId === "work-queue") ?? []; if (selectedPackage.verdict !== "passed" || selectedPackageCalls.length !== 2 || selectedPackageCalls.some((entry) => entry.outcome.status !== "ok")) throw new Error("packed run-local Tool package selection failed");',
      '  const selectedPackageLock = JSON.parse(readFileSync(join(repository, ".firedrill", "builds", selectedPackage.buildHash.slice("sha256:".length), "packages.lock.json"), "utf8")); const selectedPackageEntry = selectedPackageLock.packages.find((item) => item.packageId === "work-queue"); if (selectedPackageEntry?.source?.kind !== "npm" || selectedPackageEntry.source.packageName !== "@firedrill/tool-work-queue") throw new Error("packed selected Tool package provenance missing");',
      '  const runWorkload = () => runDrills({ root: repository, drill: "timed-workload", runDirectory: "workload-runs", reportDirectory: "workload-reports", seed: "55", agent: async ({ interactionId, task, binding }) => { const count = Number(task.input?.count); const runnerMcp = new Client({ name: "packed-workload-" + interactionId, version: "1.0.0" }, { versionNegotiation: { mode: "auto" } }); await runnerMcp.connect(new StreamableHTTPClientTransport(new URL(binding.environment.FIREDRILL_MCP_URL), { authProvider: { token: async () => binding.environment.FIREDRILL_MCP_TOKEN } })); try { const result = await runnerMcp.callTool({ name: mcpToolName("packed-tool", "records.put"), arguments: { count }, _meta: { "dev.firedrill/idempotency-key": "workload-" + interactionId } }); return { isError: result.isError ?? false, output: result.structuredContent ?? null }; } finally { await runnerMcp.close(); } } });',
      "  const workloadFirst = await runWorkload(); const workloadSecond = await runWorkload();",
      '  const firstWorkloadTrial = workloadFirst.drills[0]?.trials[0]; const secondWorkloadTrial = workloadSecond.drills[0]?.trials[0]; if (!firstWorkloadTrial || !secondWorkloadTrial) throw new Error("packed workload returned no trial");',
      '  if (workloadFirst.verdict !== "passed" || firstWorkloadTrial.result.status !== "sealed" || secondWorkloadTrial.result.status !== "sealed" || firstWorkloadTrial.result.interactions.length !== 2 || firstWorkloadTrial.result.finishedAtVirtualUs !== 21600000000 || firstWorkloadTrial.result.checkpoints.filter((checkpoint) => checkpoint.kind === "after_event").length !== 2 || firstWorkloadTrial.result.trajectoryHash !== secondWorkloadTrial.result.trajectoryHash || !existsSync(firstWorkloadTrial.report.files.html)) process.exitCode = 1;',
      '  const runFailure = () => runDrills({ root: repository, drill: "timed-failure", runDirectory: "failure-runs", reportDirectory: "failure-reports", seed: "55", agent: async ({ interactionId, task, binding }) => { const count = Number(task.input?.count); const runnerMcp = new Client({ name: "packed-failure-" + interactionId, version: "1.0.0" }, { versionNegotiation: { mode: "auto" } }); await runnerMcp.connect(new StreamableHTTPClientTransport(new URL(binding.environment.FIREDRILL_MCP_URL), { authProvider: { token: async () => binding.environment.FIREDRILL_MCP_TOKEN } })); try { const result = await runnerMcp.callTool({ name: mcpToolName("packed-tool", "records.put"), arguments: { count }, _meta: { "dev.firedrill/idempotency-key": "failure-" + interactionId } }); return { isError: result.isError ?? false }; } finally { await runnerMcp.close(); } } });',
      '  const failureFirst = await runFailure(); const failureSecond = await runFailure(); const firstFailureTrial = failureFirst.drills[0]?.trials[0]; const secondFailureTrial = failureSecond.drills[0]?.trials[0]; if (!firstFailureTrial || !secondFailureTrial) throw new Error("packed failing workload returned no trial");',
      '  if (failureFirst.verdict !== "failed" || firstFailureTrial.result.status !== "sealed" || secondFailureTrial.result.status !== "sealed" || firstFailureTrial.result.interactions.length !== 1 || firstFailureTrial.result.finishedAtVirtualUs !== 7200000000 || !firstFailureTrial.result.checkpoints.some((checkpoint) => checkpoint.kind === "after_event" && checkpoint.verdict === "failed") || firstFailureTrial.result.trajectoryHash !== secondFailureTrial.result.trajectoryHash || !existsSync(firstFailureTrial.report.files.html)) process.exitCode = 1;',
      '  const authoringValidate = createFiredrillAuthoringTools(repository).find((item) => item.name === "validate"); if (!authoringValidate) throw new Error("packed Agent has no validation Tool"); const authored = await authoringValidate.handler({}, {}); const authoredContent = authored.content[0]; if (authored.isError || authoredContent?.type !== "text" || JSON.parse(authoredContent.text).status !== "success") throw new Error("packed Agent authoring Tool failed");',
      '  let missingKeyError; try { await runFiredrillAgent({ root: repository, environment: {} }); } catch (error) { missingKeyError = error; } if (missingKeyError?.code !== "agent.API_KEY_MISSING") throw new Error("packed Agent did not enforce its BYOK gate before model execution");',
      "} finally { rmSync(repository, { force: true, recursive: true }); }",
      'if (process.exitCode !== 1) process.stdout.write("packed consumer passed\\n");',
    ].join("\n"),
  );
  run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], consumer);

  const installedCli = join(consumer, "node_modules", ".bin", "firedrill");
  const initializedTemplate = join(temporary, "initialized-template");
  mkdirSync(initializedTemplate);
  run(installedCli, ["init", "--path", "template", "--json"], initializedTemplate);
  run(installedCli, ["validate", "--json"], initializedTemplate);
  run(installedCli, ["run", "changes-resource", "--json"], initializedTemplate);
  run(installedCli, ["tool", "inspect", "resource-store", "--json"], initializedTemplate);
  run(installedCli, ["tool", "validate", "resource-store", "--json"], initializedTemplate);
  run(installedCli, ["tool", "test", "resource-store", "--json"], initializedTemplate);
  run(
    installedCli,
    ["tool", "contribute", "resource-store", "--accept-apache-2.0", "--json"],
    initializedTemplate,
  );

  const initializedSkill = join(temporary, "initialized-skill");
  mkdirSync(initializedSkill);
  run(installedCli, ["init", "--path", "coding-agent", "--json"], initializedSkill);
  assertSameTree(
    join(root, "skills", "firedrill"),
    join(initializedSkill, ".agents", "skills", "firedrill"),
    "installed coding-agent skill",
  );

  const initializedAgent = join(temporary, "initialized-agent");
  mkdirSync(initializedAgent);
  run(installedCli, ["init", "--path", "firedrill-agent", "--json"], initializedAgent);
  assertSameTree(
    join(root, "skills", "firedrill"),
    join(initializedAgent, ".agents", "skills", "firedrill"),
    "installed Firedrill Agent skill",
  );
  const withoutAnthropicKey = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "ANTHROPIC_API_KEY"),
  );
  const missingAgentKey = spawnSync(installedCli, ["agent", "--json"], {
    cwd: initializedAgent,
    encoding: "utf8",
    stdio: "pipe",
    env: withoutAnthropicKey,
  });
  const missingAgentKeyResult = missingAgentKey.stdout ? JSON.parse(missingAgentKey.stdout) : null;
  if (missingAgentKey.status !== 2 || missingAgentKeyResult?.code !== "agent.API_KEY_MISSING") {
    throw new Error(
      `packed CLI did not enforce the Agent BYOK gate\n${missingAgentKey.stdout}\n${missingAgentKey.stderr}`,
    );
  }

  const pythonAgentProject = join(temporary, "python-agent-detection");
  mkdirSync(pythonAgentProject);
  writeFileSync(
    join(pythonAgentProject, "pyproject.toml"),
    '[project]\nname = "sample-agent"\nversion = "0.0.0"\ndependencies = ["anthropic==1.0.0", "mcp>=1.0"]\n',
  );
  writeFileSync(
    join(pythonAgentProject, "agent.py"),
    "from anthropic import Anthropic\nfrom mcp import ClientSession\n",
  );
  const pythonInspection = spawnSync(installedCli, ["init", "--json"], {
    cwd: pythonAgentProject,
    encoding: "utf8",
    stdio: "pipe",
  });
  const pythonInspectionResult = pythonInspection.stdout ? JSON.parse(pythonInspection.stdout) : null;
  if (
    pythonInspection.status !== 0 ||
    !pythonInspectionResult?.detection?.languages?.includes("python") ||
    !pythonInspectionResult?.detection?.agentLibraries?.includes("anthropic") ||
    !pythonInspectionResult?.detection?.agentLibraries?.includes("mcp") ||
    !pythonInspectionResult?.detection?.candidateAgentFiles?.includes("agent.py")
  ) {
    throw new Error(
      `packed CLI failed to discover a Python agent repository\n${pythonInspection.stdout}\n${pythonInspection.stderr}`,
    );
  }

  // Prove an installed Tool pack works in a minimal consumer. Installing every
  // framework package directly would accidentally hoist implementation
  // dependencies and hide a non-portable compiled artifact.
  const installedPackProject = join(temporary, "installed-pack-consumer");
  mkdirSync(installedPackProject);
  writeFileSync(
    join(installedPackProject, "package.json"),
    `${JSON.stringify(
      {
        name: "firedrill-installed-pack-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@firedrill/cli": `file:${archives.get("@firedrill/cli")}`,
          "@firedrill/tool-github-issues": `file:${archives.get("@firedrill/tool-github-issues")}`,
          "@firedrill/tool-mailbox": `file:${archives.get("@firedrill/tool-mailbox")}`,
          "@firedrill/tool-object-storage": `file:${archives.get("@firedrill/tool-object-storage")}`,
          "@firedrill/tool-work-queue": `file:${archives.get("@firedrill/tool-work-queue")}`,
          "@octokit/rest": "21.1.1",
        },
        pnpm: {
          overrides: Object.fromEntries(
            [...archives].map(([name, archivePath]) => [name, `file:${archivePath}`]),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );
  run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], installedPackProject);
  const installedOctokitManifest = JSON.parse(
    readFileSync(join(installedPackProject, "node_modules", "@octokit", "rest", "package.json"), "utf8"),
  ) as { version?: string };
  if (installedOctokitManifest.version !== "21.1.1") {
    throw new Error(
      `installed official client does not match the declared compatibility version: ${installedOctokitManifest.version ?? "missing"}`,
    );
  }
  const installedPackCli = join(installedPackProject, "node_modules", ".bin", "firedrill");
  writeFileSync(
    join(consumer, "tool-first.mjs"),
    readFileSync(join(root, "tooling", "packed-tool-first.mjs")),
  );
  run("node", ["tool-first.mjs", installedPackProject], consumer);
  writeFileSync(
    join(consumer, "mailbox-storage.mjs"),
    readFileSync(join(root, "tooling", "packed-mailbox-storage.mjs")),
  );
  run("node", ["mailbox-storage.mjs", installedPackProject], consumer);
  writeFileSync(join(consumer, "tool-apps.mjs"), readFileSync(join(root, "tooling", "packed-tool-apps.mjs")));
  run("node", ["tool-apps.mjs", installedPackProject], consumer);
  mkdirSync(join(installedPackProject, "world"), { recursive: true });
  writeFileSync(
    join(installedPackProject, "firedrill.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json", toolPackages: ["@firedrill/tool-github-issues", "@firedrill/tool-work-queue"] })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "world.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "installed-pack-world",
      actors: [
        {
          id: "worker",
          grants: [
            { packageId: "github-issues", operationId: "comments.create" },
            { packageId: "github-issues", operationId: "comments.list" },
            { packageId: "github-issues", operationId: "issues.get" },
            { packageId: "github-issues", operationId: "issues.update" },
            { packageId: "work-queue", operationId: "items.claim" },
            { packageId: "work-queue", operationId: "items.complete" },
          ],
          attributes: { login: "packed-client" },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "baseline.scenario.json"),
    `${JSON.stringify({ schemaVersion: 1, id: "baseline", state: [{ action: "upsert", packageId: "work-queue", namespace: "items", rowId: "item-1", value: { title: "Prove installed behavior", status: "available" } }] })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "agent.target.json"),
    `${JSON.stringify({ schemaVersion: 1, target: { id: "installed-pack-agent", kind: "command", bindings: ["http"], executable: "node", arguments: ["agent.mjs"], workingDirectory: ".", timeoutMs: 5000 } })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "complete.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "complete-installed-item",
      targetId: "installed-pack-agent",
      actorId: "worker",
      scenarioId: "baseline",
      task: { instruction: "Claim and complete item-1." },
      assertions: [
        {
          id: "item-completed",
          kind: "state.value",
          packageId: "work-queue",
          namespace: "items",
          rowId: "item-1",
          path: ["status"],
          comparison: { operator: "equals", value: "completed" },
        },
        {
          id: "completion-emitted",
          kind: "event.count",
          event: { packageId: "work-queue", eventId: "item.completed" },
          phase: "emitted",
          comparison: { operator: "equals", value: 1 },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "agent.mjs"),
    `let input = ""; for await (const chunk of process.stdin) input += chunk; JSON.parse(input); const baseUrl = process.env.FIREDRILL_HTTP_URL; const token = process.env.FIREDRILL_HTTP_TOKEN; const basic = Buffer.from("firedrill:" + token, "utf8").toString("base64"); const claimed = await fetch(baseUrl + "/api/work-items/item-1/claim", { method: "POST", headers: { authorization: "Basic " + basic, "idempotency-key": "claim-item-1" } }); if (claimed.status !== 204) throw new Error(await claimed.text()); const completed = await fetch(baseUrl + "/api/work-items/item-1?access_token=" + encodeURIComponent(token), { method: "PATCH", headers: { "content-type": "text/plain", "idempotency-key": "complete-item-1" }, body: "done" }); if (!completed.ok || await completed.text() !== "completed\\n") throw new Error("completion route failed"); process.stdout.write(JSON.stringify({ completed: true }));\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "github-baseline.scenario.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "github-baseline",
      state: [
        {
          action: "upsert",
          packageId: "github-issues",
          namespace: "issues",
          rowId: "octo/example#42",
          value: {
            owner: "octo",
            repo: "example",
            number: 42,
            id: 420042,
            nodeId: "I_packed_420042",
            title: "Release evidence is incomplete",
            body: "Attach evidence before closing this issue.",
            state: "open",
            locked: false,
            comments: 0,
            author: "repository-owner",
            createdAt: "2025-12-31T23:00:00.000Z",
            updatedAt: "2025-12-31T23:30:00.000Z",
          },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "github-agent.target.json"),
    `${JSON.stringify({ schemaVersion: 1, target: { id: "github-client-agent", kind: "command", bindings: ["http"], executable: "node", arguments: ["github-agent.mjs"], workingDirectory: ".", timeoutMs: 10000 } })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "world", "github-client.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "github-official-client",
      targetId: "github-client-agent",
      actorId: "worker",
      scenarioId: "github-baseline",
      task: { instruction: "Use the installed official client to inspect, comment on, and close issue 42." },
      assertions: [
        {
          id: "issue-closed",
          kind: "state.value",
          packageId: "github-issues",
          namespace: "issues",
          rowId: "octo/example#42",
          path: ["state"],
          comparison: { operator: "equals", value: "closed" },
        },
        {
          id: "one-comment",
          kind: "state.count",
          packageId: "github-issues",
          namespace: "comments",
          comparison: { operator: "equals", value: 1 },
        },
        {
          id: "client-flow",
          kind: "operation.order",
          sequence: [
            { anyOf: [{ packageId: "github-issues", operationId: "issues.get" }] },
            { anyOf: [{ packageId: "github-issues", operationId: "comments.create" }] },
            { anyOf: [{ packageId: "github-issues", operationId: "comments.list" }] },
            { anyOf: [{ packageId: "github-issues", operationId: "issues.update" }] },
          ],
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(installedPackProject, "github-agent.mjs"),
    `import { Octokit } from "@octokit/rest"; let input = ""; for await (const chunk of process.stdin) input += chunk; JSON.parse(input); const baseUrl = process.env.FIREDRILL_HTTP_URL; const auth = process.env.FIREDRILL_HTTP_TOKEN; if (!baseUrl || !auth) throw new Error("Firedrill HTTP binding is missing"); const client = new Octokit({ baseUrl, auth }); const repository = { owner: "octo", repo: "example", issue_number: 42 }; const before = await client.rest.issues.get(repository); const created = await client.rest.issues.createComment({ ...repository, body: "Packed-client evidence is attached." }); const comments = await client.rest.issues.listComments(repository); const closed = await client.rest.issues.update({ ...repository, state: "closed", state_reason: "completed" }); let unsupported = false; try { await client.rest.issues.create({ owner: "octo", repo: "example", title: "must not escape" }); } catch (error) { unsupported = error?.status === 404 && error?.request?.url?.startsWith(baseUrl); } if (before.data.state !== "open" || created.data.user?.login !== "packed-client" || comments.data.length !== 1 || closed.data.state !== "closed" || !unsupported) throw new Error("installed official client observed an invalid synthetic flow"); process.stdout.write(JSON.stringify({ completed: true }));\n`,
  );
  const packInspect = spawnSync(installedPackCli, ["tool", "inspect", "work-queue", "--json"], {
    cwd: installedPackProject,
    encoding: "utf8",
    stdio: "pipe",
  });
  const packInspection = packInspect.stdout ? JSON.parse(packInspect.stdout) : null;
  if (
    packInspect.status !== 0 ||
    packInspection?.tool?.origin?.kind !== "npm" ||
    packInspection?.tool?.origin?.packageName !== "@firedrill/tool-work-queue"
  ) {
    throw new Error(`installed Tool pack inspection failed\n${packInspect.stdout}\n${packInspect.stderr}`);
  }
  run(installedPackCli, ["validate", "--json"], installedPackProject);
  run(installedPackCli, ["tool", "validate", "work-queue", "--json"], installedPackProject);
  run(installedPackCli, ["run", "complete-installed-item", "--json"], installedPackProject);
  const compatibleInspect = spawnSync(installedPackCli, ["tool", "inspect", "github-issues", "--json"], {
    cwd: installedPackProject,
    encoding: "utf8",
    stdio: "pipe",
  });
  const compatibleInspection = compatibleInspect.stdout ? JSON.parse(compatibleInspect.stdout) : null;
  if (
    compatibleInspect.status !== 0 ||
    compatibleInspection?.tool?.origin?.packageName !== "@firedrill/tool-github-issues" ||
    compatibleInspection?.tool?.manifest?.compatibility?.[0]?.client?.name !== "@octokit/rest" ||
    compatibleInspection?.tool?.manifest?.compatibility?.[0]?.client?.version !== "21.1.1" ||
    compatibleInspection?.tool?.manifest?.compatibility?.[0]?.routes?.length !== 4
  ) {
    throw new Error(
      `installed compatible Tool pack inspection failed\n${compatibleInspect.stdout}\n${compatibleInspect.stderr}`,
    );
  }
  const compatibleRun = spawnSync(installedPackCli, ["run", "github-official-client", "--json"], {
    cwd: installedPackProject,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30000,
  });
  const compatibleRunResult = compatibleRun.stdout ? JSON.parse(compatibleRun.stdout) : null;
  const compatibleTrial = compatibleRunResult?.drills?.[0]?.trials?.[0];
  const compatibleReport = compatibleTrial?.jsonReport
    ? JSON.parse(readFileSync(compatibleTrial.jsonReport, "utf8"))
    : null;
  if (
    compatibleRun.status !== 0 ||
    compatibleRunResult?.verdict !== "passed" ||
    compatibleTrial?.result?.bindingEvidence !== "observed" ||
    compatibleReport?.tools?.[0]?.compatibility?.[0]?.client?.name !== "@octokit/rest" ||
    compatibleReport?.tools?.[0]?.compatibility?.[0]?.client?.version !== "21.1.1" ||
    compatibleReport?.tools?.[0]?.compatibility?.[0]?.routes?.length !== 4
  ) {
    throw new Error(
      `installed official-client Tool flow failed\n${compatibleRun.stdout}\n${compatibleRun.stderr}`,
    );
  }
  const refusedContribution = spawnSync(
    installedPackCli,
    ["tool", "contribute", "work-queue", "--accept-apache-2.0", "--json"],
    { cwd: installedPackProject, encoding: "utf8", stdio: "pipe" },
  );
  const refusedContributionResult = refusedContribution.stdout
    ? JSON.parse(refusedContribution.stdout)
    : null;
  if (
    refusedContribution.status !== 2 ||
    refusedContributionResult?.code !== "framework.TOOL_CONTRIBUTION_SOURCE_REQUIRED"
  ) {
    throw new Error(
      `installed Tool pack contribution was not refused safely\n${refusedContribution.stdout}\n${refusedContribution.stderr}`,
    );
  }

  run("node", ["index.mjs"], consumer);
  const captureProject = join(temporary, "capture-project");
  cpSync(join(root, "examples", "quickstart"), captureProject, { recursive: true });
  writeFileSync(join(consumer, "capture.mjs"), readFileSync(join(root, "tooling", "packed-capture.mjs")));
  run("node", ["capture.mjs", captureProject], consumer);
  writeFileSync(
    join(consumer, "browser-tests.mjs"),
    readFileSync(join(root, "tooling", "packed-browser-tests.mjs")),
  );
  run("node", ["browser-tests.mjs", installedPackProject], consumer);
  writeFileSync(
    join(consumer, "independent-tools.mjs"),
    readFileSync(join(root, "tooling", "packed-independent-tools.mjs")),
  );
  run("node", ["independent-tools.mjs"], consumer);
  process.stdout.write(`packed consumer check passed for ${publishable.length} package(s)\n`);
} finally {
  if (temporary.startsWith(`${tmpdir()}/firedrill-pack-`)) {
    rmSync(temporary, { force: true, recursive: true });
  }
}
