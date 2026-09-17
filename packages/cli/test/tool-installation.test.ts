import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectInstalledToolPackage } from "@firedrill-tools/compiler";
import { create } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installToolSource } from "../src/tool-installation.js";
import { createTool } from "../src/tool-setup.js";

const roots: string[] = [];
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "firedrill-install-test-")));
  roots.push(root);
  return root;
}
function write(root: string, path: string, value: unknown) {
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
function read(root: string, path: string) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
function tool(root: string) {
  createTool({ root, id: "device-store" });
  const source = read(root, "firedrill/tools/device-store/device-store.tool.json");
  write(root, "package.json", {
    name: "@independent/device-store",
    version: source.manifest.version,
    type: "module",
    exports: { "./package.json": "./package.json" },
    files: ["firedrill/tools/device-store"],
    scripts: {
      prepare: "node -e \"require('fs').writeFileSync('UNSAFE_PREPARE', 'executed')\"",
      prepack: "node -e \"require('fs').writeFileSync('UNSAFE_PREPACK', 'executed')\"",
      postinstall: "node -e \"require('fs').writeFileSync('UNSAFE_INSTALL', 'executed')\"",
    },
    firedrill: {
      layer: "tool-pack",
      lifecycle: "active",
      tool: "firedrill/tools/device-store/device-store.tool.json",
    },
  });
  write(
    root,
    "firedrill/tools/device-store/behavior.mjs",
    "throw new Error('Behavior must never execute during installation');\nexport default {operations: {}};\n",
  );
  return source.manifest.version as string;
}
function consumer() {
  const root = directory();
  write(root, "package.json", { name: "independent-consumer", version: "1.0.0", private: true });
  return root;
}

beforeEach(() => {
  vi.stubEnv("npm_config_offline", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Tool acquisition", () => {
  it("installs into an empty nested project without changing its parent package", async () => {
    const parent = consumer();
    write(parent, "package.json", {
      name: "parent-project",
      private: true,
      devDependencies: { "@independent/unpublished-parent-dependency": "999.0.0" },
    });
    write(parent, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const parentManifest = readFileSync(join(parent, "package.json"));
    const parentLock = readFileSync(join(parent, "pnpm-lock.yaml"));
    const source = directory();
    tool(source);
    const sourceManifest = read(source, "package.json");
    sourceManifest.devDependencies = { "@independent/unpublished-author-dependency": "999.0.0" };
    write(source, "package.json", sourceManifest);
    const root = join(parent, "nested", "application");
    mkdirSync(root, { recursive: true });

    const installed = await installToolSource({ root, source });

    expect(installed.packageManager).toBe("npm");
    expect(read(root, "package.json").devDependencies).toEqual({
      "@independent/device-store": `file:${installed.archivePath}`,
    });
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
    expect(
      inspectInstalledToolPackage({ repositoryRoot: root, packageName: installed.packageName }).status,
    ).toBe("success");
    expect(readFileSync(join(parent, "package.json"))).toEqual(parentManifest);
    expect(readFileSync(join(parent, "pnpm-lock.yaml"))).toEqual(parentLock);
    expect(existsSync(join(parent, "package-lock.json"))).toBe(false);
    expect(existsSync(join(parent, "node_modules"))).toBe(false);
  });

  it("rejects a registry changing package contents between acquisition and install", async () => {
    const source = directory();
    const version = tool(source);
    const name = "@independent/device-store";
    const makeArchive = () => {
      const packed = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: source, encoding: "utf8" }),
      )[0].filename;
      return readFileSync(join(source, packed));
    };
    const first = makeArchive();
    write(source, "firedrill/tools/device-store/added.mjs", "throw new Error('Unreviewed file');\n");
    const second = makeArchive();
    let acquired = false;
    let servedChanged = false;
    let origin = "";
    const server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      if (request.url === "/first.tgz") {
        acquired = true;
        response.end(first);
        return;
      }
      if (request.url === "/second.tgz") {
        servedChanged = true;
        response.end(second);
        return;
      }
      const bytes = acquired ? second : first;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...read(source, "package.json"),
              dist: {
                tarball: `${origin}/${acquired ? "second" : "first"}.tgz`,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                shasum: createHash("sha1").update(bytes).digest("hex"),
              },
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No registry listener");
    origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("npm_config_offline", "false");
    vi.stubEnv("npm_config_registry", origin);
    vi.stubEnv("npm_config_cache", directory());
    const root = consumer();
    try {
      await expect(installToolSource({ root, source: `${name}@latest` })).rejects.toThrow(/file set differs/);
      expect(servedChanged).toBe(true);
      expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("resolves a registry tag to an exact npm version and ordinary integrity lock", async () => {
    const source = directory();
    const version = tool(source);
    const name = "@independent/device-store";
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: source, encoding: "utf8" }),
    )[0].filename;
    const bytes = readFileSync(join(source, packed));
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    let origin = "";
    const server = createServer((request, response) => {
      if (request.url === "/package.tgz") {
        response.end(bytes);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...read(source, "package.json"),
              dist: {
                tarball: `${origin}/package.tgz`,
                integrity,
                shasum: createHash("sha1").update(bytes).digest("hex"),
              },
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No registry listener");
    origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("npm_config_offline", "false");
    vi.stubEnv("npm_config_registry", origin);
    vi.stubEnv("npm_config_cache", directory());
    const root = consumer();
    try {
      const installed = await installToolSource({ root, source: `${name}@latest` });
      expect(installed).toMatchObject({
        packageName: name,
        version,
        resolvedSource: `${name}@${version}`,
        integrity,
      });
      expect(installed.archivePath).toBeUndefined();
      expect(read(root, "package.json").devDependencies[name]).toBe(version);
      expect(read(root, "package-lock.json").packages[`node_modules/${name}`].integrity).toBe(integrity);
      expect(existsSync(join(root, "node_modules", name, "UNSAFE_INSTALL"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("installs a standalone local Tool, never runs lifecycle/behavior, and survives a fresh offline clone", async () => {
    const source = join(directory(), "package with spaces");
    mkdirSync(source);
    const version = tool(source);
    const root = consumer();
    const result = await installToolSource({ root, source });
    expect(result).toMatchObject({
      packageName: "@independent/device-store",
      version,
      packageManager: "npm",
      source: "local-package",
    });
    expect(result.archivePath).toMatch(/^\.firedrill-tools\/[a-f0-9]{64}\.tgz$/);
    if (!result.archivePath || !result.provenancePath) throw new Error("Missing vendored artifact paths");
    expect(result.integrity).toBe(
      `sha512-${createHash("sha512")
        .update(readFileSync(join(root, result.archivePath)))
        .digest("base64")}`,
    );
    expect(read(root, "package.json").devDependencies["@independent/device-store"]).toBe(
      `file:${result.archivePath}`,
    );
    expect(readFileSync(join(root, result.provenancePath), "utf8")).not.toContain(source);
    expect(read(root, "node_modules/@independent/device-store/package.json").scripts).toBeUndefined();
    for (const filename of ["UNSAFE_PREPARE", "UNSAFE_PREPACK", "UNSAFE_INSTALL"]) {
      expect(existsSync(join(source, filename))).toBe(false);
      expect(existsSync(join(root, "node_modules/@independent/device-store", filename))).toBe(false);
    }
    expect(existsSync(join(root, "firedrill.json"))).toBe(false);
    const clone = directory();
    for (const path of ["package.json", "package-lock.json", ".firedrill-tools"])
      cpSync(join(root, path), join(clone, path), { recursive: true });
    execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: clone,
      stdio: "pipe",
    });
    expect(
      inspectInstalledToolPackage({ repositoryRoot: clone, packageName: result.packageName }).status,
    ).toBe("success");
  }, 30_000);

  it("resolves a local Git subdirectory to an exact commit without checkout hooks or scripts", async () => {
    const gitRoot = directory();
    const source = join(gitRoot, "packages", "device-store");
    mkdirSync(source, { recursive: true });
    tool(source);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--quiet"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Tool fixture",
    ]);
    const commit = git(["rev-parse", "HEAD"]);
    const root = consumer();
    const installed = await installToolSource({
      root,
      source: `git+${pathToFileURL(gitRoot).href}#HEAD::packages/device-store`,
    });
    expect(installed.resolvedSource).toBe(`local-git#${commit}::packages/device-store`);
    if (!installed.provenancePath) throw new Error("Missing Git provenance path");
    expect(readFileSync(join(root, installed.provenancePath), "utf8")).not.toContain(gitRoot);
    expect(existsSync(join(source, "UNSAFE_PREPARE"))).toBe(false);
  }, 30_000);

  it("preserves a pnpm project's package-manager path with portable vendored dependencies", async () => {
    const source = directory();
    tool(source);
    const root = consumer();
    execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--offline"], {
      cwd: root,
      stdio: "pipe",
    });
    const installed = await installToolSource({ root, source });
    expect(installed.packageManager).toBe("pnpm");
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(
      inspectInstalledToolPackage({ repositoryRoot: root, packageName: installed.packageName }).status,
    ).toBe("success");
    const clone = directory();
    for (const path of ["package.json", "pnpm-lock.yaml", ".firedrill-tools"])
      cpSync(join(root, path), join(clone, path), { recursive: true });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], {
      cwd: clone,
      stdio: "pipe",
    });
    expect(
      inspectInstalledToolPackage({ repositoryRoot: clone, packageName: installed.packageName }).status,
    ).toBe("success");
  }, 30_000);

  it("honors a Git package's files allowlist while rejecting unsafe files included in its final archive", async () => {
    const source = directory();
    tool(source);
    write(source, ".env.example", "SAMPLE_SETTING=not-a-credential\n");
    mkdirSync(join(source, ".firedrill/reports"), { recursive: true });
    write(source, ".firedrill/reports/ignored.json", { privateSyntheticOutput: true });
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: source,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(["init", "--quiet"]);
    git(["add", "--force", "."]);
    const commit = () =>
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Package allowlist fixture",
      ]);
    commit();
    const selector = `git+${pathToFileURL(source).href}#HEAD`;
    const root = consumer();
    const installed = await installToolSource({ root, source: selector });
    expect(existsSync(join(root, "node_modules", installed.packageName, ".env.example"))).toBe(false);
    expect(existsSync(join(root, "node_modules", installed.packageName, ".firedrill"))).toBe(false);
    const metadata = read(source, "package.json");
    metadata.files.push(".env.example", ".firedrill");
    write(source, "package.json", metadata);
    git(["add", "package.json"]);
    commit();
    const untouched = consumer();
    await expect(installToolSource({ root: untouched, source: selector })).rejects.toThrow(/secret-bearing/);
    expect(readdirSync(untouched)).toEqual(["package.json"]);
  }, 30_000);

  it("accepts a prepacked archive while refusing non-Tools before consumer dependencies change", async () => {
    const source = directory();
    tool(source);
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: source, encoding: "utf8" }),
    )[0].filename;
    const root = consumer();
    expect((await installToolSource({ root, source: join(source, packed) })).packageName).toBe(
      "@independent/device-store",
    );
    const notTool = directory();
    write(notTool, "package.json", { name: "not-a-tool", version: "1.0.0" });
    const untouched = consumer();
    const before = readFileSync(join(untouched, "package.json"));
    await expect(installToolSource({ root: untouched, source: notTool })).rejects.toMatchObject({
      code: "framework.TOOL_INSTALL_FAILED",
    });
    expect(readFileSync(join(untouched, "package.json"))).toEqual(before);
    expect(readdirSync(untouched)).toEqual(["package.json"]);
  }, 30_000);

  it.each([
    "github:owner/repo#main::../outside",
    "https://user:token@example.invalid/repo.git",
    "https://example.invalid/repo.git?token=hidden",
    "git+ssh://example.invalid/repo.git",
  ])("rejects unsafe selector %s before writes", async (source) => {
    const root = consumer();
    await expect(installToolSource({ root, source })).rejects.toMatchObject({
      code: "framework.TOOL_INSTALL_FAILED",
    });
    expect(readdirSync(root)).toEqual(["package.json"]);
  });

  it("rejects symlinks and secret-bearing files in package contents", async () => {
    const source = directory();
    tool(source);
    symlinkSync("behavior.mjs", join(source, "firedrill/tools/device-store/link.mjs"));
    const root = consumer();
    await expect(installToolSource({ root, source })).rejects.toThrow(/link/);
    rmSync(join(source, "firedrill/tools/device-store/link.mjs"));
    write(source, "firedrill/tools/device-store/.env", "SHOULD_NOT_SHIP=fixture-only\n");
    await expect(installToolSource({ root, source })).rejects.toThrow(/secret-bearing/);
    expect(readdirSync(root)).toEqual(["package.json"]);
  }, 15_000);

  it("refuses oversized local source before npm packs it", async () => {
    const source = directory();
    tool(source);
    write(source, "firedrill/tools/device-store/too-large.bin", "");
    truncateSync(join(source, "firedrill/tools/device-store/too-large.bin"), 17 * 1024 * 1024);
    const root = consumer();
    await expect(installToolSource({ root, source })).rejects.toThrow(/size bound/);
    expect(readdirSync(root)).toEqual(["package.json"]);
  });

  it("rejects a tarball containing a symbolic link before installation", async () => {
    const source = directory();
    const packageRoot = join(source, "package");
    mkdirSync(packageRoot);
    tool(packageRoot);
    symlinkSync("../../outside", join(packageRoot, "link"));
    const archive = join(source, "linked.tgz");
    await create({ file: archive, cwd: source, gzip: true }, ["package"]);
    const root = consumer();
    await expect(installToolSource({ root, source: archive })).rejects.toThrow(/link/);
    expect(readdirSync(root)).toEqual(["package.json"]);
  });
});
