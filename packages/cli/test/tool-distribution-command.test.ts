import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-distribution-cli-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function invoke(root: string, args: readonly string[], json = true) {
  let stdout = "",
    stderr = "";
  const code = await runCli([...args, ...(json ? ["--json"] : [])], {
    cwd: root,
    environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value) => {
        stderr += value;
      },
    },
  });
  return { code, stdout, stderr, result: json && stdout ? JSON.parse(stdout) : undefined };
}
function entry(name: string) {
  return {
    packageName: `@independent/${name}`,
    packageVersion: "1.0.0",
    description: `Synthetic ${name}`,
    lifecycle: "active",
    tool: { id: name, operations: [{ id: "read", fidelity: "stateful" }] },
  };
}

describe("independent Tools through the public CLI", () => {
  it("lists an author's local index with pagination without selecting or installing", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms"), entry("weather")] }));
    const found = await invoke(root, ["tool", "list", "--index", index, "--limit", "1", "--offset", "1"]);
    expect(found.code, found.stdout + found.stderr).toBe(0);
    expect(found.result).toMatchObject({
      command: "tool.list",
      status: "success",
      total: 2,
      limit: 1,
      offset: 1,
      tools: [{ installSource: "@independent/weather@1.0.0" }],
    });
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    const init = await invoke(root, ["init", "--index", index, "--search", "weather"]);
    expect(init.code, init.stdout).toBe(0);
    expect(init.result).toMatchObject({ status: "catalog", total: 1, tools: [{ id: "weather" }] });
  });

  it("requires install permission for an independently indexed package and does not write on refusal", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms")] }));
    const result = await invoke(root, ["init", "--index", index, "--tool", "rooms"]);
    expect(result.code).toBe(2);
    expect(result.result).toMatchObject({
      status: "setup-pending",
      code: "framework.TOOL_INSTALL_REQUIRED",
      source: "@independent/rooms@1.0.0",
    });
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(existsSync(join(root, "package.json"))).toBe(false);
  });

  it("shows an empty human-readable discovery page as 0–0 even with a nonzero offset", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms"), entry("weather")] }));
    const found = await invoke(root, ["tool", "list", "--index", index, "--offset", "50"], false);
    expect(found.code, found.stdout + found.stderr).toBe(0);
    expect(found.stdout).toContain("Showing 0–0 of 2.");
    expect(found.stdout).not.toContain("0–50");
    expect(found.stdout).not.toContain("Next page:");
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("prints actionable validation, test, and license steps after creating an independent package", async () => {
    const root = repository();
    const author = join(root, "my-tool");
    const created = await invoke(
      root,
      ["tool", "create", "record-book", "--package", "--root", author],
      false,
    );
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(created.stdout).toContain("npm run validate\n");
    expect(created.stdout).toContain("npm test\n");
    expect(created.stdout).toContain("Choose a license before sharing.");
    expect(existsSync(join(author, "package.json"))).toBe(true);
    expect(existsSync(join(author, "node_modules"))).toBe(false);
  });

  it("creates, validates and tests an independent package via command routes", async () => {
    const root = repository();
    const author = join(root, "my-tool");
    const created = await invoke(root, [
      "tool",
      "create",
      "record-book",
      "--package",
      "--name",
      "@independent/record-book",
      "--root",
      author,
    ]);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(author, "package.json"), "utf8"));
    expect(metadata.name).toBe("@independent/record-book");
    expect(metadata.firedrill.conformance.schemaVersion).toBe(1);
    expect(existsSync(join(author, "node_modules"))).toBe(false);
    expect((await invoke(author, ["validate"])).code).toBe(0);
    const tested = await invoke(author, ["tool", "test", "record-book"]);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    const repeated = await invoke(root, ["tool", "create", "record-book", "--package", "--root", author]);
    expect(repeated.code).toBe(2);
    expect(JSON.parse(readFileSync(join(author, "package.json"), "utf8"))).toEqual(metadata);
  });

  it.each([
    ["tool", "list", "rooms"],
    ["tool", "search"],
    ["tool", "search", "--install"],
    ["tool", "create", "thing", "--name", "@a/b"],
    ["tool", "add", "@a/b", "--package"],
    ["tool", "search", "--limit", "0"],
    ["tool", "search", "--offset", "-1"],
    ["validate", "--index", "tools.json"],
    ["init", "--limit", "20"],
    ["tool", "test", "thing", "--install"],
  ])("rejects unrelated flags before writing %j", async (...args) => {
    const root = repository();
    const result = await invoke(root, args);
    expect(result.code).toBe(2);
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });
});
