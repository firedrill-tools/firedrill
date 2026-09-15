import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
const clients: Client[] = [];
const cliPath = resolve(import.meta.dirname, "../dist/bin.js");

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-control-mcp-"));
  roots.push(root);
  const source = join(root, "world");
  mkdirSync(source);
  const json = (name: string, value: unknown) => writeFileSync(join(source, name), JSON.stringify(value));
  writeFileSync(
    join(root, "firedrill.json"),
    JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }),
  );
  json("world.json", {
    schemaVersion: 1,
    id: "storage-test",
    actors: [{ id: "operator", grants: [{ packageId: "records", operationId: "update" }] }],
    state: [
      { action: "upsert", packageId: "records", namespace: "items", rowId: "a", value: { value: 1 } },
      { action: "upsert", packageId: "records", namespace: "items", rowId: "b", value: { value: 2 } },
    ],
  });
  json("records.tool.json", {
    schemaVersion: 1,
    module: "./records.js",
    manifest: {
      schemaVersion: 1,
      id: "records",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "items", schema: { type: "object" } }],
      operations: [
        {
          id: "update",
          inputSchema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "integer" } },
            additionalProperties: false,
          },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "stateful",
          declaredErrors: ["UNAVAILABLE"],
        },
      ],
      faults: [
        {
          id: "unavailable",
          appliesTo: ["update"],
          timing: "before",
          error: { code: "UNAVAILABLE", message: "Unavailable", retryable: true },
        },
      ],
    },
  });
  writeFileSync(
    join(source, "records.js"),
    'export default { operations: { update: (input, context) => { const value = { value: input.value }; context.state.put("items", "a", value); return value; } } };\n',
  );
  json("changed.scenario.json", {
    schemaVersion: 1,
    id: "changed",
    virtualTimeUs: 0,
    state: [{ action: "upsert", packageId: "records", namespace: "items", rowId: "a", value: { value: 9 } }],
  });
  json("worker.target.json", {
    schemaVersion: 1,
    target: {
      id: "worker",
      kind: "command",
      bindings: ["http"],
      executable: process.execPath,
      arguments: ["worker.mjs"],
      workingDirectory: ".",
      timeoutMs: 5000,
    },
  });
  json("update.drill.json", {
    schemaVersion: 1,
    id: "update",
    targetId: "worker",
    actorId: "operator",
    scenarioId: "changed",
    task: { instruction: "Set the value to five." },
    assertions: [
      {
        id: "called-once",
        kind: "operation.count",
        operation: { packageId: "records", operationId: "update" },
        comparison: { operator: "equals", value: 1 },
      },
    ],
  });
  writeFileSync(
    join(root, "worker.mjs"),
    [
      "for await (const chunk of process.stdin) {}",
      'const response = await fetch(process.env.FIREDRILL_HTTP_URL + "/v1/operations/records/update", { method: "POST", headers: { authorization: "Bearer " + process.env.FIREDRILL_HTTP_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ arguments: { value: 5 } }) });',
      "if (!response.ok) process.exit(1);",
      "process.stdout.write(JSON.stringify({ completed: true }));",
    ].join("\n"),
  );
  return root;
}

async function connect(root: string, execution = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "--root", root, ...(execution ? ["--allow-execution"] : [])],
    cwd: root,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "fresh-coding-agent", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function call(client: Client, name: string, arguments_: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) throw new Error(JSON.stringify(response));
  return response.structuredContent as TestResponse;
}

interface TestResponse {
  readonly environmentId: string;
  readonly generation: number;
  readonly sourceHash: string;
  readonly path: string;
  readonly items: readonly { readonly id: string; readonly value: unknown }[];
  readonly nextAfterRowId?: string;
  readonly endpoints: { readonly http: { readonly url: string } };
  readonly reportIndex: string;
  readonly drills: readonly { readonly trials: readonly { readonly report: unknown }[] }[];
}

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("Expected a non-empty response list");
  return value;
}

describe("coding-agent control MCP", () => {
  it("has read-only help and rejects ambiguous flags without writing source", async () => {
    const root = repository();
    let output = "";
    let error = "";
    const io = {
      cwd: root,
      stdout: {
        write(value: string) {
          output += value;
        },
      },
      stderr: {
        write(value: string) {
          error += value;
        },
      },
    };
    expect(await runCli(["mcp", "--allow-execution", "--help"], io)).toBe(0);
    expect(output).toContain("Default: inspect source");
    expect(error).toBe("");
    expect(await runCli(["mcp", "--root"], io)).toBe(2);
    expect(error).toContain("Invalid MCP option");
    expect(existsSync(join(root, ".firedrill"))).toBe(false);
  });

  it("lets a fresh MCP client inspect and validate, but cannot execute code without opt-in", async () => {
    const root = repository();
    // Source compilation must not run this top-level code.
    writeFileSync(
      join(root, "world", "records.js"),
      'throw new Error("this must not execute"); export default { operations: { update: () => ({}) } };\n',
    );
    const { client, stderr } = await connect(root);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "project_validate",
      "project_plan",
      "project_inspect",
      "tool_catalog",
      "tool_inspect",
    ]);
    expect(await call(client, "project_validate")).toMatchObject({ status: "success", diagnostics: [] });
    expect(await call(client, "project_plan")).toMatchObject({
      executionAllowed: false,
      counts: { tools: 1, scenarios: 1, drills: 1 },
    });
    const inspected = await call(client, "project_inspect", { kind: "scenarios", limit: 1 });
    expect(inspected.items).toHaveLength(1);
    expect(first(inspected.items).id).toBe("changed");
    expect(await call(client, "tool_inspect", { toolId: "records" })).toMatchObject({
      origin: { kind: "repository" },
      manifest: { id: "records" },
    });
    await expect(client.callTool({ name: "environment_start", arguments: {} })).rejects.toThrow("not found");
    const outsideRoot = await client.callTool({ name: "project_validate", arguments: { root: "/" } });
    expect(outsideRoot.isError).toBe(true);
    expect(existsSync(join(root, ".firedrill"))).toBe(false);
    expect(stderr()).not.toContain("this must not execute");
  }, 20_000);

  it("starts independent worlds, discovers contracts, invokes behavior, paginates state, and resets without changing credentials", async () => {
    const root = repository();
    const { client } = await connect(root, true);
    const firstWorld = await call(client, "environment_start", { scenario: "changed" });
    const second = await call(client, "environment_start");
    const environmentId = firstWorld.environmentId;
    expect(firstWorld).toMatchObject({ status: "ready", actorId: "operator", scenarioId: "changed" });
    expect(JSON.stringify(firstWorld)).not.toContain("TOKEN");
    const credentials = await call(client, "environment_connect", { environmentId });
    expect(credentials.endpoints.http.url).toMatch(/^http:\/\/127.0.0.1:/);
    const contracts = await call(client, "environment_tools", { environmentId });
    expect(first(contracts.items)).toMatchObject({ packageId: "records", operations: ["update"] });
    const stateArgs = { environmentId, packageId: "records", namespace: "items", limit: 1 };
    const baseline = await call(client, "environment_state", stateArgs);
    expect(first(baseline.items)).toMatchObject({ rowId: "a", value: { value: 9 } });
    expect(baseline.nextAfterRowId).toBe("a");
    const next = await call(client, "environment_state", {
      ...stateArgs,
      afterRowId: baseline.nextAfterRowId,
    });
    expect(first(next.items)).toMatchObject({ rowId: "b", value: { value: 2 } });
    expect(next.nextAfterRowId).toBeUndefined();
    await call(client, "environment_call", {
      environmentId,
      packageId: "records",
      operationId: "update",
      arguments: { value: 7 },
    });
    expect(first((await call(client, "environment_state", stateArgs)).items).value).toEqual({ value: 7 });
    expect(
      first(
        (await call(client, "environment_state", { ...stateArgs, environmentId: second.environmentId }))
          .items,
      ).value,
    ).toEqual({ value: 1 });
    expect((await call(client, "environment_evidence", { environmentId })).items.length).toBeGreaterThan(0);
    const noConsent = await client.callTool({ name: "environment_reset", arguments: { environmentId } });
    expect(noConsent.isError).toBe(true);
    await call(client, "environment_reset", { environmentId, packages: ["records"], confirm: true });
    expect(first((await call(client, "environment_state", stateArgs)).items).value).toEqual({ value: 9 });
    expect(await call(client, "environment_connect", { environmentId })).toEqual(credentials);
    expect((await call(client, "environment_status", { environmentId })).generation).toBeGreaterThan(
      firstWorld.generation,
    );
    await call(client, "environment_reset", { environmentId, confirm: true });
    await call(client, "environment_advance_time", { environmentId, toUs: 1000 });
    await call(client, "environment_set_fault", {
      environmentId,
      packageId: "records",
      faultId: "unavailable",
      active: true,
    });
    const faulted = await call(client, "environment_call", {
      environmentId,
      packageId: "records",
      operationId: "update",
      arguments: { value: 4 },
    });
    expect(JSON.stringify(faulted)).toContain("UNAVAILABLE");
    await call(client, "environment_close", { environmentId });
    await expect(fetch(credentials.endpoints.http.url)).rejects.toThrow();
    expect((await call(client, "environment_list")).items).toHaveLength(1);
    const unknown = await client.callTool({ name: "environment_status", arguments: { environmentId } });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ code: "framework.MCP_ENVIRONMENT_NOT_FOUND" });
  }, 30_000);

  it("runs the declared target and retains a real self-contained local report", async () => {
    const root = repository();
    const { client } = await connect(root, true);
    const run = await call(client, "drill_run", { drillId: "update", trials: 1 });
    expect(run).toMatchObject({ status: "completed", verdict: "passed", drills: [{ passed: 1, failed: 0 }] });
    expect(existsSync(run.reportIndex)).toBe(true);
    const report = first(first(run.drills).trials).report;
    expect(JSON.stringify(report)).toContain(".firedrill");
    const changed = JSON.parse(readFileSync(join(root, "world", "update.drill.json"), "utf8"));
    changed.assertions[0].comparison.value = 2;
    writeFileSync(join(root, "world", "update.drill.json"), JSON.stringify(changed));
    expect(await call(client, "drill_run", { drillId: "update" })).toMatchObject({
      status: "completed",
      verdict: "failed",
      drills: [{ failed: 1 }],
    });
  }, 30_000);

  it("previews live Tool data, requires confirmation, and saves a restartable scenario without overwriting source", async () => {
    const root = repository();
    const { client } = await connect(root, true);
    const { environmentId } = await call(client, "environment_start");
    await call(client, "environment_call", {
      environmentId,
      packageId: "records",
      operationId: "update",
      arguments: { value: 42 },
    });
    const preview = await call(client, "environment_export_scenario", { environmentId, id: "captured" });
    expect(preview).toMatchObject({
      scope: "tool-state",
      recordCount: 2,
      omitted: expect.arrayContaining(["clock", "history"]),
    });
    expect(existsSync(join(root, "world", "scenarios", "captured.scenario.json"))).toBe(false);
    const save = {
      environmentId,
      id: "captured",
      expectedSourceHash: preview.sourceHash,
      expectedGeneration: preview.generation,
    };
    expect((await client.callTool({ name: "environment_save_scenario", arguments: save })).isError).toBe(
      true,
    );
    const saved = await call(client, "environment_save_scenario", { ...save, confirm: true });
    expect(existsSync(join(root, saved.path))).toBe(true);
    expect(
      (await client.callTool({ name: "environment_save_scenario", arguments: { ...save, confirm: true } }))
        .isError,
    ).toBe(true);
    const restarted = await call(client, "environment_start", { scenario: "captured" });
    const state = await call(client, "environment_state", {
      environmentId: restarted.environmentId,
      packageId: "records",
      namespace: "items",
    });
    expect(first(state.items).value).toEqual({ value: 42 });
  }, 20_000);

  it("closes a live environment on stdin EOF without requiring a signal", async () => {
    const root = repository();
    const child = spawn(process.execPath, [cliPath, "mcp", "--allow-execution", "--root", root], {
      stdio: "pipe",
    });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = "";
    child.stdout.on("data", (bytes: Buffer) => {
      buffer += bytes.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id?: number };
        buffer = buffer.slice(newline + 1);
        if (message.id !== undefined) waiting.get(message.id)?.(message);
        newline = buffer.indexOf("\n");
      }
    });
    let sequence = 0;
    async function request(method: string, params: Record<string, unknown>) {
      const id = ++sequence;
      const response = new Promise<Record<string, unknown>>((done) => waiting.set(id, done));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    }
    try {
      await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "eof-test", version: "1" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const started = await request("tools/call", { name: "environment_start", arguments: {} });
      const startResult = started.result as { structuredContent: { environmentId: string } };
      const connected = await request("tools/call", {
        name: "environment_connect",
        arguments: { environmentId: startResult.structuredContent.environmentId },
      });
      const credentials = connected.result as { structuredContent: { endpoints: { http: { url: string } } } };
      child.stdin.end();
      expect(await exited).toBe(0);
      await expect(fetch(credentials.structuredContent.endpoints.http.url)).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  }, 20_000);

  it("closes owned listeners on an interrupt", async () => {
    const root = repository();
    const { client, transport } = await connect(root, true);
    const started = await call(client, "environment_start");
    const credentials = await call(client, "environment_connect", { environmentId: started.environmentId });
    const closed = new Promise<void>((resolve) => {
      client.onclose = resolve;
    });
    const pid = transport.pid;
    if (pid === null) throw new Error("The MCP process did not start");
    process.kill(pid, "SIGINT");
    await closed;
    await expect(fetch(credentials.endpoints.http.url)).rejects.toThrow();
  }, 20_000);

  it("keeps trusted Tool console output on stderr instead of corrupting MCP messages", async () => {
    const root = repository();
    const behavior = join(root, "world", "records.js");
    writeFileSync(behavior, `console.log("fixture Tool loaded");\n${readFileSync(behavior, "utf8")}`);
    const { client, stderr } = await connect(root, true);
    const started = await call(client, "environment_start");
    expect(started.environmentId).toMatch(/^env_/);
    expect(stderr()).toContain("fixture Tool loaded");
    expect(await call(client, "environment_status", { environmentId: started.environmentId })).toMatchObject({
      status: "success",
    });
  }, 20_000);

  it("ends cleanly on stdin EOF rather than leaving an MCP process waiting forever", async () => {
    const root = repository();
    const input = new PassThrough();
    const output = new PassThrough();
    let errors = "";
    const running = runCli(["mcp", "--allow-execution"], {
      cwd: root,
      stdout: { write() {} },
      stderr: {
        write(value) {
          errors += value;
        },
      },
      stdio: { input, output },
    });
    input.end();
    expect(await running).toBe(0);
    expect(errors).toBe("");
  }, 10_000);
});
