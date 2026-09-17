import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { mcpToolName } from "@firedrill-tools/protocol-mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// This driver is copied into the existing packed consumer. The CLI and worlds
// run in the separate minimal installed-pack consumer, never the workspace.
const installedProject = process.argv[2];
assert.ok(installedProject);
const root = join(installedProject, "tool-first-environment");
mkdirSync(root);
const cli = join(installedProject, "node_modules", ".bin", "firedrill");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "ANTHROPIC_API_KEY"),
);
function command(args, extraEnvironment = {}) {
  const result = spawnSync(cli, [...args, "--json"], {
    cwd: root,
    env: { ...environment, ...extraEnvironment },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `packed ${args[0]} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const inspection = command(["init"]);
assert.equal(inspection.status, "inspection");
assert.equal(existsSync(join(root, "firedrill.json")), false);
const initialized = command([
  "init",
  "--tool",
  "@firedrill-tools/tool-work-queue",
  "--tool",
  "@firedrill-tools/tool-github-issues",
]);
assert.equal(initialized.status, "initialized");
assert.equal(initialized.sourceValidated, true);
assert.equal(initialized.testsExecuted, false);
assert.equal(initialized.setup.starterRows, 3);
const worldSource = JSON.parse(readFileSync(join(root, "firedrill", "world.json"), "utf8"));
assert.equal(worldSource.state.length, 3);
assert.equal(worldSource.actors[0].grants.length, 7);
const plan = command(["plan"]);
assert.deepEqual(plan.tools.map((tool) => tool.id).sort(), ["github-issues", "work-queue"]);
assert.deepEqual(plan.drills, []);
assert.deepEqual(plan.targets, []);
assert.deepEqual(plan.scenarios, []);
assert.equal(existsSync(join(root, "firedrill", "tools", "local-probe")), false);

const child = spawn(cli, ["serve", "--json"], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let pending = "";
let resolveReady;
let rejectReady;
const readyPromise = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const ended = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
void ended.catch((error) => rejectReady(error));
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  pending += chunk;
  while (pending.includes("\n")) {
    const end = pending.indexOf("\n");
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (event.status === "ready") resolveReady(event);
      if (event.status === "failed")
        rejectReady(new Error(`packed serve failed: ${event.code} ${event.message}`));
    } catch {
      rejectReady(new Error("packed serve did not emit JSON lifecycle records"));
    }
  }
});
const startupDeadline = setTimeout(
  () => rejectReady(new Error("packed standalone startup exceeded 30 seconds")),
  30_000,
);
let mcp;
let ready;
let closeError;
try {
  ready = await readyPromise;
  clearTimeout(startupDeadline);
  assert.equal(ready.testsExecuted, false);
  assert.equal(ready.actorId, "local-dev");
  assert.deepEqual(Object.keys(ready.endpoints).sort(), ["cli", "http", "mcp"]);
  const http = ready.endpoints.http;
  async function httpJson(path, options = {}) {
    const response = await fetch(`${http.url}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${http.token}`,
        "content-type": "application/json",
        ...options.headers,
      },
    });
    assert.equal(response.ok, true, `packed HTTP operation failed (${response.status})`);
    return response.json();
  }
  const issuePath = "/repos/octo/example/issues/42";
  assert.equal((await httpJson(issuePath)).state, "open");
  const claimed = await httpJson("/v1/operations/work-queue/items.claim", {
    method: "POST",
    body: JSON.stringify({ arguments: { id: "task-1" }, idempotencyKey: "packed-tool-first-claim" }),
  });
  assert.equal(claimed.outcome.value.status, "claimed");
  mcp = new Client({ name: "packed-tool-first", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(ready.endpoints.mcp.url), {
      authProvider: { token: async () => ready.endpoints.mcp.token },
    }),
  );
  const completed = await mcp.callTool({
    name: mcpToolName("work-queue", "items.complete"),
    arguments: { id: "task-1", result: "packed protocol proof" },
    _meta: { "dev.firedrill/idempotency-key": "packed-tool-first-complete" },
  });
  assert.notEqual(completed.isError, true);
  assert.equal(completed.structuredContent.status, "completed");
  const listed = command(
    ["world", "call", "work-queue", "items.list", "--input", '{"status":"completed"}'],
    ready.environment,
  );
  assert.equal(listed.outcome.value.items[0].id, "task-1");
  await httpJson(issuePath, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });

  const page = await (await fetch(ready.url)).text();
  const token = page.match(/<meta name="firedrill-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "packed inspector did not embed its control credential");
  async function control(path, options = {}) {
    return fetch(`${ready.url}/api/environment${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers },
    });
  }
  assert.equal((await fetch(`${ready.url}/api/environment`)).status, 401);
  const status = await (await control("")).json();
  assert.equal(status.available, true);
  assert.equal(status.agentTested, false);
  assert.equal(status.metadata.worldInstanceId, ready.worldInstanceId);
  for (const endpoint of Object.values(ready.endpoints))
    assert.equal(JSON.stringify(status).includes(endpoint.token), false);
  const state = await (await control("/state?packageId=work-queue&namespace=items")).json();
  assert.equal(state.records.find((row) => row.rowId === "task-1").value.status, "completed");
  assert.equal(
    (await control("/reset", { method: "POST", body: JSON.stringify({ worldInstanceId: "wrong-world" }) }))
      .status,
    409,
  );
  const reset = await control("/reset", {
    method: "POST",
    body: JSON.stringify({ worldInstanceId: ready.worldInstanceId, packages: ["work-queue"] }),
  });
  assert.equal(reset.status, 200);
  const resetBody = await reset.json();
  assert.equal(resetBody.generation, status.description.generation + 1);
  const resetList = command(
    ["world", "call", "work-queue", "items.list", "--input", '{"status":"available"}'],
    ready.environment,
  );
  assert.equal(resetList.outcome.value.items.length, 2);
  assert.equal((await httpJson(issuePath)).state, "closed", "scoped reset changed the unrelated Tool");
  assert.equal(
    (
      await control("/reset", {
        method: "POST",
        body: JSON.stringify({ worldInstanceId: ready.worldInstanceId }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await httpJson(issuePath)).state,
    "open",
    "whole-world reset did not restore the package-authored baseline",
  );
  assert.equal(existsSync(join(root, ".env")), false);
  assert.equal(existsSync(join(root, ".firedrill", "reports")), false);
} finally {
  clearTimeout(startupDeadline);
  try {
    await mcp?.close();
  } catch (error) {
    closeError = error;
  }
  child.kill("SIGINT");
  const killDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const completion = await ended;
  clearTimeout(killDeadline);
  assert.equal(completion.code, 130, "packed foreground CLI did not stop cleanly on SIGINT");
  assert.equal(stderr, "");
}
if (closeError !== undefined) throw closeError;
if (ready !== undefined) {
  for (const url of [ready.url, ...Object.values(ready.endpoints).map((endpoint) => endpoint.url)]) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(new URL(url).port), "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
process.stdout.write(
  "packed Tool-first init, authored baselines, HTTP/MCP/CLI, live inspector, scoped/full reset, and shutdown passed\n",
);
