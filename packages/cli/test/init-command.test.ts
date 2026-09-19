import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAgentCommand } from "../src/agent-command.js";
import { runCli } from "../src/index.js";
import { installReadyTool, toolInstallPlan } from "../src/install-tool.js";
import { readyTools } from "../src/tool-catalog.js";

vi.mock("../src/agent-command.js", () => ({ executeAgentCommand: vi.fn(async () => 0) }));
vi.mock("../src/install-tool.js", async (original) => ({
  ...(await original<typeof import("../src/install-tool.js")>()),
  installReadyTool: vi.fn(async () => false),
}));

const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(installReadyTool).mockResolvedValue(false);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-tool-first-"));
  roots.push(root);
  return root;
}

function installed(root: string, name: string, id: string, value = id, version = "0.1.0-rc.1"): void {
  const pack = join(root, "node_modules", name);
  mkdirSync(pack, { recursive: true });
  writeFileSync(
    join(pack, "package.json"),
    JSON.stringify({
      name,
      version,
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: { layer: "tool-pack", lifecycle: "active", tool: "tool.json", starter: "starter.json" },
    }),
  );
  writeFileSync(
    join(pack, "tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      module: "./behavior.mjs",
      manifest: {
        schemaVersion: 1,
        id,
        version,
        engine: ">=0.1.0 <0.2.0",
        capabilities: ["state.read"],
        state: [
          {
            namespace: "records",
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
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
    join(pack, "behavior.mjs"),
    'export default { operations: { read: (_input, context) => context.state.get("records", "primary") } };\n',
  );
  writeFileSync(
    join(pack, "starter.json"),
    JSON.stringify({
      schemaVersion: 1,
      virtualTimeUs: 0,
      state: [
        { action: "upsert", packageId: id, namespace: "records", rowId: "primary", value: { text: value } },
      ],
    }),
  );
}

async function invoke(
  root: string,
  args: readonly string[],
  answers?: string[],
  environment: Record<string, string> = {},
) {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const code = await runCli(args, {
    cwd: root,
    environment,
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    ...(answers === undefined
      ? {}
      : {
          ask: async (question: string) => {
            questions.push(question);
            return answers.shift() ?? "n";
          },
        }),
  });
  return { code, stdout, stderr, questions };
}

describe("tool-first init", () => {
  it("creates a portable Python starter when invoked by the Python distribution", async () => {
    const root = repository();
    const result = await invoke(root, ["init", "--path", "template", "--json"], undefined, {
      FIREDRILL_PYTHON_EXECUTABLE: "/a/private/venv/bin/python",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(root, "firedrill-example/agent.py"))).toBe(true);
    expect(existsSync(join(root, "firedrill-example/agent.mjs"))).toBe(false);
    const target = readFileSync(join(root, "firedrill/targets/starter-agent.target.yaml"), "utf8");
    expect(target).toContain("executable: python");
    expect(target).not.toContain("/a/private/");
    expect(readFileSync(join(root, "firedrill/README.md"), "utf8")).toContain("agent.py");
    expect((await invoke(root, ["validate", "--json"])).code).toBe(0);
  });

  it("keeps bare non-TTY init and catalog search read-only and key-free", async () => {
    const root = repository();
    const search = await invoke(root, ["init", "--search", "gmail", "--json"]);
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({
      status: "catalog",
      tools: [{ id: "gmail", operations: expect.any(Array), limitations: expect.any(Array) }],
    });
    const bare = await invoke(root, ["init", "--json"]);
    expect(JSON.parse(bare.stdout)).toMatchObject({ status: "inspection", tools: expect.any(Array) });
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(installReadyTool).not.toHaveBeenCalled();
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  it("creates a no-key custom Tool with no scenario, target, or drill", async () => {
    const root = repository();
    const result = await invoke(root, ["init", "--custom", "inventory-book", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "initialized",
      path: "custom",
      testsExecuted: false,
      sourceValidated: true,
    });
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(executeAgentCommand).not.toHaveBeenCalled();
    expect(installReadyTool).not.toHaveBeenCalled();
  });

  it("runs the new custom Tool and its inspector through init --start, then cleans up on cancellation", async () => {
    const root = repository();
    const controller = new AbortController();
    type Ready = { status: "ready"; url: string; endpoints: { http: { url: string; token: string } } };
    let resolveReady: (event: Ready) => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<Ready>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const completion = runCli(["init", "--custom", "message-store", "--start", "--json"], {
      cwd: root,
      signal: controller.signal,
      environment: {},
      stdout: {
        write(text) {
          const event = JSON.parse(text);
          if (event.status === "ready") resolveReady(event);
          if (event.status === "failed") rejectReady(new Error(text));
        },
      },
      stderr: {
        write(text) {
          rejectReady(new Error(text));
        },
      },
    });
    let inspectorUrl: string | undefined;
    try {
      const event = await ready;
      inspectorUrl = event.url;
      expect((await fetch(event.url)).status).toBe(200);
      const { url, token } = event.endpoints.http;
      const set = await fetch(`${url}/v1/operations/message-store/set`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ arguments: { id: "draft-1", value: "written by real tool" } }),
      });
      expect(set.status).toBe(200);
      const get = await fetch(`${url}/v1/operations/message-store/get`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ arguments: { id: "draft-1" } }),
      });
      expect(await get.json()).toMatchObject({
        outcome: { status: "ok", value: { value: "written by real tool" } },
      });
      expect(executeAgentCommand).not.toHaveBeenCalled();
      expect(existsSync(join(root, ".env"))).toBe(false);
    } finally {
      controller.abort();
      expect(await completion).toBe(0);
    }
    if (inspectorUrl !== undefined) await expect(fetch(inspectorUrl)).rejects.toThrow();
  });

  it("composes two unrelated installed packages atomically with authored baseline rows and exact grants", async () => {
    const root = repository();
    installed(root, "@example/dispatch-pack", "dispatch-book", "dispatch baseline");
    installed(root, "@example/room-pack", "room-index", "room baseline");
    const result = await invoke(root, [
      "init",
      "--tool",
      "@example/dispatch-pack",
      "--tool",
      "@example/room-pack",
      "--json",
    ]);
    expect(result.code, result.stdout).toBe(0);
    const world = JSON.parse(readFileSync(join(root, "firedrill/world.json"), "utf8"));
    expect(world.actors).toEqual([
      {
        id: "local-dev",
        grants: [
          { packageId: "dispatch-book", operationId: "read" },
          { packageId: "room-index", operationId: "read" },
        ],
      },
    ]);
    expect(world.state.map((row: { value: unknown }) => row.value)).toEqual([
      { text: "dispatch baseline" },
      { text: "room baseline" },
    ]);
    expect(JSON.parse(result.stdout).setup.starterRows).toBe(2);
    expect(existsSync(join(root, "firedrill/tools/local-probe"))).toBe(false);
    const before = readFileSync(join(root, "firedrill/world.json"), "utf8");
    expect((await invoke(root, ["init", "--tool", "@example/dispatch-pack", "--json"])).code).toBe(0);
    expect(readFileSync(join(root, "firedrill/world.json"), "utf8")).toBe(before);
  });

  it("does not write partial source when one selected package has an invalid starter", async () => {
    const root = repository();
    installed(root, "@example/first", "first");
    installed(root, "@example/second", "second");
    writeFileSync(
      join(root, "node_modules/@example/second/starter.json"),
      JSON.stringify({
        schemaVersion: 1,
        state: [
          {
            action: "upsert",
            packageId: "first",
            namespace: "records",
            rowId: "foreign",
            value: { text: "wrong owner" },
          },
        ],
      }),
    );
    const result = await invoke(root, [
      "init",
      "--tool",
      "@example/first",
      "--tool",
      "@example/second",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });

  it("uses explicit pinned installation permission and resumes safely on failure", async () => {
    const root = repository();
    const pack = join(root, "node_modules/@firedrill-tools/gmail");
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({
        name: "@firedrill-tools/gmail",
        exports: { "./package.json": "./package.json" },
      }),
    );
    const denied = await invoke(root, ["init", "--tool", "gmail", "--json"]);
    expect(JSON.parse(denied.stdout)).toMatchObject({
      status: "setup-pending",
      code: "framework.TOOL_INSTALL_REQUIRED",
    });
    expect(installReadyTool).not.toHaveBeenCalled();
    const failed = await invoke(root, ["init", "--tool", "gmail", "--install", "--json"]);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      code: "framework.TOOL_INSTALL_FAILED",
      install: {
        executable: "firedrill",
        arguments: ["tool", "add", expect.stringContaining("::packages/gmail"), "--install"],
      },
      next: expect.stringContaining("--install"),
    });
    expect(installReadyTool).toHaveBeenCalledOnce();
    expect(installReadyTool).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        id: "gmail",
        installSource: expect.stringContaining("::packages/gmail"),
      }),
      undefined,
    );
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    const tool = readyTools(root, "gmail")[0];
    if (tool === undefined) throw new Error("catalog fixture missing");
    expect(toolInstallPlan(root, tool)).toMatchObject({
      executable: "npm",
      arguments: ["install", "--save-dev", "--ignore-scripts", `${tool.packageName}@${tool.version}`],
    });
    vi.mocked(installReadyTool).mockImplementation(async (target) => {
      installed(target, tool.packageName, tool.id, tool.id, tool.version);
      return true;
    });
    const success = await invoke(root, ["init", "--tool", "gmail", "--install", "--json"]);
    expect(success.code, success.stdout).toBe(0);
    expect(JSON.parse(success.stdout)).toMatchObject({ status: "initialized", setup: { starterRows: 1 } });
  });

  it("requires authoring consent, does not prompt for keys, and keeps the custom Tool usable", async () => {
    const root = repository();
    const result = await invoke(root, [
      "init",
      "--custom",
      "drafts",
      "--authoring",
      "firedrill-agent",
      "--allow-agent",
      "--json",
    ]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("agent.API_KEY_MISSING");
    expect(result.stdout).toContain("firedrill agent --workflow environment");
    expect(result.questions).toEqual([]);
    expect(executeAgentCommand).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".env"))).toBe(false);
    const authorizedRoot = repository();
    const authorized = await invoke(
      authorizedRoot,
      ["init", "--custom", "messages", "--authoring", "firedrill-agent", "--allow-agent", "--json"],
      undefined,
      { ANTHROPIC_API_KEY: "fixture-key-do-not-print" },
    );
    expect(authorized.code).toBe(0);
    expect(executeAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agentWorkflow: "environment" }),
      expect.anything(),
    );
    expect(authorized.stdout).not.toContain("fixture-key-do-not-print");
  });

  it("offers optional customization after selecting ready tools and permits another Tool", async () => {
    const root = repository();
    installed(root, "@example/mail", "mail-box");
    installed(root, "@example/tickets", "ticket-box");
    const result = await invoke(
      root,
      ["init"],
      ["@example/mail", "y", "@example/tickets", "n", "manual", "n"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.questions.some((question) => question.includes("Customize"))).toBe(true);
    expect(result.questions.join(" ")).not.toMatch(/first drill|prove|API key/);
    expect(JSON.parse(readFileSync(join(root, "firedrill.json"), "utf8")).toolPackages).toEqual([
      "@example/mail",
      "@example/tickets",
    ]);
  });

  it.each([
    ["init", "--tool", "thing", "--custom", "other"],
    ["init", "--search", "queue", "--install"],
    ["init", "--custom", "thing", "--allow-agent"],
    ["init", "--start"],
    ["run", "--custom", "thing"],
  ])("rejects ambiguous or unrelated setup options %j", async (...args) => {
    const root = repository();
    expect((await invoke(root, [...args, "--json"])).code).toBe(2);
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });
});
