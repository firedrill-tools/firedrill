import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliWriter, runCli } from "../src/index.js";

const temporaryDirectories: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "firedrill"));
  writeFileSync(join(root, "firedrill.json"), '{"schemaVersion":1}\n');
  writeFileSync(
    join(root, "firedrill", "world.yaml"),
    "schemaVersion: 1\nid: cli-world\nactors:\n  - id: operator\n    grants:\n      - packageId: note-store\n        operationId: notes.read\n",
  );
  writeFileSync(
    join(root, "firedrill", "notes.tool.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      module: "./notes.js",
      manifest: {
        schemaVersion: 1,
        id: "note-store",
        version: "1.0.0",
        engine: ">=0.1.0 <0.2.0",
        capabilities: [],
        operations: [
          {
            id: "notes.read",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "contract",
          },
        ],
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "firedrill", "notes.js"),
    'export default { operations: { "notes.read": () => ({ text: "ready" }) } };\n',
  );
  writeFileSync(
    join(root, "firedrill", "note-agent.target.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target: {
        id: "note-agent",
        kind: "command",
        bindings: ["http"],
        executable: process.execPath,
        arguments: ["agent.mjs"],
        workingDirectory: ".",
        timeoutMs: 5_000,
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "firedrill", "read-note.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "read-note",
      targetId: "note-agent",
      actorId: "operator",
      inlineScenario: {
        virtualTimeUs: 0,
        actors: [
          {
            id: "operator",
            grants: [{ packageId: "note-store", operationId: "notes.read" }],
          },
        ],
      },
      task: { instruction: "Read the note once." },
      assertions: [
        {
          id: "read-once",
          kind: "operation.count",
          operation: { packageId: "note-store", operationId: "notes.read" },
          comparison: { operator: "equals", value: 1 },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(root, "agent.mjs"),
    [
      'let input = "";',
      "for await (const chunk of process.stdin) input += chunk;",
      "const invocation = JSON.parse(input);",
      'const response = await fetch(process.env.FIREDRILL_HTTP_URL + "/v1/operations/note-store/notes.read", {',
      '  method: "POST",',
      '  headers: { authorization: "Bearer " + process.env.FIREDRILL_HTTP_TOKEN, "content-type": "application/json" },',
      "  body: JSON.stringify({ arguments: {} })",
      "});",
      "const result = await response.json();",
      "if (!response.ok) { process.stderr.write(JSON.stringify(result)); process.exit(1); }",
      "process.stdout.write(JSON.stringify({ outcome: result.outcome }));",
    ].join("\n"),
  );
  return root;
}

function addSecondDrillAndSuite(root: string): void {
  const originalPath = join(root, "firedrill", "read-note.drill.json");
  const second = JSON.parse(readFileSync(originalPath, "utf8")) as {
    id: string;
    tags?: string[];
    assertions: Array<{ id: string }>;
  };
  second.id = "audit-note";
  second.tags = ["nightly"];
  const assertion = second.assertions[0];
  if (assertion === undefined) throw new Error("fixture has no assertion");
  assertion.id = "audit-read-once";
  writeFileSync(join(root, "firedrill", "audit-note.drill.json"), `${JSON.stringify(second)}\n`);

  const original = JSON.parse(readFileSync(originalPath, "utf8")) as { tags?: string[] };
  original.tags = ["smoke"];
  writeFileSync(originalPath, `${JSON.stringify(original)}\n`);
  writeFileSync(
    join(root, "firedrill", "pull-request.suite.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "pull-request",
      drills: ["read-note"],
      tags: ["nightly"],
      concurrency: 2,
      retries: 0,
    })}\n`,
  );
}

function addConformanceSuite(root: string): void {
  writeFileSync(
    join(root, "firedrill", "note-store-conformance.suite.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "note-store-conformance",
      drills: ["read-note"],
    })}\n`,
  );
}

function addApplicationCallback(root: string): void {
  const declarationPath = join(root, "firedrill", "notes.tool.json");
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as {
    manifest: Record<string, unknown> & { capabilities: string[] };
  };
  declaration.manifest.capabilities.push("event.emit");
  declaration.manifest.events = [
    {
      id: "note.read",
      payloadSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
        additionalProperties: false,
      },
    },
  ];
  declaration.manifest.callbacks = [
    {
      id: "notify-application",
      eventId: "note.read",
      receiverId: "application",
      method: "POST",
      path: "/callbacks/notes",
      idempotencyHeader: "Idempotency-Key",
      signature: { kind: "hmac-sha256", header: "X-Firedrill-Signature", prefix: "sha256=" },
    },
  ];
  writeFileSync(declarationPath, `${JSON.stringify(declaration)}\n`);
  writeFileSync(
    join(root, "firedrill", "notes.js"),
    [
      "export default {",
      '  operations: { "notes.read": (_input, context) => {',
      '    const value = { text: "ready" };',
      '    context.events.emit("note.read", value);',
      "    return value;",
      "  } },",
      "  callbacks: {",
      '    "notify-application": { encode: ({ deliveryId, payload }) => ({',
      '      body: { kind: "json", value: { deliveryId, ...payload } },',
      "    }) },",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const drillPath = join(root, "firedrill", "read-note.drill.json");
  const drill = JSON.parse(readFileSync(drillPath, "utf8")) as { assertions: unknown[] };
  drill.assertions.push({
    id: "application-notified",
    kind: "callback.count",
    callback: { packageId: "note-store", callbackId: "notify-application" },
    phase: "delivered",
    comparison: { operator: "equals", value: 1 },
  });
  writeFileSync(drillPath, `${JSON.stringify(drill)}\n`);
}

function installNotePack(root: string, lifecycle: "active" | "deprecated" | "revoked"): void {
  const packageRoot = join(root, "node_modules", "@example", "note-pack");
  mkdirSync(packageRoot, { recursive: true });
  const declaration = join(root, "firedrill", "notes.tool.json");
  const behavior = join(root, "firedrill", "notes.js");
  writeFileSync(join(packageRoot, "notes.tool.json"), readFileSync(declaration));
  writeFileSync(join(packageRoot, "notes.js"), readFileSync(behavior));
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@example/note-pack",
      version: "1.0.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: {
        layer: "tool-pack",
        tool: "notes.tool.json",
        lifecycle,
      },
    })}\n`,
  );
  rmSync(declaration);
  rmSync(behavior);
  writeFileSync(
    join(root, "firedrill.json"),
    `${JSON.stringify({ schemaVersion: 1, toolPackages: ["@example/note-pack"] })}\n`,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-cli-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function capture() {
  let value = "";
  const writer: CliWriter = {
    write(chunk) {
      value += chunk;
    },
  };
  return { writer, value: () => value };
}

async function invoke(
  root: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string | undefined>>,
  ask?: (question: string) => Promise<string>,
) {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(arguments_, {
    cwd: root,
    stdout: stdout.writer,
    stderr: stderr.writer,
    ...(environment === undefined ? {} : { environment }),
    ...(ask === undefined ? {} : { ask }),
  });
  return { code, stdout: stdout.value(), stderr: stderr.value() };
}

describe("local CLI front door", () => {
  it("shows concise command-specific help without requiring a project", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);

    const overview = await invoke(root, ["--help"]);
    expect(overview.code).toBe(0);
    expect(overview.stdout).toMatch(/Commands:[\s\S]*run[\s\S]*tool/);

    const init = await invoke(root, ["init", "--help"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/Choose a clear starting path[\s\S]*coding-agent[\s\S]*never replaces/);
    expect(init.stdout).not.toContain("Run options:");

    const tool = await invoke(root, ["tool", "--help"]);
    expect(tool.code).toBe(0);
    expect(tool.stdout).toMatch(/Create, select, inspect, and prove Tool behavior/);
    expect(tool.stdout).toMatch(/installed package named[\s\S]*toolPackages/);

    const test = await invoke(root, ["tool", "test", "--help"]);
    expect(test.code).toBe(0);
    expect(test.stdout).toMatch(/conformance drills twice[\s\S]*same seed/);
    expect(test.stdout).not.toContain("Tool contribution options:");

    const contribute = await invoke(root, ["tool", "contribute", "--help"]);
    expect(contribute.code).toBe(0);
    expect(contribute.stdout).toMatch(
      /authored in this repository[\s\S]*Nothing\s+is uploaded and no pull request is opened/,
    );

    const world = await invoke(root, ["world", "--help"]);
    expect(world.code).toBe(0);
    expect(world.stdout).toMatch(/active synthetic world[\s\S]*world call/);

    const agent = await invoke(root, ["agent", "--help"]);
    expect(agent.code).toBe(0);
    expect(agent.stdout).toMatch(/Claude Agent SDK[\s\S]*normal CLI and SDK work without/);

    const inspect = await invoke(root, ["inspect", "--help"]);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toMatch(/loopback-only, offline[\s\S]*Repository source stays authoritative/);
  });

  it("launches the local inspector through the public CLI without exposing its control token", async () => {
    const root = repository();
    const stdout = capture();
    const stderr = capture();
    const cancellation = new AbortController();
    const opened: string[] = [];
    const code = await runCli(["inspect", "--port", "0"], {
      cwd: root,
      stdout: stdout.writer,
      stderr: stderr.writer,
      signal: cancellation.signal,
      openUrl: async (url) => {
        opened.push(url);
        const page = await fetch(url);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('name="firedrill-token"');
        cancellation.abort();
      },
    });

    expect(code, stderr.value()).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stdout.value()).toMatch(/Inspector ready[\s\S]*cli-world[\s\S]*Press Ctrl\+C to stop/);
    expect(stdout.value()).not.toMatch(/Bearer|token/i);
  });

  it("keeps inspector JSON mode non-interactive and machine-readable", async () => {
    const root = repository();
    const stdout = capture();
    const stderr = capture();
    const cancellation = new AbortController();
    const writer: CliWriter = {
      write(value) {
        stdout.writer.write(value);
        if (value.includes('"status":"ready"')) cancellation.abort();
      },
    };
    let opened = false;
    const code = await runCli(["inspect", "--json"], {
      cwd: root,
      stdout: writer,
      stderr: stderr.writer,
      signal: cancellation.signal,
      openUrl: async () => {
        opened = true;
      },
    });

    expect(code, stderr.value()).toBe(0);
    expect(opened).toBe(false);
    expect(JSON.parse(stdout.value())).toMatchObject({
      command: "inspect",
      status: "ready",
      worldId: "cli-world",
      tools: 1,
      drills: 1,
      accountRequired: false,
    });
  });

  it("discovers and calls an active world through the public CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const token = "cli-world-token-0000000001";
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"unauthorized"}\n');
        return;
      }
      if (request.method === "GET" && request.url === "/v1/tools") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify({
            schemaVersion: 1,
            tools: [
              {
                id: "inventory",
                version: "1.0.0",
                operations: [
                  {
                    id: "items.reserve",
                    inputSchema: { type: "object" },
                    outputSchema: { type: "object" },
                    idempotency: "required",
                    fidelity: "stateful",
                  },
                ],
              },
            ],
          })}\n`,
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify({
            schemaVersion: 1,
            callId: "call_cli0001",
            correlationId: "corr_cli0001",
            outcome: { status: "ok", value: { reserved: true } },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const environment = {
      FIREDRILL_CLI_URL: `http://127.0.0.1:${address.port}`,
      FIREDRILL_CLI_TOKEN: token,
    };
    try {
      const tools = await invoke(root, ["world", "tools", "--json"], environment);
      expect(tools.code, tools.stderr).toBe(0);
      expect(JSON.parse(tools.stdout)).toMatchObject({
        command: "world.tools",
        status: "success",
        tools: [{ id: "inventory", operations: [{ id: "items.reserve" }] }],
      });

      const called = await invoke(
        root,
        [
          "world",
          "call",
          "inventory",
          "items.reserve",
          "--input",
          '{"sku":"sku-7"}',
          "--idempotency-key",
          "reserve-sku-7",
          "--json",
        ],
        environment,
      );
      expect(called.code, called.stderr).toBe(0);
      expect(JSON.parse(called.stdout)).toMatchObject({
        command: "world.call",
        status: "completed",
        outcome: { status: "ok", value: { reserved: true } },
      });
      expect(requests).toEqual([{ arguments: { sku: "sku-7" }, idempotencyKey: "reserve-sku-7" }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("explains the product loop and gives an actionable first-project diagnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);

    const help = await invoke(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/fresh synthetic world[\s\S]*connects your existing[\s\S]*verifies state/);

    const missing = await invoke(root, []);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(
      /project manifest does not exist[\s\S]*Add firedrill\.json at the repository root[\s\S]*https:\/\/docs\.firedrill\.run\/quickstart/,
    );
  });

  it("inspects onboarding without writing and offers four explicit paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ devDependencies: { vitest: "latest", "@modelcontextprotocol/sdk": "latest" } })}\n`,
    );
    writeFileSync(join(root, "agent.ts"), "export const agent = {};\n");

    const result = await invoke(root, ["init", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      status: "inspection",
      detection: {
        languages: ["javascript-typescript"],
        testRunners: ["vitest"],
        agentLibraries: ["@modelcontextprotocol/sdk"],
        candidateAgentFiles: ["agent.ts"],
        firedrillProject: false,
      },
      choices: [
        { path: "firedrill-agent", recommended: true },
        { path: "coding-agent", recommended: false },
        { path: "template", recommended: false },
        { path: "manual", recommended: false },
      ],
    });
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("detects common Python agent libraries from bounded repository files", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\nname = "python-agent"\ndependencies = ["anthropic==1.0.0", "mcp>=1"]\n',
    );
    writeFileSync(join(root, "agent.py"), "from anthropic import Anthropic\n");

    const result = await invoke(root, ["init", "--json"]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      detection: {
        languages: ["python"],
        agentLibraries: ["anthropic", "mcp"],
        candidateAgentFiles: ["agent.py"],
      },
    });
  });

  it("does not report Firedrill's own packages as product-agent libraries", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "customer-agent",
        private: true,
        dependencies: {
          "@firedrill/agent": "0.0.0",
          "@firedrill/cli": "0.0.0",
          ai: "5.0.0",
        },
      })}\n`,
    );

    const result = await invoke(root, ["init", "--json"]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "inspection",
      detection: { agentLibraries: ["ai"] },
    });
  });

  it("guides an interactive developer without changing non-interactive init", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ dependencies: { next: "latest", "@prisma/client": "latest" } })}\n`,
    );
    writeFileSync(join(root, "agent.ts"), "export const agent = {};\n");
    const answers = ["c", "internal-queue", "manual", "n"];
    const questions: string[] = [];
    const result = await invoke(root, ["init"], { ANTHROPIC_API_KEY: "test-key" }, async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(questions).toHaveLength(4);
    expect(questions.join(" ")).not.toContain("first drill");
    expect(result.stdout).toMatch(/stateful fake tools locally[\s\S]*Tool source validated: internal-queue/);
    expect(existsSync(join(root, "firedrill", "tools", "internal-queue", "behavior.mjs"))).toBe(true);
    expect(existsSync(join(root, ".agents", "firedrill", "BRIEF.md"))).toBe(false);
    const plan = await invoke(root, ["plan", "--json"]);
    expect(plan.code, plan.stdout).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ drills: [], targets: [], scenarios: [] });
  });

  it("installs one canonical coding-agent skill and never overwrites a conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const initialized = await invoke(root, ["init", "--path", "coding-agent", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const skillPath = join(root, ".agents", "skills", "firedrill", "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toMatch(/Definition of done[\s\S]*firedrill validate --json/);
    expect(existsSync(join(root, ".agents", "skills", "firedrill", "references", "bindings.md"))).toBe(true);
    expect(readFileSync(join(root, ".agents", "firedrill", "BRIEF.md"), "utf8")).toMatch(
      /bounded, read-only inspection[\s\S]*Authoring task/,
    );
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".firedrill/\n");
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      written: expect.arrayContaining([".gitignore"]),
      updated: [],
    });

    const repeated = await invoke(root, ["init", "--path", "coding-agent", "--json"]);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      status: "initialized",
      written: [],
      updated: [],
      unchanged: expect.arrayContaining([".gitignore"]),
    });

    writeFileSync(skillPath, "user-owned instructions\n");
    const conflict = await invoke(root, ["init", "--path", "coding-agent", "--json"]);
    expect(conflict.code).toBe(2);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      status: "failed",
      code: "framework.INIT_CONFLICT",
      paths: [".agents/skills/firedrill/SKILL.md"],
    });
    expect(readFileSync(skillPath, "utf8")).toBe("user-owned instructions\n");
  });

  it("installs the Firedrill Agent authoring assets and fails clearly before spending without a key", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const initialized = await invoke(root, ["init", "--path", "firedrill-agent", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      status: "initialized",
      path: "firedrill-agent",
      next: expect.arrayContaining([expect.stringContaining("ANTHROPIC_API_KEY")]),
    });
    expect(existsSync(join(root, ".agents", "skills", "firedrill", "SKILL.md"))).toBe(true);

    const missingKey = await invoke(root, ["agent", "--json"], {});
    expect(missingKey.code).toBe(2);
    expect(JSON.parse(missingKey.stdout)).toEqual({
      schemaVersion: 1,
      command: "agent",
      status: "failed",
      code: "agent.API_KEY_MISSING",
      message: "ANTHROPIC_API_KEY is not set. Export your Anthropic API key, then run firedrill agent again.",
    });

    const help = await invoke(root, ["agent", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/40 turns[\s\S]*\$2[\s\S]*15-minute/);

    const invalidTimeout = await invoke(root, ["agent", "--timeout-ms", "999", "--json"]);
    expect(invalidTimeout.code).toBe(2);
    expect(JSON.parse(invalidTimeout.stdout)).toMatchObject({
      status: "failed",
      code: "framework.INVALID_ARGUMENT",
      message: "--timeout-ms must be an integer from 1000 through 7200000",
    });
  });

  it("preserves existing ignore rules and appends generated runtime state exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n!.firedrill/\n");

    const initialized = await invoke(root, ["init", "--path", "manual", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ updated: [".gitignore"] });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n!.firedrill/\n.firedrill/\n");

    const repeated = await invoke(root, ["init", "--path", "manual", "--json"]);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ updated: [] });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n!.firedrill/\n.firedrill/\n");
  });

  it("scaffolds an organized template that validates and runs locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const initialized = await invoke(root, ["init", "--path", "template", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const initialization = JSON.parse(initialized.stdout) as {
      status: string;
      path: string;
      written: readonly string[];
    };
    expect(initialization).toMatchObject({ status: "initialized", path: "template" });
    expect(initialization.written).toEqual(
      expect.arrayContaining([
        "firedrill/README.md",
        "firedrill/world.yaml",
        "firedrill/tools/resource-store/resource-store.tool.yaml",
        "firedrill/tools/resource-store/behavior.mjs",
        "firedrill/scenarios/baseline.scenario.yaml",
        "firedrill/targets/starter-agent.target.yaml",
        "firedrill/drills/changes-resource.drill.yaml",
        "firedrill/suites/resource-store-conformance.suite.yaml",
        "firedrill-example/agent.mjs",
      ]),
    );
    for (const path of initialization.written.filter((path) => path !== ".gitignore")) {
      expect(readFileSync(join(root, ...path.split("/")), "utf8"), path).not.toContain("\r");
    }

    const format = await invoke(root, ["format", "--check", "--json"]);
    expect(format.code, `${format.stdout}\n${format.stderr}`).toBe(0);
    expect(JSON.parse(format.stdout)).toMatchObject({ status: "success", changed: [] });

    const validation = await invoke(root, ["validate", "--json"]);
    expect(validation.code, `${validation.stdout}\n${validation.stderr}`).toBe(0);
    const run = await invoke(root, ["changes-resource", "--json"]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      verdict: "passed",
      drills: [{ drillId: "changes-resource", verdict: "passed" }],
    });
    const conformance = await invoke(root, ["tool", "test", "resource-store", "--json"]);
    expect(conformance.code, `${conformance.stdout}\n${conformance.stderr}`).toBe(0);
    expect(JSON.parse(conformance.stdout)).toMatchObject({
      command: "tool.test",
      status: "passed",
      suiteId: "resource-store-conformance",
      deterministic: true,
    });
  });

  it("runs the same resource IDs from custom nested folders and descriptive filenames", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const initialized = await invoke(root, ["init", "--path", "template", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);

    mkdirSync(join(root, "test"));
    const sourceRoot = join(root, "test", "agent-environment");
    renameSync(join(root, "firedrill"), sourceRoot);
    mkdirSync(join(sourceRoot, "starting-point"));
    renameSync(join(sourceRoot, "world.yaml"), join(sourceRoot, "starting-point", "seed.yaml"));
    renameSync(join(sourceRoot, "tools"), join(sourceRoot, "dependencies"));
    renameSync(join(sourceRoot, "scenarios"), join(sourceRoot, "situations"));
    renameSync(join(sourceRoot, "targets"), join(sourceRoot, "connections"));
    renameSync(join(sourceRoot, "drills"), join(sourceRoot, "checks"));
    renameSync(join(sourceRoot, "suites"), join(sourceRoot, "groups"));
    renameSync(
      join(sourceRoot, "checks", "changes-resource.drill.yaml"),
      join(sourceRoot, "checks", "first-write.drill.yaml"),
    );
    writeFileSync(
      join(root, "firedrill.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRoot: "test/agent-environment",
        world: "starting-point/seed.yaml",
      })}\n`,
    );

    const validation = await invoke(root, ["validate", "--json"]);
    expect(validation.code, `${validation.stdout}\n${validation.stderr}`).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ status: "success", diagnostics: [] });
    const run = await invoke(root, ["run", "changes-resource", "--json"]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      verdict: "passed",
      drills: [{ drillId: "changes-resource", verdict: "passed" }],
    });
    const conformance = await invoke(root, ["tool", "test", "resource-store", "--json"]);
    expect(conformance.code, `${conformance.stdout}\n${conformance.stderr}`).toBe(0);
    expect(JSON.parse(conformance.stdout)).toMatchObject({ status: "passed", deterministic: true });
  });

  it("creates a compilable manual world shell without a fake drill", async () => {
    const root = mkdtempSync(join(tmpdir(), "firedrill-cli-"));
    temporaryDirectories.push(root);
    const initialized = await invoke(root, ["init", "--path", "manual", "--json"]);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      written: expect.arrayContaining([
        "firedrill/tools/local-probe/local-probe.tool.yaml",
        "firedrill/tools/local-probe/local-probe.mjs",
      ]),
    });
    const validation = await invoke(root, ["validate", "--json"]);
    expect(validation.code, `${validation.stdout}\n${validation.stderr}`).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({
      status: "success",
      worldId: "local-world",
      tools: [{ id: "local-probe", operations: 1 }],
      drills: [],
    });
  });

  it("watches repository changes without overlapping or watching its own reports", async () => {
    const root = repository();
    const cancellation = new AbortController();
    const events: Array<{
      sequence: number;
      trigger: string;
      changedFiles: string[];
      exitCode: number;
      result: { verdict: string };
    }> = [];
    let output = "";
    const stdout: CliWriter = {
      write(chunk) {
        output += chunk;
        let newline = output.indexOf("\n");
        while (newline >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (line.length > 0) {
            events.push(JSON.parse(line));
            if (events.length === 1) appendFileSync(join(root, "agent.mjs"), "\n");
            if (events.length === 2) cancellation.abort();
          }
          newline = output.indexOf("\n");
        }
      },
    };
    const stderr = capture();
    const timeout = setTimeout(() => cancellation.abort(), 4_000);
    const code = await runCli(["run", "read-note", "--watch", "--json"], {
      cwd: root,
      stdout,
      stderr: stderr.writer,
      signal: cancellation.signal,
    });
    clearTimeout(timeout);

    expect(code).toBe(0);
    expect(stderr.value()).toBe("");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sequence: 1,
      trigger: "initial",
      changedFiles: [],
      exitCode: 0,
      result: { verdict: "passed" },
    });
    expect(events[1]).toMatchObject({
      sequence: 2,
      trigger: "change",
      exitCode: 0,
      result: { verdict: "passed" },
    });
    expect(events[1]?.changedFiles).toContain("agent.mjs");
    expect(events[1]?.changedFiles.some((path) => path.startsWith(".firedrill/"))).toBe(false);
  });

  it("validates and plans a repository with stable JSON output", async () => {
    const root = repository();
    const validation = await invoke(root, ["validate", "--json"]);
    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "validate",
      status: "success",
      worldId: "cli-world",
      tools: [{ id: "note-store", operations: 1 }],
      next: {
        command: "firedrill run",
        local: true,
        accountRequired: false,
      },
    });
    expect(validation.stderr).toBe("");

    const humanValidation = await invoke(root, ["validate"]);
    expect(humanValidation.code).toBe(0);
    expect(humanValidation.stdout).toMatch(
      /World valid.*\nRun your first drill: firedrill run \(local, no account\)/,
    );

    addSecondDrillAndSuite(root);
    const plan = await invoke(root, ["plan"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(
      /World cli-world[\s\S]*Tool note-store@1.0.0[\s\S]*Drill audit-note[\s\S]*target note-agent; scenario inline; 1 trial; contract; tags nightly[\s\S]*Drill read-note[\s\S]*Suite pull-request[\s\S]*1 explicit drill; 1 tag; concurrency 2; retries 0/,
    );

    const jsonPlan = await invoke(root, ["plan", "--json"]);
    expect(jsonPlan.code).toBe(0);
    expect(JSON.parse(jsonPlan.stdout)).toMatchObject({
      drillDetails: [
        { id: "audit-note", targetId: "note-agent", scenario: "inline", tags: ["nightly"] },
        { id: "read-note", targetId: "note-agent", scenario: "inline", tags: ["smoke"] },
      ],
      suiteDetails: [
        {
          id: "pull-request",
          drills: ["read-note"],
          tags: ["nightly"],
          concurrency: 2,
          retries: 0,
        },
      ],
    });
  });

  it("materializes and verifies executable behavior before reporting a successful build", async () => {
    const root = repository();
    const result = await invoke(root, ["build", "--json"]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout) as { status: string; buildDirectory?: string };
    expect(output.status).toBe("success");
    expect(output.buildDirectory).toMatch(/\.firedrill\/builds\/[0-9a-f]{64}$/);
  });

  it("inspects, validates, and conformance-tests a repository Tool", async () => {
    const root = repository();
    const inspected = await invoke(root, ["tool", "inspect", "note-store", "--json"]);
    expect(inspected.code, `${inspected.stdout}\n${inspected.stderr}`).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      command: "tool.inspect",
      status: "success",
      tool: {
        toolId: "note-store",
        sourcePath: "firedrill/notes.tool.json",
        manifest: { operations: [{ id: "notes.read" }] },
      },
    });

    const validated = await invoke(root, ["tool", "validate", "note-store", "--json"]);
    expect(validated.code, `${validated.stdout}\n${validated.stderr}`).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      command: "tool.validate",
      status: "success",
      tool: { toolId: "note-store", executable: true },
    });

    addConformanceSuite(root);
    const tested = await invoke(root, ["tool", "test", "note-store", "--json"]);
    expect(tested.code, `${tested.stdout}\n${tested.stderr}`).toBe(0);
    const output = JSON.parse(tested.stdout) as {
      status: string;
      deterministic: boolean;
      violations: unknown[];
      runs: Array<{ drills: Array<{ trials: Array<{ htmlReport: string }> }> }>;
    };
    expect(output).toMatchObject({
      command: "tool.test",
      status: "passed",
      deterministic: true,
      violations: [],
    });
    expect(output.runs).toHaveLength(2);
    expect(existsSync(output.runs[0]?.drills[0]?.trials[0]?.htmlReport ?? "")).toBe(true);
    expect(existsSync(output.runs[1]?.drills[0]?.trials[0]?.htmlReport ?? "")).toBe(true);

    const contributed = await invoke(root, [
      "tool",
      "contribute",
      "note-store",
      "--accept-apache-2.0",
      "--json",
    ]);
    expect(contributed.code, `${contributed.stdout}\n${contributed.stderr}`).toBe(0);
    const bundle = JSON.parse(contributed.stdout) as {
      status: string;
      bundle: { directory: string; files: string[] };
    };
    expect(bundle).toMatchObject({
      command: "tool.contribute",
      status: "prepared",
      bundle: {
        files: expect.arrayContaining([
          "CONTRIBUTION.json",
          "conformance.json",
          "source/firedrill/notes.js",
          "source/firedrill/notes.tool.json",
        ]),
      },
    });
    expect(existsSync(join(bundle.bundle.directory, "SHA256SUMS"))).toBe(true);
    expect(readFileSync(join(bundle.bundle.directory, "CONTRIBUTION.json"), "utf8")).not.toContain(root);
  });

  it("shows nonfatal installed-package warnings to human and JSON callers", async () => {
    const root = repository();
    installNotePack(root, "deprecated");

    const validated = await invoke(root, ["validate"]);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toMatch(/World valid/);
    expect(validated.stderr).toMatch(/firedrill\.json:1:\d+ FD1403[\s\S]*is deprecated/);

    const inspected = await invoke(root, ["tool", "inspect", "note-store", "--json"]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: "success",
      tool: {
        origin: { kind: "npm", packageName: "@example/note-pack" },
        diagnostics: [{ code: "FD1403", severity: "warning" }],
      },
    });

    const run = await invoke(root, ["run", "read-note", "--json"]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "completed",
      verdict: "passed",
      diagnostics: [{ code: "FD1403", severity: "warning" }],
    });
  });

  it("makes a missing Tool conformance suite actionable", async () => {
    const result = await invoke(repository(), ["tool", "test", "note-store", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "tool.test",
      status: "failed",
      code: "framework.TOOL_CONFORMANCE_SUITE_REQUIRED",
      details: {
        expected: "note-store-conformance",
        suggestion: "add a repository-owned drill suite or pass --suite <id>",
      },
    });
  });

  it("requires explicit contribution attestation before executing the contribution flow", async () => {
    const result = await invoke(repository(), ["tool", "contribute", "note-store", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "tool.contribute",
      status: "failed",
      code: "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED",
    });
  });

  it("runs a complete drill suite locally and writes one evidence bundle per trial", async () => {
    const root = repository();
    const result = await invoke(root, ["run", "read-note", "--trials", "2", "--json"]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      verdict: string;
      buildHash: string;
      reportIndex: string;
      drills: Array<{
        verdict: string;
        trials: Array<{
          result: {
            identity: { seed: string };
            stateHash: string;
            assertionResults: Array<{ assertionId: string; status: string }>;
          };
          htmlReport: string;
          junitReport: string;
          worldFilePath: string;
        }>;
      }>;
    };
    expect(output.verdict).toBe("passed");
    expect(output.reportIndex).toBe(join(root, ".firedrill", "reports", "index.html"));
    expect(readFileSync(output.reportIndex, "utf8")).toContain("Drill reports");
    expect(output.drills[0]).toMatchObject({ verdict: "passed" });
    expect(output.drills[0]?.trials).toHaveLength(2);
    for (const trial of output.drills[0]?.trials ?? []) {
      expect(existsSync(trial.worldFilePath)).toBe(true);
      expect(existsSync(trial.htmlReport)).toBe(true);
      expect(existsSync(trial.junitReport)).toBe(true);
    }

    const drillPath = join(root, "firedrill", "read-note.drill.json");
    const failingDrill = JSON.parse(readFileSync(drillPath, "utf8")) as {
      assertions: Array<{ comparison: { value: number } }>;
    };
    const firstAssertion = failingDrill.assertions[0];
    if (firstAssertion === undefined) throw new Error("fixture has no assertion");
    firstAssertion.comparison.value = 2;
    writeFileSync(drillPath, `${JSON.stringify(failingDrill)}\n`);
    const failing = await invoke(root, [
      "run",
      "read-note",
      "--report-dir",
      ".firedrill/failing-reports",
      "--json",
    ]);
    expect(failing.code).toBe(1);
    const failedOutput = JSON.parse(failing.stdout) as typeof output;
    expect(failedOutput.verdict).toBe("failed");
    expect(failedOutput.reportIndex).toBe(join(root, ".firedrill", "failing-reports", "index.html"));

    const original = failedOutput.drills[0]?.trials[0];
    expect(original).toBeDefined();
    const reproduction = await invoke(root, [
      "run",
      "read-note",
      "--build-hash",
      failedOutput.buildHash,
      "--seed",
      original?.result.identity.seed ?? "0",
      "--trials",
      "1",
      "--report-dir",
      ".firedrill/reproduced-reports",
      "--json",
    ]);
    expect(reproduction.code, `${reproduction.stdout}\n${reproduction.stderr}`).toBe(1);
    const reproduced = JSON.parse(reproduction.stdout) as typeof output;
    expect(reproduced.verdict).toBe("failed");
    expect(reproduced.drills[0]?.trials[0]?.result).toMatchObject({
      stateHash: original?.result.stateHash,
      assertionResults: original?.result.assertionResults,
    });

    const defaultRun = await invoke(repository(), []);
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.stdout).toMatch(/PASSED {2}read-note[\s\S]*HTML report:/);
    expect(defaultRun.stdout.match(/^All reports: /gm)).toHaveLength(1);
  });

  it("routes signed world callbacks through explicit local receiver bindings", async () => {
    const root = repository();
    addApplicationCallback(root);
    const received: Array<{
      body: Buffer;
      headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ body: Buffer.concat(chunks), headers: request.headers });
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const secret = "local-test-secret";
    try {
      const result = await invoke(
        root,
        [
          "run",
          "read-note",
          "--callback-receiver",
          `application=http://127.0.0.1:${String(address.port)}`,
          "--callback-secret-env",
          "application=CALLBACK_SECRET",
          "--json",
        ],
        { CALLBACK_SECRET: secret },
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        verdict: "passed",
        drills: [
          {
            trials: [
              {
                result: {
                  assertionResults: [
                    { assertionId: "read-once", status: "passed" },
                    { assertionId: "application-notified", status: "passed", actual: 1 },
                  ],
                },
              },
            ],
          },
        ],
      });
      expect(received).toHaveLength(1);
      const delivery = received[0];
      expect(delivery).toBeDefined();
      expect(delivery?.headers["idempotency-key"]).toMatch(/^delivery_/);
      expect(delivery?.headers["x-firedrill-signature"]).toBe(
        `sha256=${createHmac("sha256", secret)
          .update(delivery?.body ?? Buffer.alloc(0))
          .digest("hex")}`,
      );
      expect(JSON.parse(delivery?.body.toString("utf8") ?? "null")).toMatchObject({ text: "ready" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("rejects unsafe or incomplete callback receiver configuration before a drill starts", async () => {
    const root = repository();
    expect(
      (await invoke(root, ["run", "--callback-receiver", "application=https://example.com", "--json"])).code,
    ).toBe(2);
    const missingSecret = await invoke(root, [
      "run",
      "--callback-receiver",
      "application=http://127.0.0.1:3000",
      "--callback-secret-env",
      "application=CALLBACK_SECRET",
      "--json",
    ]);
    expect(missingSecret.code).toBe(2);
    expect(JSON.parse(missingSecret.stdout)).toMatchObject({
      code: "framework.INVALID_ARGUMENT",
      message: "callback receiver application requires environment variable CALLBACK_SECRET",
    });
  });

  it("selects named suites and stable shards through the public command", async () => {
    const root = repository();
    addSecondDrillAndSuite(root);

    const suite = await invoke(root, ["run", "--suite", "pull-request", "--json"]);
    expect(suite.code, `${suite.stdout}\n${suite.stderr}`).toBe(0);
    expect(JSON.parse(suite.stdout)).toMatchObject({
      selection: { suite: "pull-request", drillIds: ["audit-note", "read-note"] },
      drills: [{ drillId: "audit-note" }, { drillId: "read-note" }],
    });

    const shard = await invoke(root, ["run", "--tag", "nightly", "--shard", "1/1", "--json"]);
    expect(shard.code, `${shard.stdout}\n${shard.stderr}`).toBe(0);
    expect(JSON.parse(shard.stdout)).toMatchObject({
      selection: { drillIds: ["audit-note"], tags: ["nightly"], shard: { index: 0, total: 1 } },
    });
  });

  it("retains every failed retry attempt with stable logical seed identity", async () => {
    const root = repository();
    const drillPath = join(root, "firedrill", "read-note.drill.json");
    const drill = JSON.parse(readFileSync(drillPath, "utf8")) as {
      assertions: Array<{ comparison: { value: number } }>;
    };
    const assertion = drill.assertions[0];
    if (assertion === undefined) throw new Error("fixture has no assertion");
    assertion.comparison.value = 2;
    writeFileSync(drillPath, `${JSON.stringify(drill)}\n`);

    const result = await invoke(root, ["run", "read-note", "--retries", "1", "--seed", "41", "--json"]);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout) as {
      drills: Array<{
        trials: Array<{
          seed: string;
          attempts: Array<{ result: { identity: { seed: string; attempt: number; attemptLimit: number } } }>;
        }>;
      }>;
    };
    const trial = output.drills[0]?.trials[0];
    expect(trial?.seed).toBe("41");
    expect(trial?.attempts.map((attempt) => attempt.result.identity)).toEqual([
      expect.objectContaining({ seed: "41", attempt: 1, attemptLimit: 2 }),
      expect.objectContaining({ seed: "41", attempt: 2, attemptLimit: 2 }),
    ]);
  });

  it("compares verified local runs and exposes compatibility before deltas", async () => {
    const root = repository();
    const baselineRun = await invoke(root, [
      "run",
      "read-note",
      "--report-dir",
      ".firedrill/baseline",
      "--json",
    ]);
    expect(baselineRun.code).toBe(0);
    const baseline = JSON.parse(baselineRun.stdout) as {
      drills: Array<{ trials: Array<{ reportDirectory: string }> }>;
    };
    const baselineReport = baseline.drills[0]?.trials[0]?.reportDirectory;
    if (baselineReport === undefined) throw new Error("baseline report was not written");

    writeFileSync(
      join(root, "agent.mjs"),
      "process.stdout.write(JSON.stringify({ completedWithoutCallingTheWorld: true }));\n",
    );
    const candidateRun = await invoke(root, [
      "run",
      "read-note",
      "--report-dir",
      ".firedrill/candidate",
      "--json",
    ]);
    expect(candidateRun.code).toBe(1);
    const candidate = JSON.parse(candidateRun.stdout) as typeof baseline;
    const candidateReport = candidate.drills[0]?.trials[0]?.reportDirectory;
    if (candidateReport === undefined) throw new Error("candidate report was not written");

    const compared = await invoke(root, ["compare", baselineReport, candidateReport, "--json"]);
    expect(compared.code, `${compared.stdout}\n${compared.stderr}`).toBe(0);
    expect(JSON.parse(compared.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "compare",
      status: "success",
      compatibility: { status: "exact_inputs", canAttributeBehaviorChange: true },
      outcome: "changed",
      baseline: { verdict: "passed" },
      candidate: { verdict: "failed" },
      changes: {
        verdictChanged: true,
        operationCounts: [{ subject: "note-store.notes.read", baseline: 1, candidate: 0, delta: -1 }],
      },
    });

    const human = await invoke(root, ["compare", baselineReport, candidateReport]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(
      /EXACT INPUTS — changed[\s\S]*Baseline passed[\s\S]*Tool calls note-store\.notes\.read: 1 → 0 \(-1\)/,
    );

    const missing = await invoke(root, ["compare", join(root, "missing"), candidateReport, "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: "failed",
      code: "framework.REPORT_INVALID",
    });
  });

  it("verifies a portable local report and rejects a tampered artifact", async () => {
    const root = repository();
    const run = await invoke(root, ["run", "read-note", "--json"]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    const result = JSON.parse(run.stdout) as {
      drills: Array<{
        trials: Array<{
          reportDirectory: string;
          htmlReport: string;
          result: { identity: { runId: string } };
        }>;
      }>;
    };
    const trial = result.drills[0]?.trials[0];
    if (trial === undefined) throw new Error("run produced no trial report");

    const verified = await invoke(root, ["report", "verify", trial.reportDirectory, "--json"]);
    expect(verified.code, `${verified.stdout}\n${verified.stderr}`).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "report.verify",
      status: "verified",
      runId: trial.result.identity.runId,
      runStatus: "sealed",
      verdict: "passed",
      drillId: "read-note",
    });

    const human = await invoke(root, ["report", "verify", trial.reportDirectory]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/Report verified.*passed[\s\S]*Drill read-note/);

    appendFileSync(trial.htmlReport, "tampered\n");
    const tampered = await invoke(root, ["report", "verify", trial.reportDirectory, "--json"]);
    expect(tampered.code).toBe(1);
    expect(JSON.parse(tampered.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "report.verify",
      status: "failed",
      code: "framework.REPORT_INVALID",
      details: { reporterCode: "reporter.ARTIFACT_MISMATCH" },
    });
  });

  it("checks and writes deterministic formatting without hiding invalid source", async () => {
    const root = repository();
    const check = await invoke(root, ["format", "--check", "--json"]);
    expect(check.code).toBe(1);
    expect(JSON.parse(check.stdout)).toMatchObject({ status: "changes_required" });

    expect((await invoke(root, ["format"])).code).toBe(0);
    const clean = await invoke(root, ["format", "--check", "--json"]);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ status: "success", changed: [] });

    writeFileSync(join(root, "firedrill", "world.yaml"), "schemaVersion: [\n");
    const invalid = await invoke(root, ["validate", "--json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      status: "failed",
      diagnostics: [{ code: "FD1101" }],
    });
  });

  it("rejects unknown commands and command-specific option misuse", async () => {
    const root = repository();
    const unknown = await invoke(root, ["unknown"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Available drills: read-note/);
    expect((await invoke(root, ["validate", "--check"])).code).toBe(2);
  });

  it("treats help as non-executing even when it appears where an option value was expected", async () => {
    const root = repository();
    const result = await invoke(root, ["run", "--report-dir", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Run drills against the repository world");
    expect(result.stderr).toBe("");
    expect(existsSync(join(root, "--help"))).toBe(false);
  });

  it("keeps invalid invocations machine-readable whenever --json is present", async () => {
    const root = repository();
    const cases: readonly (readonly string[])[] = [
      ["--unknown", "--json"],
      ["run", "--seed", "-1", "--json"],
      ["validate", "--check", "--json"],
      ["compare", "--json"],
      ["report", "--json"],
      ["tool", "--json"],
    ];
    for (const arguments_ of cases) {
      const result = await invoke(root, arguments_);
      expect(result.code, arguments_.join(" ")).toBe(2);
      expect(result.stderr, arguments_.join(" ")).toBe("");
      expect(JSON.parse(result.stdout), arguments_.join(" ")).toMatchObject({
        schemaVersion: 1,
        status: "failed",
        code: "framework.INVALID_ARGUMENT",
      });
    }
  });

  it("returns a stable machine error without leaking an unexpected exception", async () => {
    const stderr = capture();
    let output = "";
    let writes = 0;
    const code = await runCli(["--help", "--json"], {
      cwd: repository(),
      stdout: {
        write(value) {
          writes += 1;
          if (writes === 1) throw new Error("unexpected output failure with private details");
          output += value;
        },
      },
      stderr: stderr.writer,
    });
    expect(code).toBe(1);
    expect(stderr.value()).toBe("");
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      command: "run",
      status: "failed",
      code: "framework.INTERNAL_ERROR",
      message: "Firedrill failed internally. No report was produced.",
    });
  });
});
