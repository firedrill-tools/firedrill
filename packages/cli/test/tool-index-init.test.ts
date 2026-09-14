import { execFileSync } from "node:child_process";
import {
  copyFileSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";
import { sourceArgument } from "../src/tool-distribution-command.js";
import {
  FiredrillToolInstallationError,
  installToolSource,
  type ToolInstallation,
} from "../src/tool-installation.js";
import { createTool } from "../src/tool-setup.js";

// Acquisition is independently exercised against real package managers. Here it
// is controlled so mismatched publisher metadata can be tested at the CLI seam.
vi.mock("../src/tool-installation.js", async (original) => ({
  ...(await original<typeof import("../src/tool-installation.js")>()),
  installToolSource: vi.fn(),
}));

const roots: string[] = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-index-init-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.mocked(installToolSource).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(name: string) {
  return {
    packageName: `@independent/${name}`,
    packageVersion: "1.0.0",
    description: `Synthetic ${name}`,
    lifecycle: "active",
    tool: { id: name, operations: [{ id: "read", fidelity: "stateful" }] },
  };
}

async function invoke(root: string, args: readonly string[], answers?: string[]) {
  let stdout = "",
    stderr = "";
  const questions: string[] = [];
  const remaining = answers === undefined ? undefined : [...answers];
  const code = await runCli(args, {
    cwd: root,
    environment: {},
    stdout: {
      write(value) {
        stdout += value;
      },
    },
    stderr: {
      write(value) {
        stderr += value;
      },
    },
    ...(remaining === undefined
      ? {}
      : {
          ask: async (question: string) => {
            questions.push(question);
            const answer = remaining.shift();
            if (answer === undefined) throw new Error(`Unexpected prompt: ${question}`);
            return answer;
          },
        }),
  });
  return { code, stdout, stderr, questions, remaining };
}

function installFixture(
  root: string,
  packageName: string,
  version: string,
  toolId: string,
): ToolInstallation {
  const author = repository();
  createTool({ root: author, id: toolId });
  const files = join(author, "firedrill/tools", toolId);
  const declaration = JSON.parse(readFileSync(join(files, `${toolId}.tool.json`), "utf8"));
  declaration.manifest.version = version;
  const destination = join(root, "node_modules", packageName);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "tool.json"), JSON.stringify(declaration));
  copyFileSync(join(files, "behavior.mjs"), join(destination, "behavior.mjs"));
  writeFileSync(
    join(destination, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: { layer: "tool-pack", lifecycle: "active", tool: "tool.json" },
    }),
  );
  return {
    packageName,
    version,
    source: `${packageName}@${version}`,
    resolvedSource: `${packageName}@${version}`,
    integrity: "sha512-test-fixture",
    packageManager: "npm",
  };
}

describe("independent index selection through CLI", () => {
  it("finds an explicitly selected Tool beyond the first index page and installs its pinned Git source", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    const commit = "a".repeat(40);
    const packages = Array.from({ length: 27 }, (_, value) => ({
      ...entry(`tool-${value}`),
      source: {
        kind: "git",
        url: "https://example.test/team/tools.git",
        commit,
        subdirectory: `tools/tool-${value}`,
      },
    }));
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages }));
    vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
      installFixture(target, "@independent/tool-26", "1.0.0", "tool-26"),
    );
    const result = await invoke(root, ["init", "--index", index, "--tool", "tool-26", "--install", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(installToolSource).toHaveBeenCalledExactlyOnceWith({
      root,
      source: `git+https://example.test/team/tools.git#${commit}::tools/tool-26`,
    });
    expect(JSON.parse(readFileSync(join(root, "firedrill.json"), "utf8")).toolPackages).toEqual([
      "@independent/tool-26",
    ]);
  });

  it("refuses ambiguous names before install permission can cause dependency writes", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(
      index,
      JSON.stringify({
        schemaVersion: 1,
        packages: [entry("rooms"), { ...entry("rooms"), packageVersion: "2.0.0" }],
      }),
    );
    const result = await invoke(root, ["init", "--index", index, "--tool", "rooms", "--install", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "framework.TOOL_INDEX_AMBIGUOUS",
      status: "failed",
    });
    expect(result.stdout).toContain("@independent/rooms@1.0.0");
    expect(result.stdout).toContain("@independent/rooms@2.0.0");
    expect(installToolSource).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["tools.json"]);
  });

  it("a numbered selection preserves its exact version and explains both versions in the chooser", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(
      index,
      JSON.stringify({
        schemaVersion: 1,
        packages: [entry("rooms"), { ...entry("rooms"), packageVersion: "2.0.0" }],
      }),
    );
    vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
      installFixture(target, "@independent/rooms", "1.0.0", "rooms"),
    );
    const result = await invoke(root, ["init", "--index", index], ["1", "n", "y", "manual", "n"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.remaining).toEqual([]);
    expect(result.stdout).toContain("@independent/rooms@1.0.0");
    expect(result.stdout).toContain("@independent/rooms@2.0.0");
    expect(installToolSource).toHaveBeenCalledExactlyOnceWith({ root, source: "@independent/rooms@1.0.0" });
  });

  it("rejects two explicitly selected index versions before acquiring either package", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(
      index,
      JSON.stringify({
        schemaVersion: 1,
        packages: [entry("rooms"), { ...entry("rooms"), packageVersion: "2.0.0" }],
      }),
    );
    const result = await invoke(root, [
      "init",
      "--index",
      index,
      "--tool",
      "@independent/rooms@1.0.0",
      "--tool",
      "@independent/rooms@2.0.0",
      "--install",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "framework.TOOL_SELECTION_CONFLICT",
      status: "failed",
    });
    expect(installToolSource).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["tools.json"]);
  });

  it("rejects conflicting uncataloged npm versions before acquiring either package", async () => {
    const root = repository();
    const result = await invoke(root, [
      "init",
      "--tool",
      "@independent/rooms@1.0.0",
      "--tool",
      "@independent/rooms@2.0.0",
      "--install",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "framework.TOOL_SELECTION_CONFLICT",
      status: "failed",
    });
    expect(installToolSource).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects distinct local directories declaring the same package before acquisition", async () => {
    const root = repository();
    const first = repository();
    const second = repository();
    for (const path of [first, second])
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({ name: "@independent/rooms", version: "1.0.0" }),
      );
    const result = await invoke(root, ["init", "--tool", first, "--tool", second, "--install", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "framework.TOOL_SELECTION_CONFLICT" });
    expect(installToolSource).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("deduplicates aliases of the same exact index selection", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms")] }));
    vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
      installFixture(target, "@independent/rooms", "1.0.0", "rooms"),
    );
    const result = await invoke(root, [
      "init",
      "--index",
      index,
      "--tool",
      "rooms",
      "--tool",
      "@independent/rooms@1.0.0",
      "--install",
      "--json",
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(installToolSource).toHaveBeenCalledExactlyOnceWith({ root, source: "@independent/rooms@1.0.0" });
    expect(JSON.parse(readFileSync(join(root, "firedrill.json"), "utf8")).toolPackages).toEqual([
      "@independent/rooms",
    ]);
  });

  it("reports conflicts whose identity is revealed only after acquisition without writing world selection", async () => {
    const root = repository();
    vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
      installFixture(target, "@independent/rooms", "1.0.0", "rooms"),
    );
    const result = await invoke(root, [
      "init",
      "--tool",
      "github:owner/first#main",
      "--tool",
      "github:owner/second#main",
      "--install",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "framework.TOOL_SELECTION_CONFLICT" });
    expect(result.stdout).toContain("Acquisition revealed the conflict");
    expect(installToolSource).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });

  it("treats an existing absolute local directory as a Tool source rather than a catalog search", async () => {
    const root = repository();
    const source = repository();
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "@independent/rooms", version: "1.0.0" }),
    );
    vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
      installFixture(target, "@independent/rooms", "1.0.0", "rooms"),
    );
    const result = await invoke(root, ["init"], [source, "n", "y", "manual", "n"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.remaining).toEqual([]);
    expect(installToolSource).toHaveBeenCalledExactlyOnceWith({ root, source });
    expect(result.questions.filter((question) => question.startsWith("Choose a Tool"))).toHaveLength(1);
  });

  it.each([
    { packageName: "@independent/unexpected", version: "1.0.0", toolId: "rooms" },
    { packageName: "@independent/rooms", version: "9.0.0", toolId: "rooms" },
    { packageName: "@independent/rooms", version: "1.0.0", toolId: "unexpected" },
  ])(
    "does not select acquired code that disagrees with the index identity: %j",
    async ({ packageName, version, toolId }) => {
      const root = repository();
      const index = join(root, "tools.json");
      writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms")] }));
      vi.mocked(installToolSource).mockImplementation(async ({ root: target }) =>
        installFixture(target, packageName, version, toolId),
      );
      const result = await invoke(root, ["init", "--index", index, "--tool", "rooms", "--install", "--json"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "framework.TOOL_INDEX_PACKAGE_MISMATCH",
        status: "failed",
      });
      expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    },
  );

  it("interactive rejection never invokes acquisition or writes a setup", async () => {
    const root = repository();
    const index = join(root, "tools.json");
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [entry("rooms")] }));
    const result = await invoke(root, ["init", "--index", index], ["1", "n", "n"]);
    expect(result.code).toBe(2);
    expect(result.remaining).toEqual([]);
    expect(installToolSource).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["tools.json"]);
  });

  it("prints installation failure recovery in both human and machine results", async () => {
    const root = repository();
    vi.mocked(installToolSource).mockRejectedValue(
      new FiredrillToolInstallationError(
        "Cannot load Tool source.",
        "Fix the declaration path in package.json.",
      ),
    );
    const machine = await invoke(root, ["tool", "add", "@independent/rooms@1.0.0", "--install", "--json"]);
    expect(machine.code).toBe(2);
    expect(JSON.parse(machine.stdout).suggestion).toBe("Fix the declaration path in package.json.");
    const text = await invoke(root, ["tool", "add", "@independent/rooms@1.0.0", "--install"]);
    expect(text.code).toBe(2);
    expect(text.stderr).toContain("Fix the declaration path in package.json.");
  });

  it.skipIf(process.platform === "win32")(
    "prints a literal, copyable install argument even for shell metacharacters in an index URL",
    async () => {
      const root = repository();
      const index = join(root, "tools.json");
      const source = {
        kind: "git",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell syntax is the adversarial input.
        url: "https://example.test/$(touch${IFS}INJECTED)/repo'quoted.git",
        commit: "c".repeat(40),
      };
      writeFileSync(index, JSON.stringify({ schemaVersion: 1, packages: [{ ...entry("rooms"), source }] }));
      const result = await invoke(root, ["tool", "list", "--index", index]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 operation · read");
      const line = result.stdout
        .split("\n")
        .find((value) => value.trimStart().startsWith("Install: "))
        ?.trim()
        .slice("Install: ".length);
      if (line === undefined) throw new Error("No installation instruction was printed");
      const parsed = execFileSync("sh", ["-c", `firedrill() { printf '%s\\n' "$@"; }; ${line}`], {
        cwd: root,
        encoding: "utf8",
      })
        .trimEnd()
        .split("\n");
      expect(parsed).toEqual(["tool", "add", `git+${source.url}#${source.commit}`, "--install"]);
      expect(existsSync(join(root, "INJECTED"))).toBe(false);
      expect(installToolSource).not.toHaveBeenCalled();
      expect(sourceArgument("@independent/rooms@1.0.0")).toBe("@independent/rooms@1.0.0");
    },
  );
});
