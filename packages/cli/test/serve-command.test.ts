import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
const servers: Server[] = [];
const controllers: AbortController[] = [];
const commands: Promise<number>[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(commands.splice(0));
  await Promise.all(servers.splice(0).map(closeServer));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-serve-cli-"));
  roots.push(root);
  mkdirSync(join(root, "world"));
  writeFileSync(
    join(root, "firedrill.json"),
    JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }),
  );
  writeFileSync(
    join(root, "world", "world.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "standalone",
      actors: [{ id: "operator", grants: [{ packageId: "notes", operationId: "read" }] }],
      state: [
        {
          action: "upsert",
          packageId: "notes",
          namespace: "notes",
          rowId: "primary",
          value: { text: "baseline" },
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "world", "notes.tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      module: "./notes.js",
      manifest: {
        schemaVersion: 1,
        id: "notes",
        version: "1.0.0",
        engine: ">=0.1.0 <0.2.0",
        capabilities: ["state.read"],
        state: [{ namespace: "notes", schema: { type: "object" } }],
        operations: [
          {
            id: "read",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "stateful",
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(root, "world", "notes.js"),
    'export default { operations: { read: (_input, context) => context.state.get("notes", "primary") } };\n',
  );
  return root;
}

interface ReadyEvent {
  readonly status: "ready";
  readonly actorId: string;
  readonly directory: string;
  readonly testsExecuted: boolean;
  readonly environment: Record<string, string>;
  readonly endpoints: Record<"http" | "mcp" | "cli", { url: string; token: string }>;
}

function start(root: string, args: readonly string[] = []) {
  const controller = new AbortController();
  controllers.push(controller);
  let output = "";
  let errors = "";
  let readyResolve: (event: ReadyEvent) => void = () => {
    throw new Error("ready promise was not initialized");
  };
  let readyReject: (error: Error) => void = () => {
    throw new Error("ready promise was not initialized");
  };
  const ready = new Promise<ReadyEvent>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Negative cases await completion only; do not leave an unhandled ready rejection.
  void ready.catch(() => {});
  const completion = runCli(["serve", "--json", ...args], {
    cwd: root,
    signal: controller.signal,
    stdout: {
      write(value) {
        output += value;
        const event = JSON.parse(value) as { status?: string; message?: string };
        if (event.status === "ready") readyResolve(JSON.parse(value) as ReadyEvent);
        if (event.status === "failed") readyReject(new Error(event.message ?? "serve failed"));
      },
    },
    stderr: {
      write(value) {
        errors += value;
      },
    },
  });
  commands.push(completion);
  return { controller, ready, completion, output: () => output, errors: () => errors };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) =>
      error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
        ? resolve()
        : reject(error),
    ),
  );
}

async function listener(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => response.end("occupied"));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

describe("standalone serve", () => {
  it("serves seeded baseline tools on all three bindings without targets or drills, then closes ports", async () => {
    const root = repository();
    const command = start(root, ["--seed", "42", "--port", "0", "--mcp-port", "0", "--cli-port", "0"]);
    const ready = await command.ready;
    expect(ready.actorId).toBe("operator");
    expect(ready.testsExecuted).toBe(false);
    expect(Object.keys(ready.endpoints).sort()).toEqual(["cli", "http", "mcp"]);
    for (const protocol of ["http", "mcp", "cli"] as const) {
      const endpoint = ready.endpoints[protocol];
      expect(new URL(endpoint.url).hostname).toBe("127.0.0.1");
      expect(ready.environment[`FIREDRILL_${protocol.toUpperCase()}_URL`]).toBe(endpoint.url);
      expect(ready.environment[`FIREDRILL_${protocol.toUpperCase()}_TOKEN`]).toBe(endpoint.token);
      expect(endpoint.token.length).toBeGreaterThan(20);
    }
    const endpoint = ready.endpoints.http;
    const response = await fetch(`${endpoint.url}/v1/operations/notes/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: { status: "ok", value: { text: "baseline" } } });
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(readdirSync(join(root, "world")).sort()).toEqual(["notes.js", "notes.tool.json", "world.json"]);
    expect(existsSync(join(root, ".firedrill", "reports"))).toBe(false);
    command.controller.abort();
    expect(await command.completion).toBe(0);
    expect(command.errors()).toBe("");
    expect(
      command
        .output()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).status),
    ).toEqual(["ready", "stopped"]);
    for (const endpoint of Object.values(ready.endpoints)) await listener(Number(new URL(endpoint.url).port));
  });

  it("does not announce readiness when cancelled during startup", async () => {
    const command = start(repository());
    command.controller.abort();
    expect(await command.completion).toBe(0);
    expect(
      command
        .output()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).status),
    ).toEqual(["stopped"]);
  });

  it("rolls back an earlier listener when a later requested port is occupied", async () => {
    const available = await listener();
    const occupied = await listener();
    await closeServer(available.server);
    const command = start(repository(), [
      "--port",
      String(available.port),
      "--mcp-port",
      String(occupied.port),
    ]);
    expect(await command.completion).toBe(1);
    expect(JSON.parse(command.output())).toMatchObject({ status: "failed", code: "framework.PORT_IN_USE" });
    await listener(available.port);
  });

  it("reports missing scenario and actor selections without readiness", async () => {
    for (const args of [
      ["--scenario", "missing"],
      ["--actor", "missing"],
    ]) {
      const command = start(repository(), args);
      expect(await command.completion).not.toBe(0);
      expect(JSON.parse(command.output()).status).toBe("failed");
      expect(command.output()).not.toContain('"status":"ready"');
    }
  });

  it.each([
    ["serve", "--port", "65536"],
    ["serve", "--port", "0x20"],
    ["serve", "--mcp-port", "-1"],
    ["serve", "--cli-port", "1.5"],
    ["serve", "--scenario", "../outside"],
    ["serve", "--actor"],
    ["run", "--mcp-port", "0"],
    ["inspect", "--scenario", "case"],
    ["serve", "--suite", "tests"],
    ["serve", "--build-hash", "0".repeat(64)],
  ])("rejects invalid or unrelated flags %j before starting", async (...args) => {
    const root = repository();
    let output = "";
    const code = await runCli([...args, "--json"], {
      cwd: root,
      stdout: {
        write(value) {
          output += value;
        },
      },
      stderr: { write() {} },
    });
    expect(code).toBe(2);
    expect(JSON.parse(output).status).toBe("failed");
    expect(existsSync(join(root, ".firedrill"))).toBe(false);
  });
});
