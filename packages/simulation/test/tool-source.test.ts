import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type CompiledBuild, compileWorld } from "@firedrill-run/compiler";
import { afterEach, describe, expect, it } from "vitest";
import { SimulationToolSourceDocumentSchema, SimulationToolSourceIdSchema } from "../src/contracts.js";
import { loadSimulationProject } from "../src/project.js";
import { captureToolSources } from "../src/tool-source.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-tool-source-"));
  directories.push(root);
  return root;
}

function repository(): string {
  const root = temporaryDirectory();
  cpSync(resolve(import.meta.dirname, "../../compiler/test/fixtures/appointments"), root, {
    recursive: true,
  });
  const behaviorPath = join(root, "world/reservations.ts");
  const original = readFileSync(behaviorPath, "utf8");
  writeFileSync(
    behaviorPath,
    [
      'import { toCustomerId } from "./a-helper.ts";',
      'throw new Error("source inspection must never execute this module");',
      original.replace("String(input.customerId)", "toCustomerId(input.customerId)"),
    ].join("\n"),
  );
  writeFileSync(
    join(root, "world/a-helper.ts"),
    "export const toCustomerId = (value: unknown) => String(value);\n",
  );
  return root;
}

async function compiledRepository(): Promise<{ readonly root: string; readonly build: CompiledBuild }> {
  const root = repository();
  const result = await compileWorld({ repositoryRoot: root });
  if (result.status !== "success") throw new Error(JSON.stringify(result.diagnostics));
  return { root, build: result.build };
}

function withPaths(build: CompiledBuild, paths: readonly string[]): CompiledBuild {
  return { ...build, toolSources: build.toolSources.map((source) => ({ ...source, behaviorPaths: paths })) };
}

function installPack(root: string): string {
  const packageRoot = temporaryDirectory();
  for (const filename of ["reservations.tool.yaml", "reservations.ts", "a-helper.ts"]) {
    renameSync(join(root, "world", filename), join(packageRoot, filename));
  }
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@example/source-pack",
      version: "1.0.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: { layer: "tool-pack", tool: "reservations.tool.yaml", lifecycle: "active" },
    }),
  );
  mkdirSync(join(root, "node_modules/@example"), { recursive: true });
  symlinkSync(packageRoot, join(root, "node_modules/@example/source-pack"), "dir");
  writeFileSync(
    join(root, "firedrill.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceRoot: "world",
      world: "world.yaml",
      toolPackages: ["@example/source-pack"],
    }),
  );
  return packageRoot;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Tool implementation snapshots", () => {
  it("projects the complete compiled definition and captures real entry/helper source without execution", async () => {
    const root = repository();
    const loaded = await loadSimulationProject({ root });
    const tool = loaded.project.tools.find((item) => item.id === "reservations");
    expect(tool?.definition).toMatchObject({
      capabilities: ["event.emit", "state.read", "state.write"],
      operations: [expect.objectContaining({ id: "slots.reserve", declaredErrors: ["OCCUPIED"] })],
      events: [expect.objectContaining({ id: "slot.reserved" })],
    });
    expect(tool?.operations[0]?.declaredErrors).toEqual(["OCCUPIED"]);
    expect(tool?.implementation).toMatchObject({
      snapshot: "compiled_refresh",
      buildHash: loaded.buildHash,
      origin: { kind: "repository" },
      exportName: "default",
      files: [
        expect.objectContaining({ path: "world/a-helper.ts", role: "helper", readable: true }),
        expect.objectContaining({ path: "world/reservations.ts", role: "entry", readable: true }),
      ],
    });
    const entry = tool?.implementation?.files.find((file) => file.role === "entry");
    expect(entry).toBeDefined();
    const document = loaded.toolSourceDocuments.get("reservations")?.get(entry?.id ?? "");
    const bytes = readFileSync(join(root, "world/reservations.ts"));
    expect(document?.content).toBe(bytes.toString("utf8"));
    expect(document?.contentHash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(SimulationToolSourceDocumentSchema.safeParse(document).success).toBe(true);
    expect(SimulationToolSourceIdSchema.safeParse(entry?.id).success).toBe(true);
    expect(loaded.toolSourceDocuments.get("reservations")?.size).toBe(2);
    expect(JSON.stringify(loaded.project)).not.toContain(root);

    writeFileSync(
      join(root, "world/reservations.ts"),
      `${bytes.toString("utf8")}\n// changed after refresh\n`,
    );
    expect(loaded.toolSourceDocuments.get("reservations")?.get(entry?.id ?? "")?.content).toBe(
      bytes.toString("utf8"),
    );
    const refreshed = await loadSimulationProject({ root });
    expect(refreshed.toolSourceDocuments.get("reservations")?.get(entry?.id ?? "")?.contentHash).not.toBe(
      document?.contentHash,
    );
  });

  it("captures installed-pack modules through a package-manager root symlink, without exposing absolute paths", async () => {
    const root = repository();
    const packageRoot = installPack(root);
    const loaded = await loadSimulationProject({ root });
    const tool = loaded.project.tools[0];
    expect(tool?.implementation).toMatchObject({
      origin: { kind: "npm", packageName: "@example/source-pack", packageVersion: "1.0.0" },
      files: [
        expect.objectContaining({
          path: "npm/@example/source-pack/a-helper.ts",
          role: "helper",
          readable: true,
        }),
        expect.objectContaining({
          path: "npm/@example/source-pack/reservations.ts",
          role: "entry",
          readable: true,
        }),
      ],
    });
    const entry = tool?.implementation?.files.find((file) => file.role === "entry");
    expect(loaded.toolSourceDocuments.get("reservations")?.get(entry?.id ?? "")?.content).toBe(
      readFileSync(join(packageRoot, "reservations.ts"), "utf8"),
    );
    expect(JSON.stringify(loaded.project)).not.toContain(packageRoot);
    expect(JSON.stringify(loaded.project)).not.toContain(root);
  });

  it("does not substitute a changed installed package version for the compiled selection", async () => {
    const root = repository();
    const packageRoot = installPack(root);
    const compiled = await compileWorld({ repositoryRoot: root });
    if (compiled.status !== "success") throw new Error(JSON.stringify(compiled.diagnostics));
    const manifestPath = join(packageRoot, "package.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('"1.0.0"', '"2.0.0"'));
    const captured = captureToolSources(root, compiled.build);
    expect(
      captured.implementations
        .get("reservations")
        ?.files.every((file) => file.unavailableReason === "package_changed"),
    ).toBe(true);
    expect(captured.documents.get("reservations")?.size).toBe(0);
  });

  it("reads repository behavior overrides of an installed declaration from the repository only", async () => {
    const root = repository();
    installPack(root);
    writeFileSync(join(root, "replacement.ts"), "export default { operations: {} };\n");
    const compiled = await compileWorld({
      repositoryRoot: root,
      runSetup: {
        drillId: "reserve-slot",
        setup: { tools: { behaviorOverrides: [{ packageId: "reservations", module: "replacement.ts" }] } },
      },
    });
    if (compiled.status !== "success") throw new Error(JSON.stringify(compiled.diagnostics));
    const captured = captureToolSources(root, compiled.build);
    expect(captured.implementations.get("reservations")).toMatchObject({
      origin: { kind: "repository_override", module: "replacement.ts", base: { kind: "npm" } },
      files: [expect.objectContaining({ path: "replacement.ts", readable: true, role: "entry" })],
    });
  });

  it.each([
    ["world/.env.ts", "restricted_path"],
    ["world/secrets.ts", "restricted_path"],
    ["world/credentials/client.ts", "restricted_path"],
    [".aws/config.ts", "restricted_path"],
    [".config/gcloud/access.ts", "restricted_path"],
    [".git/read.ts", "restricted_path"],
    [".firedrill/read.ts", "restricted_path"],
    ["node_modules/other/source.js", "restricted_path"],
    ["world/record.json", "unsupported_file"],
    ["world/record.d.ts", "unsupported_file"],
  ] as const)("does not capture restricted or non-implementation file %s", async (path, reason) => {
    const { root, build } = await compiledRepository();
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "export const privateValue = 1;\n");
    const captured = captureToolSources(root, withPaths(build, [path]));
    expect(captured.implementations.get("reservations")?.files[0]).toMatchObject({
      readable: false,
      unavailableReason: reason,
    });
    expect(captured.documents.get("reservations")?.size).toBe(0);
  });

  it.each(["file-inside", "file-outside", "directory-inside", "directory-outside"])(
    "rejects %s symlinks after compilation",
    async (variant) => {
      const { root, build } = await compiledRepository();
      const targetRoot = variant.endsWith("outside") ? temporaryDirectory() : root;
      const directory = join(targetRoot, "real");
      mkdirSync(directory);
      writeFileSync(join(directory, "source.ts"), "export default 42;\n");
      const path = variant.startsWith("directory") ? "world/linked/source.ts" : "world/linked.ts";
      symlinkSync(
        variant.startsWith("directory") ? directory : join(directory, "source.ts"),
        join(root, variant.startsWith("directory") ? "world/linked" : path),
      );
      const captured = captureToolSources(root, withPaths(build, [path]));
      expect(captured.implementations.get("reservations")?.files[0]?.unavailableReason).toBe("unsafe_path");
      expect(captured.documents.get("reservations")?.size).toBe(0);
    },
  );

  it("rejects symlinks below a selected installed package's real root", async () => {
    const root = repository();
    const packageRoot = installPack(root);
    const compiled = await compileWorld({ repositoryRoot: root });
    if (compiled.status !== "success") throw new Error(JSON.stringify(compiled.diagnostics));
    renameSync(join(packageRoot, "reservations.ts"), join(packageRoot, "real.ts"));
    symlinkSync(join(packageRoot, "real.ts"), join(packageRoot, "reservations.ts"));
    const captured = captureToolSources(root, compiled.build);
    expect(
      captured.implementations
        .get("reservations")
        ?.files.find((file) => file.path.endsWith("reservations.ts"))?.unavailableReason,
    ).toBe("unsafe_path");
  });

  it.each([
    ["oversized", Buffer.from("é".repeat(700_000)), "too_large"],
    ["binary", Buffer.from([0, 1, 2]), "invalid_text"],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]), "invalid_text"],
    ["private key", Buffer.from("-----BEGIN " + "PRIVATE KEY-----"), "invalid_text"],
  ] as const)("rejects %s source without returning partial text", async (_name, bytes, reason) => {
    const { root, build } = await compiledRepository();
    writeFileSync(join(root, "world/reservations.ts"), bytes);
    const captured = captureToolSources(root, withPaths(build, ["world/reservations.ts"]));
    expect(captured.implementations.get("reservations")?.files[0]?.unavailableReason).toBe(reason);
    expect(captured.documents.get("reservations")?.size).toBe(0);
  });

  it("reports missing originals and directories honestly rather than returning a declaration or compiled bundle", async () => {
    const { root, build } = await compiledRepository();
    rmSync(join(root, "world/reservations.ts"));
    mkdirSync(join(root, "world/directory.ts"));
    const captured = captureToolSources(
      root,
      withPaths(build, ["world/reservations.ts", "world/directory.ts"]),
    );
    expect(captured.implementations.get("reservations")?.files.map((file) => file.unavailableReason)).toEqual(
      ["missing_source", "unsafe_path"],
    );
    expect(captured.documents.get("reservations")?.size).toBe(0);
  });

  it("caps aggregate retained source bytes without hiding the omitted file reference", async () => {
    const { root, build } = await compiledRepository();
    const paths = Array.from({ length: 17 }, (_, index) => `world/large-${index}.ts`);
    for (const path of paths) writeFileSync(join(root, path), " ".repeat(1024 * 1024));
    const captured = captureToolSources(root, withPaths(build, paths));
    expect(captured.implementations.get("reservations")?.files).toHaveLength(17);
    expect(captured.implementations.get("reservations")?.files[16]?.unavailableReason).toBe("snapshot_limit");
    expect(captured.documents.get("reservations")?.size).toBe(16);
  });

  it("does not turn caller-like traversal strings into fetchable file identities", () => {
    for (const value of [
      "../world/reservations.ts",
      "world/reservations.ts",
      "file-../source",
      "file-invalid",
    ]) {
      expect(SimulationToolSourceIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
