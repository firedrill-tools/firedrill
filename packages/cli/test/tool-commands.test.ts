import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-tool-commands-"));
  roots.push(root);
  return root;
}

async function command(root: string, args: readonly string[]) {
  let output = "";
  let errors = "";
  const code = await runCli([...args, "--json"], {
    cwd: root,
    stdout: {
      write(value) {
        output += value;
      },
    },
    stderr: {
      write(value) {
        errors += value;
      },
    },
  });
  return { code, output, errors, result: JSON.parse(output) };
}

function installedTool(root: string): void {
  const directory = join(root, "node_modules", "example-tool");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "example-tool",
      version: "1.0.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: { layer: "tool-pack", lifecycle: "active", tool: "example.tool.json" },
    }),
  );
  writeFileSync(
    join(directory, "example.tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      module: "./behavior.mjs",
      manifest: {
        schemaVersion: 1,
        id: "example",
        version: "1.0.0",
        engine: ">=0.1.0 <0.2.0",
        capabilities: [],
        operations: [
          {
            id: "echo",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "contract",
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(directory, "behavior.mjs"),
    'throw new Error("Tool setup must not execute installed behavior");\n',
  );
}

describe("Tool setup commands", () => {
  it.each(["stateful", "stateless"])(
    "creates the %s starter with real behavior, no drills, and a valid public plan",
    async (template) => {
      const root = repository();
      const created = await command(root, ["tool", "create", "inventory", "--template", template]);
      expect(created.code).toBe(0);
      expect(created.result).toMatchObject({
        schemaVersion: 1,
        command: "tool.create",
        status: "success",
        setup: { kind: "tool-created", packageId: "inventory" },
      });
      expect(created.result.setup.created.some((path: string) => path.endsWith("behavior.mjs"))).toBe(true);
      const planned = await command(root, ["plan"]);
      expect(planned.code).toBe(0);
      expect(planned.result.drills).toEqual([]);
      expect(planned.result.targets).toEqual([]);
      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(existsSync(join(root, ".firedrill"))).toBe(false);
    },
  );

  it("defaults to the stateful starter and never overwrites existing behavior", async () => {
    const root = repository();
    const created = await command(root, ["tool", "create", "inventory"]);
    expect(created.code).toBe(0);
    expect(created.result.setup.grants.map((grant: { operationId: string }) => grant.operationId)).toEqual([
      "get",
      "set",
    ]);
    const behaviorPath = created.result.setup.created.find((path: string) =>
      path.endsWith("behavior.mjs"),
    ) as string;
    writeFileSync(join(root, behaviorPath), "// existing user behavior\n");
    const repeated = await command(root, ["tool", "create", "inventory"]);
    expect(repeated.code).toBe(1);
    expect(repeated.result.code).toBe("framework.TOOL_SETUP_CONFLICT");
    expect(readFileSync(join(root, behaviorPath), "utf8")).toBe("// existing user behavior\n");
  });

  it("selects an installed package without loading behavior and is idempotent", async () => {
    const root = repository();
    installedTool(root);
    const added = await command(root, ["tool", "add", "example-tool"]);
    expect(added.code, added.output).toBe(0);
    expect(added.result).toMatchObject({
      command: "tool.add",
      status: "success",
      setup: { kind: "tool-package-added", packageId: "example" },
    });
    const config = JSON.parse(readFileSync(join(root, "firedrill.json"), "utf8"));
    expect(config.toolPackages).toEqual(["example-tool"]);
    const repeated = await command(root, ["tool", "add", "example-tool"]);
    expect(repeated.code).toBe(0);
    expect(repeated.result.setup.created).toEqual([]);
    expect(repeated.result.setup.updated).toEqual([]);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(existsSync(join(root, ".firedrill"))).toBe(false);
  });

  it("reports an uninstalled package without partial setup", async () => {
    const root = repository();
    const result = await command(root, ["tool", "add", "missing-tool"]);
    expect(result.code).toBe(1);
    expect(result.result.code).toBe("framework.TOOL_PACKAGE_NOT_INSTALLED");
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["tool", "create"],
    ["tool", "add"],
    ["tool", "create", "../outside"],
    ["tool", "create", "inventory", "--template", "unknown"],
    ["tool", "add", "example-tool", "--template", "stateful"],
    ["serve", "--template", "stateless"],
  ])("rejects invalid setup arguments %j before writing", async (...args) => {
    const root = repository();
    expect((await command(root, args)).code).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });
});
