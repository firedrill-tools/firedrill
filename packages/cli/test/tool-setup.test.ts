import {
  existsSync,
  linkSync,
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
import { compileWorld } from "@firedrill/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToolPackages } from "../src/index.js";
import { addToolPackage, createTool, FiredrillToolSetupError } from "../src/tool-setup.js";

const failure = vi.hoisted(() => ({
  writesBeforeFailure: -1,
  beforeFailure: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeSync(descriptor: number, body: Uint8Array, offset: number, length: number, position: number) {
      if (failure.writesBeforeFailure === 0) {
        failure.writesBeforeFailure = -1;
        failure.beforeFailure?.();
        throw new Error("Injected write failure");
      }
      if (failure.writesBeforeFailure > 0) failure.writesBeforeFailure -= 1;
      return original.writeSync(descriptor, body, offset, length, position);
    },
  };
});

const directories: string[] = [];
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-tool-setup-"));
  directories.push(root);
  return root;
}

function write(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function read(root: string, path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function filePaths(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

afterEach(() => {
  failure.writesBeforeFailure = -1;
  failure.beforeFailure = undefined;
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local Tool setup", () => {
  it.each(["inventory-ledger", "room-index", "message-vault"])(
    "creates a compilable stateful %s without an agent or drill",
    async (id) => {
      const root = repository();
      const setup = createTool({ root, id });
      expect(setup.kind).toBe("tool-created");
      expect(setup.grants).toEqual([
        { packageId: id, operationId: "get" },
        { packageId: id, operationId: "set" },
      ]);
      expect(filePaths(root)).toEqual(
        [
          ".gitignore",
          "firedrill.json",
          `firedrill/tools/${id}/behavior.mjs`,
          `firedrill/tools/${id}/${id}.tool.json`,
          "firedrill/world.json",
        ].sort(),
      );
      expect(read(root, "firedrill/world.json")).toEqual({
        schemaVersion: 1,
        id: "local-world",
        actors: [{ id: "local-dev", grants: setup.grants }],
      });
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      expect(compiled.status, JSON.stringify(compiled.diagnostics)).toBe("success");
      if (compiled.status !== "success") return;
      const tool = compiled.build.worldIr.tools[0];
      expect(tool?.id).toBe(id);
      expect(tool?.operations.map((operation) => operation.id)).toEqual(["get", "set"]);
      expect(tool?.http.map((route) => [route.method, route.path])).toEqual([
        ["GET", `/${id}/{id}`],
        ["PUT", `/${id}/{id}`],
      ]);
      expect(compiled.build.worldIr.drills).toEqual([]);
      expect(compiled.build.worldIr.targets).toEqual([]);
      expect(compiled.build.worldIr.scenarios).toEqual([]);
    },
  );

  it("creates a pure stateless declaration and repeats without overwriting files", async () => {
    const root = repository();
    const first = createTool({ root, id: "text-mirror", template: "stateless" });
    const again = createTool({ root, id: "text-mirror", template: "stateless" });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toEqual([
      ".gitignore",
      "firedrill/tools/text-mirror/behavior.mjs",
      "firedrill/tools/text-mirror/text-mirror.tool.json",
    ]);
    expect(first.grants).toEqual([{ packageId: "text-mirror", operationId: "echo" }]);
    const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
    expect(compiled.status, JSON.stringify(compiled.diagnostics)).toBe("success");
    if (compiled.status !== "success") return;
    expect(compiled.build.worldIr.tools[0]?.state).toEqual([]);
    expect(compiled.build.worldIr.tools[0]?.capabilities).toEqual([]);
  });

  it.each(["simulation/source", "."])(
    "honors sourceRoot %s and leaves the existing config and actors byte-for-byte intact",
    async (sourceRoot) => {
      const root = repository();
      const config = `${JSON.stringify({ schemaVersion: 1, sourceRoot, world: "baseline.json", toolPackages: [] })}\n`;
      const world = `${JSON.stringify({ schemaVersion: 1, id: "my-world", actors: [{ id: "reviewer", grants: [] }] })}\n`;
      write(root, "firedrill.json", config);
      write(root, join(sourceRoot, "baseline.json"), world);
      write(root, ".gitignore", "dist/\n!.firedrill/\n");
      const setup = createTool({ root, id: "case-notes" });
      expect(readFileSync(join(root, "firedrill.json"), "utf8")).toBe(config);
      expect(readFileSync(join(root, sourceRoot, "baseline.json"), "utf8")).toBe(world);
      expect(setup.updated).toEqual([".gitignore"]);
      expect(setup.grantGuidance.join(" ")).toContain("were not changed");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("dist/\n!.firedrill/\n.firedrill/\n");
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      expect(compiled.status, JSON.stringify(compiled.diagnostics)).toBe("success");
    },
  );

  it("preflights all destinations before making any changes", () => {
    const root = repository();
    write(root, "firedrill/tools/event-book/behavior.mjs", "// existing user source\n");
    expect(() => createTool({ root, id: "event-book" })).toThrow(FiredrillToolSetupError);
    expect(filePaths(root)).toEqual(["firedrill/tools/event-book/behavior.mjs"]);
    expect(readFileSync(join(root, "firedrill/tools/event-book/behavior.mjs"), "utf8")).toBe(
      "// existing user source\n",
    );
  });

  it("rolls back owned files and an ignore-rule update after a later write fails", () => {
    const root = repository();
    write(root, ".gitignore", "dist/\n");
    write(root, "keep.txt", "untouched\n");
    failure.writesBeforeFailure = 3;
    expect(() => createTool({ root, id: "transaction-book" })).toThrow(FiredrillToolSetupError);
    expect(filePaths(root)).toEqual([".gitignore", "keep.txt"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("untouched\n");
    expect(existsSync(join(root, "firedrill"))).toBe(false);
  });

  it("preserves another writer's changes to a new file during rollback", () => {
    const root = repository();
    const behavior = "firedrill/tools/shared-book/behavior.mjs";
    failure.writesBeforeFailure = 2;
    failure.beforeFailure = () => write(root, behavior, "// another writer's edit\n");
    expect(() => createTool({ root, id: "shared-book" })).toThrow(FiredrillToolSetupError);
    expect(filePaths(root)).toEqual([behavior]);
    expect(readFileSync(join(root, behavior), "utf8")).toBe("// another writer's edit\n");
  });

  it.each(["../escape", "BadName", "a/b", ".env"])("rejects invalid Tool id %s before writing", (id) => {
    const root = repository();
    expect(() => createTool({ root, id })).toThrow(
      expect.objectContaining({ code: "framework.TOOL_SETUP_INVALID_ARGUMENT" }),
    );
    expect(filePaths(root)).toEqual([]);
  });

  it("rejects symlink parents, symlink destinations and hard-linked mutable files", () => {
    const outside = repository();
    for (const destination of ["firedrill", ".gitignore", "firedrill.json"]) {
      const root = repository();
      symlinkSync(outside, join(root, destination));
      expect(() => createTool({ root, id: "entry-log" })).toThrow(FiredrillToolSetupError);
      expect(filePaths(outside)).toEqual([]);
    }
    const root = repository();
    write(outside, "ignore.txt", "keep\n");
    linkSync(join(outside, "ignore.txt"), join(root, ".gitignore"));
    expect(() => createTool({ root, id: "entry-log" })).toThrow(FiredrillToolSetupError);
    expect(readFileSync(join(outside, "ignore.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });

  it.each(["../outside", ".env", ".git", ".firedrill", "node_modules"])(
    "refuses unsafe sourceRoot %s",
    (sourceRoot) => {
      const root = repository();
      write(root, "firedrill.json", { schemaVersion: 1, sourceRoot });
      expect(() => createTool({ root, id: "record-index" })).toThrow(FiredrillToolSetupError);
      expect(filePaths(root)).toEqual(["firedrill.json"]);
    },
  );
});

function installedPack(root: string, packageName: string, id: string, yaml = false): void {
  const directory = join("node_modules", packageName);
  write(root, join(directory, "package.json"), {
    name: packageName,
    version: "1.0.0",
    type: "module",
    exports: { "./package.json": "./package.json" },
    firedrill: { layer: "tool-pack", lifecycle: "active", tool: yaml ? "pack.tool.yaml" : "pack.tool.json" },
  });
  const declaration = {
    schemaVersion: 1,
    module: "./behavior.mjs",
    manifest: {
      schemaVersion: 1,
      id,
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: [],
      operations: [
        {
          id: "entries.read",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "contract",
        },
      ],
    },
  };
  write(
    root,
    join(directory, yaml ? "pack.tool.yaml" : "pack.tool.json"),
    yaml
      ? `schemaVersion: 1\nmodule: ./behavior.mjs\nmanifest:\n  schemaVersion: 1\n  id: ${id}\n  version: 1.0.0\n  engine: ">=0.1.0 <0.2.0"\n  capabilities: []\n  operations:\n    - id: entries.read\n      inputSchema: { type: object }\n      outputSchema: { type: object }\n      idempotency: none\n      fidelity: contract\n`
      : declaration,
  );
  write(
    root,
    join(directory, "behavior.mjs"),
    'throw new Error("Tool setup must never execute this module");\nexport default { operations: { "entries.read": () => ({}) } };\n',
  );
}

describe("installed Tool package selection", () => {
  it("composes packages through the public source setup API without importing behavior", async () => {
    const root = repository();
    installedPack(root, "@example/note-archive", "note-archive");
    installedPack(root, "@example/room-index", "room-index", true);
    const result = addToolPackages({ root, packageNames: ["@example/note-archive", "@example/room-index"] });
    expect(result.packageIds).toEqual(["note-archive", "room-index"]);
    expect(read(root, "firedrill/world.json")).toEqual({
      schemaVersion: 1,
      id: "local-world",
      actors: [{ id: "local-dev", grants: result.grants }],
    });
    expect(result.grants).toEqual([
      { packageId: "note-archive", operationId: "entries.read" },
      { packageId: "room-index", operationId: "entries.read" },
    ]);
    expect((await compileWorld({ repositoryRoot: root, materialize: false })).status).toBe("success");
    const previous = readFileSync(join(root, "firedrill/world.json"), "utf8");
    expect(
      addToolPackages({ root, packageNames: ["@example/note-archive", "@example/room-index"] }).created,
    ).toEqual([]);
    expect(readFileSync(join(root, "firedrill/world.json"), "utf8")).toBe(previous);
    installedPack(root, "@example/conflict", "room-index");
    expect(() => addToolPackages({ root, packageNames: ["@example/conflict"] })).toThrow(
      /Two selected packages own Tool/,
    );
    expect(readFileSync(join(root, "firedrill/world.json"), "utf8")).toBe(previous);
  });
  it.each([false, true])(
    "selects an installed JSON/YAML package (yaml=%s) without executing it",
    async (yaml) => {
      const root = repository();
      installedPack(root, "@example/note-archive", "note-archive", yaml);
      installedPack(root, "@example/not-selected", "unused-tool");
      const setup = addToolPackage({ root, packageName: "@example/note-archive" });
      expect(setup.kind).toBe("tool-package-added");
      expect(setup.packageId).toBe("note-archive");
      expect(setup.created).toEqual([".gitignore", "firedrill.json", "firedrill/world.json"]);
      expect(setup.grants).toEqual([{ packageId: "note-archive", operationId: "entries.read" }]);
      expect(read(root, "firedrill.json")).toEqual({
        schemaVersion: 1,
        sourceRoot: "firedrill",
        world: "world.json",
        toolPackages: ["@example/note-archive"],
      });
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      expect(compiled.status, JSON.stringify(compiled.diagnostics)).toBe("success");
      if (compiled.status !== "success") return;
      expect(compiled.build.worldIr.tools.map((tool) => tool.id)).toEqual(["note-archive"]);
      expect(compiled.build.worldIr.baseline.actors).toEqual([
        { id: "local-dev", attributes: {}, grants: setup.grants },
      ]);
      const config = readFileSync(join(root, "firedrill.json"), "utf8");
      const second = addToolPackage({ root, packageName: "@example/note-archive" });
      expect(second.created).toEqual([]);
      expect(second.updated).toEqual([]);
      expect(readFileSync(join(root, "firedrill.json"), "utf8")).toBe(config);
    },
  );

  it("preserves an existing custom project and never adds grants silently", () => {
    const root = repository();
    installedPack(root, "case-catalog", "case-catalog");
    write(root, "firedrill.json", { schemaVersion: 1, sourceRoot: "world-source", world: "initial.json" });
    const world = '{"schemaVersion":1,"id":"existing-world","actors":[{"id":"guest","grants":[]}]}\n';
    write(root, "world-source/initial.json", world);
    const setup = addToolPackage({ root, packageName: "case-catalog" });
    expect(setup.updated).toEqual(["firedrill.json"]);
    expect(read(root, "firedrill.json")).toEqual({
      schemaVersion: 1,
      sourceRoot: "world-source",
      world: "initial.json",
      toolPackages: ["case-catalog"],
    });
    expect(readFileSync(join(root, "world-source/initial.json"), "utf8")).toBe(world);
    expect(setup.grantGuidance.join(" ")).toContain("were not changed");
    expect(existsSync(join(root, "firedrill"))).toBe(false);
  });

  it("rejects duplicate Tool ids from different selected packages without changing config", () => {
    const root = repository();
    installedPack(root, "first-catalog", "same-catalog");
    installedPack(root, "second-catalog", "same-catalog");
    addToolPackage({ root, packageName: "first-catalog" });
    const before = readFileSync(join(root, "firedrill.json"), "utf8");
    expect(() => addToolPackage({ root, packageName: "second-catalog" })).toThrow(
      expect.objectContaining({ code: "framework.TOOL_SETUP_CONFLICT" }),
    );
    expect(readFileSync(join(root, "firedrill.json"), "utf8")).toBe(before);
  });

  it("fails without installing or creating project files when a package is absent", () => {
    const root = repository();
    expect(() => addToolPackage({ root, packageName: "package-not-present" })).toThrow(
      expect.objectContaining({ code: "framework.TOOL_PACKAGE_NOT_INSTALLED" }),
    );
    expect(filePaths(root)).toEqual([]);
  });

  it.each(["../package", "https://example.com/tool.tgz", "pkg@1.0.0"])(
    "rejects non-package selector %s",
    (packageName) => {
      const root = repository();
      expect(() => addToolPackage({ root, packageName })).toThrow(
        expect.objectContaining({ code: "framework.TOOL_SETUP_INVALID_ARGUMENT" }),
      );
      expect(filePaths(root)).toEqual([]);
    },
  );

  it("rejects package declarations that escape through a symlink", () => {
    const root = repository();
    const outside = repository();
    installedPack(root, "outside-catalog", "outside-catalog");
    write(outside, "pack.tool.json", {});
    rmSync(join(root, "node_modules/outside-catalog/pack.tool.json"));
    symlinkSync(join(outside, "pack.tool.json"), join(root, "node_modules/outside-catalog/pack.tool.json"));
    expect(() => addToolPackage({ root, packageName: "outside-catalog" })).toThrow(
      expect.objectContaining({ code: "framework.TOOL_PACKAGE_INVALID" }),
    );
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
  });

  it("rolls back an existing config update if writing the ignore rule fails", () => {
    const root = repository();
    installedPack(root, "rollback-catalog", "rollback-catalog");
    write(root, "firedrill.json", { schemaVersion: 1, world: "world.json" });
    write(root, "firedrill/world.json", { schemaVersion: 1, id: "existing-world", actors: [] });
    const before = readFileSync(join(root, "firedrill.json"), "utf8");
    failure.writesBeforeFailure = 1;
    expect(() => addToolPackage({ root, packageName: "rollback-catalog" })).toThrow(FiredrillToolSetupError);
    expect(readFileSync(join(root, "firedrill.json"), "utf8")).toBe(before);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });
});
