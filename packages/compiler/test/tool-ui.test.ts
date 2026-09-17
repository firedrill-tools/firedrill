import {
  appendFileSync,
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TOOL_UI_ASSET_BYTES, MAX_TOOL_UI_ASSETS, MAX_TOOL_UI_BYTES } from "@firedrill-tools/contracts";
import { loadWorldBuild } from "@firedrill-tools/world-build";
import { type PackageLock, PackageLockSchema, sha256Text } from "@firedrill-tools/world-ir";
import { extract, list } from "tar";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { compileWorld, inspectInstalledToolPackage, packWorldBuildArtifact } from "../src/index.js";

const roots: string[] = [];
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cases = [
  ["facility", "simulation", "climate.tool.json"],
  ["laboratory", "drill-world", "tracker.tool.yaml"],
  ["appointments", "world", "reservations.tool.yaml"],
] as const;
function fixture(input: (typeof cases)[number] = cases[0], withUi = true) {
  const temporary = mkdtempSync(join(tmpdir(), "firedrill-tool-ui-"));
  roots.push(temporary);
  const repository = join(temporary, "repository");
  cpSync(fileURLToPath(new URL(`./fixtures/${input[0]}/`, import.meta.url)), repository, { recursive: true });
  const declaration = join(repository, input[1], input[2]);
  const source = parse(readFileSync(declaration, "utf8"));
  const uiRoot = join(dirname(declaration), "ui");
  mkdirSync(join(uiRoot, "nested"), { recursive: true });
  writeFileSync(
    join(uiRoot, "index.html"),
    '<!doctype html><title>Tool UI</title><script type="module" src="app.js"></script>',
  );
  writeFileSync(join(uiRoot, "app.js"), 'document.body.dataset.loaded = "browser-only";');
  writeFileSync(join(uiRoot, "nested/style.css"), "body { color: black; }");
  writeFileSync(join(uiRoot, "tiny.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  if (withUi) source.ui = { root: "ui" };
  const save = () =>
    writeFileSync(declaration, declaration.endsWith(".json") ? JSON.stringify(source) : stringify(source));
  save();
  return { temporary, repository, declaration, source, uiRoot, save };
}
async function compiled(repositoryRoot: string) {
  const result = await compileWorld({ repositoryRoot });
  if (result.status !== "success" || !result.build.buildDirectory)
    throw new Error(JSON.stringify(result.status === "failed" ? result.diagnostics : result));
  return result.build as typeof result.build & { buildDirectory: string };
}

it.each(cases)(
  "locks and loads static bytes for unrelated %s Tool source without evaluating UI JS",
  async (name, sourceRoot, declaration) => {
    const f = fixture([name, sourceRoot, declaration] as (typeof cases)[number]);
    const build = await compiled(f.repository);
    const ui = build.packageLock.packages[0]?.ui;
    expect(ui?.entry).toBe("index.html");
    expect(ui?.assets.map((asset) => asset.path)).toEqual([
      "app.js",
      "index.html",
      "nested/style.css",
      "tiny.png",
    ]);
    expect(build.toolSources[0]?.uiPaths).toEqual(
      ui?.assets.map((asset) => `${sourceRoot}/ui/${asset.path}`),
    );
    expect(build.toolSources[0]?.behaviorPaths.every((path) => !path.includes("/ui/"))).toBe(true);
    const loaded = await loadWorldBuild(build.buildDirectory);
    expect(loaded.status, JSON.stringify(loaded)).toBe("success");
    if (loaded.status !== "success") return;
    expect(loaded.build.toolUis).toHaveLength(1);
    for (const asset of present(loaded.build.toolUis[0]).assets) {
      expect(Buffer.from(asset.bytes)).toEqual(readFileSync(join(f.uiRoot, asset.path)));
      expect(asset.artifactHash).toBe(sha256Text(asset.bytes));
    }
    writeFileSync(join(f.uiRoot, "app.js"), 'document.body.dataset.loaded = "edited";');
    const next = await compiled(f.repository);
    expect(next.manifest.buildHash).not.toBe(build.manifest.buildHash);
    expect(next.manifest.sourceDigest).not.toBe(build.manifest.sourceDigest);
    expect(next.packageLock.packages[0]?.artifactHash).toBe(build.packageLock.packages[0]?.artifactHash);
    expect((await loadWorldBuild(build.buildDirectory)).status).toBe("success");
    expect(Buffer.from(present(present(loaded.build.toolUis[0]).assets[0]).bytes).toString()).toContain(
      "browser-only",
    );
  },
);

it("preserves backend-only shape and identity when undeclared static files change", async () => {
  const f = fixture(cases[0], false);
  const first = await compiled(f.repository);
  writeFileSync(join(f.uiRoot, "app.js"), "throw new Error('not selected');");
  const second = await compiled(f.repository);
  expect(second.manifest).toEqual(first.manifest);
  expect(second.packageLock).toEqual(first.packageLock);
  expect(first.packageLock.packages[0]).not.toHaveProperty("ui");
  expect(first.toolSources[0]).not.toHaveProperty("uiPaths");
  const loaded = await loadWorldBuild(first.buildDirectory);
  expect(loaded.status === "success" && loaded.build.toolUis).toEqual([]);
});

it("archives only locked UI assets reproducibly and loads the extracted build without source", async () => {
  const f = fixture();
  const build = await compiled(f.repository);
  writeFileSync(join(f.repository, ".env"), "LOCAL_ONLY=not-ui\n");
  const first = await packWorldBuildArtifact({ build, archivePath: join(f.temporary, "one.tgz") });
  const second = await packWorldBuildArtifact({ build, archivePath: join(f.temporary, "two.tgz") });
  expect(first.artifactDigest).toBe(second.artifactDigest);
  const files: string[] = [];
  await list({
    file: first.archivePath,
    onReadEntry: (entry) => {
      if (entry.type === "File") files.push(entry.path);
    },
  });
  expect(files.sort()).toEqual(
    [
      "build.json",
      "packages.lock.json",
      "world.ir.json",
      ...build.packageLock.packages.flatMap((tool) => [
        tool.artifactPath,
        ...(tool.ui?.assets.map((asset) => asset.artifactPath) ?? []),
      ]),
    ].sort(),
  );
  const restored = join(f.temporary, "restored");
  mkdirSync(restored);
  await extract({ file: first.archivePath, cwd: restored, strict: true });
  rmSync(f.repository, { recursive: true });
  const loaded = await loadWorldBuild(restored);
  expect(loaded.status === "success" && loaded.build.toolUis[0]?.assets.length).toBe(4);
});

it("rejects UI tampering before importing any Tool behavior and refuses corrupted archive output", async () => {
  const f = fixture();
  appendFileSync(
    join(dirname(f.declaration), "climate.ts"),
    "\nglobalThis.__firedrillUiImportProbe = true;\n",
  );
  const build = await compiled(f.repository);
  const asset = present(present(build.packageLock.packages[0]?.ui).assets[0]);
  writeFileSync(join(build.buildDirectory, asset.artifactPath), "edited UI");
  expect((await loadWorldBuild(build.buildDirectory)).status).toBe("failed");
  expect((globalThis as Record<string, unknown>).__firedrillUiImportProbe).toBeUndefined();
  await expect(packWorldBuildArtifact({ build, archivePath: join(f.temporary, "bad.tgz") })).rejects.toThrow(
    /changed/,
  );
});

it.each(["missing", "extra", "symlink"])(
  "rejects %s files in a materialized UI artifact set",
  async (change) => {
    const f = fixture();
    const build = await compiled(f.repository);
    const asset = present(present(build.packageLock.packages[0]?.ui).assets[0]);
    const path = join(build.buildDirectory, asset.artifactPath);
    if (change === "extra") writeFileSync(join(dirname(path), "unlocked.css"), "body {}");
    else {
      rmSync(path);
      if (change === "symlink") symlinkSync(join(f.uiRoot, asset.path), path);
    }
    expect((await loadWorldBuild(build.buildDirectory)).status).toBe("failed");
  },
);

it.each([
  ".env",
  "nested/.git/config",
  "secrets.json",
  "node_modules/a.js",
  "_firedrill/client.js",
  "module.wasm",
  "source.js.map",
  "server.ts",
  "bad%2fpath.js",
  "a\\b.js",
])("refuses unsafe or unshipped asset path %s", async (path) => {
  const f = fixture();
  mkdirSync(dirname(join(f.uiRoot, path)), { recursive: true });
  writeFileSync(join(f.uiRoot, path), "unsafe fixture");
  const result = await compileWorld({ repositoryRoot: f.repository });
  expect(result.status).toBe("failed");
});

it.each([
  { root: "../outside" },
  { root: "/outside" },
  { root: "ui", entry: "../outside.html" },
  { root: "ui", entry: "missing.html" },
  { root: "ui", entry: "app.js" },
])("rejects escaped, missing or non-HTML UI declarations %j", async (ui) => {
  const f = fixture();
  f.source.ui = ui;
  f.save();
  expect((await compileWorld({ repositoryRoot: f.repository })).status).toBe("failed");
});

it.each(["root", "asset", "nested"])(
  "rejects %s symlinks even when their target is inside owned source",
  async (kind) => {
    const f = fixture();
    const selected =
      kind === "root" ? f.uiRoot : kind === "asset" ? join(f.uiRoot, "app.js") : join(f.uiRoot, "nested");
    const destination = join(dirname(f.declaration), `original-${kind}`);
    renameSync(selected, destination);
    symlinkSync(destination, selected);
    expect((await compileWorld({ repositoryRoot: f.repository })).status).toBe("failed");
  },
);

it("bounds file counts, individual bytes and aggregate bytes", async () => {
  const count = fixture();
  for (let index = 0; index < MAX_TOOL_UI_ASSETS; index++)
    writeFileSync(join(count.uiRoot, `extra-${index}.css`), "");
  expect((await compileWorld({ repositoryRoot: count.repository })).status).toBe("failed");
  const large = fixture();
  writeFileSync(join(large.uiRoot, "large.png"), Buffer.alloc(MAX_TOOL_UI_ASSET_BYTES + 1));
  expect((await compileWorld({ repositoryRoot: large.repository })).status).toBe("failed");
  const total = fixture();
  for (let index = 0; index <= MAX_TOOL_UI_BYTES / MAX_TOOL_UI_ASSET_BYTES; index++)
    writeFileSync(join(total.uiRoot, `large-${index}.png`), Buffer.alloc(MAX_TOOL_UI_ASSET_BYTES));
  expect((await compileWorld({ repositoryRoot: total.repository })).status).toBe("failed");
});

it("rejects credential-like text even in an otherwise accepted static filename", async () => {
  const f = fixture();
  writeFileSync(join(f.uiRoot, "settings.json"), JSON.stringify({ password: "synthetic-private-value" }));
  expect((await compileWorld({ repositoryRoot: f.repository })).status).toBe("failed");
});

it("locks installed package UI closure and inspection without importing browser scripts", async () => {
  const f = fixture();
  const packageRoot = join(f.repository, "node_modules/@example/climate-pack");
  mkdirSync(packageRoot, { recursive: true });
  cpSync(f.declaration, join(packageRoot, "climate.tool.json"));
  cpSync(join(dirname(f.declaration), "climate.ts"), join(packageRoot, "climate.ts"));
  cpSync(f.uiRoot, join(packageRoot, "ui"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@example/climate-pack",
      version: "2.1.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      firedrill: { layer: "tool-pack", tool: "climate.tool.json", lifecycle: "active" },
    }),
  );
  rmSync(f.declaration);
  const configPath = join(f.repository, "firedrill.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.toolPackages = ["@example/climate-pack"];
  writeFileSync(configPath, JSON.stringify(config));
  expect(
    inspectInstalledToolPackage({ repositoryRoot: f.repository, packageName: "@example/climate-pack" })
      .status,
  ).toBe("success");
  const build = await compiled(f.repository);
  expect(build.toolSources[0]?.uiPaths).toEqual(
    ["app.js", "index.html", "nested/style.css", "tiny.png"].map(
      (path) => `npm/@example/climate-pack/ui/${path}`,
    ),
  );
  expect((await loadWorldBuild(build.buildDirectory)).status).toBe("success");
  rmSync(join(packageRoot, "ui/app.js"));
  symlinkSync(join(f.uiRoot, "app.js"), join(packageRoot, "ui/app.js"));
  expect(
    inspectInstalledToolPackage({ repositoryRoot: f.repository, packageName: "@example/climate-pack" })
      .status,
  ).toBe("failed");
  expect((await compileWorld({ repositoryRoot: f.repository })).status).toBe("failed");
});

it("fails closed on unsafe, duplicate, unsorted and falsely sized UI lock entries", async () => {
  const f = fixture();
  const build = await compiled(f.repository);
  for (const mutate of [
    (value: PackageLock) => {
      present(present(value.packages[0]?.ui).assets[0]).artifactPath = "../outside.js";
    },
    (value: PackageLock) => {
      present(present(value.packages[0]?.ui).assets[0]).path = "_firedrill/client.js";
    },
    (value: PackageLock) => {
      present(value.packages[0]?.ui).assets.reverse();
    },
    (value: PackageLock) => {
      const ui = present(value.packages[0]?.ui);
      ui.assets.push(present(ui.assets[0]));
    },
    (value: PackageLock) => {
      present(present(value.packages[0]?.ui).assets[0]).bytes = MAX_TOOL_UI_ASSET_BYTES + 1;
    },
    (value: PackageLock) => {
      present(value.packages[0]?.ui).entry = "missing.html";
    },
    (value: PackageLock) => {
      present(present(value.packages[0]?.ui).assets[0]).mediaType = "text/html; charset=utf-8";
    },
  ]) {
    const lock = structuredClone(build.packageLock);
    mutate(lock);
    expect(PackageLockSchema.safeParse(lock).success).toBe(false);
  }
});
