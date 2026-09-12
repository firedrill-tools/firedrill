import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileWorld, inspectInstalledToolPackage } from "@firedrill/compiler";
import { testTool } from "@firedrill/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createToolPackage } from "../src/tool-package-scaffold.js";
import { addToolPackage } from "../src/tool-setup.js";

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-independent-tool-"));
  roots.push(root);
  return root;
}
interface PackageMetadata {
  readonly license: string;
  readonly scripts: Record<string, string>;
  readonly firedrill: {
    readonly layer: string;
    readonly conformance: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}
function read(path: string): PackageMetadata {
  return JSON.parse(readFileSync(path, "utf8"));
}
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function consumerFixture() {
  const root = temporary();
  const author = join(root, "author");
  createToolPackage({ root: author, id: "independent-records", packageName: "@someone/records" });
  const manifestPath = join(author, "package.json");
  const metadata = read(manifestPath);
  metadata.scripts.prepare = "node -e \"require('fs').writeFileSync('executed-marker','bad')\"";
  write(manifestPath, metadata);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: author, encoding: "utf8" }),
  );
  const archive = join(author, packed[0].filename);
  expect(existsSync(join(author, "executed-marker"))).toBe(false);
  expect(packed[0].files.map((file: { path: string }) => file.path)).toContain("test/conformance.mjs");
  expect(packed[0].files.some((file: { path: string }) => file.path.startsWith(".firedrill/"))).toBe(false);
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  write(join(consumer, "package.json"), { name: "independent-consumer", version: "1.0.0", private: true });
  execFileSync(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", archive],
    { cwd: consumer, stdio: "pipe" },
  );
  addToolPackage({ root: consumer, packageName: "@someone/records" });
  return { author, consumer, installed: join(consumer, "node_modules/@someone/records") };
}

describe("independently owned Tool packages", () => {
  it("ignores root pack output without ignoring vendored source archives", () => {
    const root = join(temporary(), "author");
    createToolPackage({ root, id: "independent-tool" });
    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
    mkdirSync(join(root, ".firedrill-tools"));
    writeFileSync(join(root, "independent-tool-1.0.0.tgz"), "generated pack output");
    writeFileSync(join(root, ".firedrill-tools/pinned-tool.tgz"), "reviewed source archive");
    const checkIgnore = (path: string) =>
      spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", path], {
        cwd: root,
        encoding: "utf8",
      });
    const generated = checkIgnore("independent-tool-1.0.0.tgz");
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stdout.trim()).toBe("independent-tool-1.0.0.tgz");
    const vendored = checkIgnore(".firedrill-tools/pinned-tool.tgz");
    expect(vendored.status, vendored.stderr).toBe(1);
    expect(vendored.stdout).toBe("");
  });

  it.each(["stateful", "stateless"] as const)(
    "scaffolds a self-contained %s package with passing author conformance",
    async (template) => {
      const root = temporary();
      const result = createToolPackage({ root: join(root, "new-package"), id: "independent-tool", template });
      expect(result).toMatchObject({
        kind: "tool-package-created",
        packageName: "firedrill-tool-independent-tool",
      });
      const metadata = read(join(result.root, "package.json"));
      expect(metadata.license).toBe("UNLICENSED");
      expect(readFileSync(join(result.root, ".gitignore"), "utf8")).toContain("node_modules/");
      expect(metadata.firedrill.conformance).toEqual({
        schemaVersion: 1,
        project: "firedrill.json",
        suite: "conformance",
      });
      const compilation = await compileWorld({ repositoryRoot: result.root, materialize: false });
      expect(compilation.status, JSON.stringify(compilation.diagnostics)).toBe("success");
      const tested = await testTool({ root: result.root, toolId: "independent-tool" });
      expect(tested.status, JSON.stringify(tested.violations)).toBe("passed");
      expect(tested.suiteSource).toBe("repository");
      expect(tested.deterministic).toBe(true);
    },
    30000,
  );

  it("packs the authored suite and runs it from an unrelated installed consumer without modifying dependencies", async () => {
    const fixture = await consumerFixture();
    writeFileSync(join(fixture.installed, ".netrc"), "private local configuration\n");
    mkdirSync(join(fixture.installed, ".firedrill-tools"));
    writeFileSync(join(fixture.installed, ".firedrill-tools/private.txt"), "not conformance source\n");
    const before = readdirSync(fixture.installed, { recursive: true }).sort();
    const result = await testTool({ root: fixture.consumer, toolId: "independent-records" });
    expect(result.status, JSON.stringify(result.violations)).toBe("passed");
    expect(result.suiteSource).toBe("package");
    expect(result.tool.origin).toMatchObject({
      kind: "npm",
      packageName: "@someone/records",
      packageVersion: "1.0.0",
    });
    expect(result.runs.every((run) => run.verdict === "passed")).toBe(true);
    expect(readdirSync(fixture.installed, { recursive: true }).sort()).toEqual(before);
    expect(existsSync(join(fixture.installed, ".firedrill"))).toBe(false);
    expect(existsSync(join(fixture.installed, "executed-marker"))).toBe(false);
    expect(existsSync(join(result.tool.repositoryRoot, ".netrc"))).toBe(false);
    expect(existsSync(join(result.tool.repositoryRoot, ".firedrill-tools"))).toBe(false);
  }, 30000);

  it("prefers a consumer's own suite and never falls back for an explicit missing suite", async () => {
    const fixture = await consumerFixture();
    for (const path of [
      "baseline.scenario.json",
      "conformance.suite.json",
      "agent.target.json",
      "tool-behavior.drill.json",
    ])
      cpSync(join(fixture.author, "firedrill", path), join(fixture.consumer, "firedrill", path));
    cpSync(join(fixture.author, "test"), join(fixture.consumer, "test"), { recursive: true });
    writeFileSync(
      join(fixture.installed, "test/conformance.mjs"),
      "throw new Error('package suite must not execute');\n",
    );
    const tested = await testTool({ root: fixture.consumer, toolId: "independent-records" });
    expect(tested.status, JSON.stringify(tested.violations)).toBe("passed");
    expect(tested.suiteSource).toBe("repository");
    await expect(
      testTool({ root: fixture.consumer, toolId: "independent-records", suite: "absent" }),
    ).rejects.toMatchObject({ code: "framework.SUITE_NOT_FOUND" });
  }, 30000);

  it("rejects conformance metadata that escapes its package or claims an unknown schema", async () => {
    const fixture = await consumerFixture();
    const path = join(fixture.installed, "package.json");
    const metadata = read(path);
    for (const conformance of [
      { schemaVersion: 1, project: "../firedrill.json", suite: "conformance" },
      { schemaVersion: 2, project: "firedrill.json", suite: "conformance" },
    ]) {
      write(path, { ...metadata, firedrill: { ...metadata.firedrill, conformance } });
      expect(
        inspectInstalledToolPackage({ repositoryRoot: fixture.consumer, packageName: "@someone/records" })
          .status,
      ).toBe("failed");
    }
  }, 30000);

  it("rejects symlinks in package-authored conformance source", async () => {
    const fixture = await consumerFixture();
    symlinkSync(join(fixture.author, "README.md"), join(fixture.installed, "external-readme"));
    await expect(testTool({ root: fixture.consumer, toolId: "independent-records" })).rejects.toMatchObject({
      code: "framework.TOOL_CONFORMANCE_FAILED",
      message: expect.stringContaining("symbolic links"),
    });
  }, 30000);

  it("refuses a shipped suite that substitutes another implementation of the selected Tool", async () => {
    const fixture = await consumerFixture();
    const alternative = join(fixture.installed, "alternative");
    cpSync(join(fixture.installed, "firedrill"), join(alternative, "source"), { recursive: true });
    write(join(alternative, "firedrill.json"), {
      schemaVersion: 1,
      sourceRoot: "source",
      world: "world.json",
    });
    const behavior = join(alternative, "source/tools/independent-records/behavior.mjs");
    writeFileSync(
      behavior,
      readFileSync(behavior, "utf8").replace(
        "const record = { value: input.value };",
        "const record = { value: 'replacement' };",
      ),
    );
    const path = join(fixture.installed, "package.json");
    const metadata = read(path);
    write(path, {
      ...metadata,
      firedrill: {
        ...metadata.firedrill,
        conformance: { schemaVersion: 1, project: "alternative/firedrill.json", suite: "conformance" },
      },
    });
    await expect(testTool({ root: fixture.consumer, toolId: "independent-records" })).rejects.toMatchObject({
      code: "framework.TOOL_CONFORMANCE_FAILED",
      message: expect.stringContaining("exact installed Tool"),
    });
  }, 30000);

  it("never overwrites nonempty directories or accepts invalid names", () => {
    const root = temporary();
    writeFileSync(join(root, "existing.txt"), "unchanged");
    expect(() => createToolPackage({ root, id: "valid" })).toThrow(/never overwritten/);
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("unchanged");
    expect(() =>
      createToolPackage({ root: join(root, "empty"), id: "valid", packageName: "../escape" }),
    ).toThrow(/valid Tool id/);
    expect(existsSync(join(root, "empty"))).toBe(false);
  });
});
