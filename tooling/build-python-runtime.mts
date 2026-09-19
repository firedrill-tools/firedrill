import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { extract } from "tar";
import { discoverPublicPackages, packPublicPackages } from "./public-packages.mts";
import { compareStableStrings } from "./stable-order.mts";

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  license?: string;
}

interface Package {
  source: string;
  manifest: Manifest;
  dependencies: Map<string, Package>;
}

interface NodeRelease {
  archive: string;
  sha256: string;
  wheelPlatform: string;
}

const root = resolve(import.meta.dirname, "..");
const python = join(root, "python");
const target = `${process.platform}-${process.arch}`;
const nodeReleases = JSON.parse(readFileSync(join(python, "packaging/node-releases.json"), "utf8")) as {
  version: string;
  releases: Record<string, NodeRelease>;
};
const release = nodeReleases.releases[target];
if (!release) throw new Error(`Python wheels do not currently support ${target}.`);
const temporary = mkdtempSync(join(tmpdir(), "firedrill-python-runtime-"));
const runtime = join(temporary, "runtime");
const app = join(runtime, "app");
const modules = join(app, "node_modules");
const stage = join(python, "src/firedrill/_runtime");
const node = join(runtime, "bin", process.platform === "win32" ? "node.exe" : "node");

function run(
  command: string,
  arguments_: string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): void {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} ${arguments_.join(" ")} failed\n${result.stderr}\n${result.stdout}`,
    );
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

async function installNode(): Promise<string> {
  const cache = join(python, "build/cache");
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, release.archive);
  if (!existsSync(archive) || sha256(archive) !== release.sha256) {
    const response = await fetch(`https://nodejs.org/dist/v${nodeReleases.version}/${release.archive}`, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) {
      throw new Error("The official Node runtime archive did not match its pinned SHA-256.");
    }
    writeFileSync(archive, bytes);
  }
  const extracted = join(temporary, "node");
  mkdirSync(extracted);
  if (archive.endsWith(".zip")) {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:FD_ARCHIVE -DestinationPath $env:FD_EXTRACT",
      ],
      temporary,
      {
        FD_ARCHIVE: archive,
        FD_EXTRACT: extracted,
      },
    );
  } else {
    extract({ file: archive, cwd: extracted, sync: true, strict: true });
  }
  const [directory] = readdirSync(extracted);
  if (!directory) throw new Error("The Node archive was empty.");
  const nodeRoot = join(extracted, directory);
  copy(join(nodeRoot, process.platform === "win32" ? "node.exe" : "bin/node"), node);
  chmodSync(node, 0o755);
  copy(join(nodeRoot, "LICENSE"), join(runtime, "licenses/NODE-LICENSE"));
  copy(
    join(nodeRoot, process.platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm"),
    join(modules, "npm"),
  );
  for (const executable of ["npm", "npx"]) {
    const entry = executable === "npm" ? "npm-cli.js" : "npx-cli.js";
    if (process.platform === "win32") {
      writeFileSync(
        join(runtime, "bin", `${executable}.cmd`),
        `@ECHO OFF\r\n"%~dp0node.exe" "%~dp0..\\app\\node_modules\\npm\\bin\\${entry}" %*\r\n`,
      );
    } else {
      const file = join(runtime, "bin", executable);
      writeFileSync(
        file,
        `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../app/node_modules/npm/bin/${entry}" "$@"\n`,
      );
      chmodSync(file, 0o755);
    }
  }
  return nodeRoot;
}

async function installPnpm(): Promise<void> {
  const { pnpm } = JSON.parse(readFileSync(join(python, "packaging/package-managers.json"), "utf8")) as {
    pnpm: { version: string; url: string; integrity: string };
  };
  const response = await fetch(pnpm.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`pnpm download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pnpm.integrity) {
    throw new Error("The pnpm archive did not match its pinned SHA-512.");
  }
  const archive = join(temporary, "pnpm.tgz");
  writeFileSync(archive, bytes);
  const unpacked = join(temporary, "pnpm");
  mkdirSync(unpacked);
  extract({ file: archive, cwd: unpacked, sync: true, strict: true });
  copy(join(unpacked, "package"), join(modules, "pnpm"));
  const file = join(runtime, "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  writeFileSync(
    file,
    process.platform === "win32"
      ? '@ECHO OFF\r\n"%~dp0node.exe" "%~dp0..\\app\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n'
      : '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../app/node_modules/pnpm/bin/pnpm.cjs" "$@"\n',
  );
  chmodSync(file, 0o755);
}

function resolveDependency(source: string, name: string): string | undefined {
  for (let directory = source; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) return undefined;
  }
}

const graph = new Map<string, Package>();
function collect(source: string): Package {
  const canonical = realpathSync(source);
  const known = graph.get(canonical);
  if (known) return known;
  const manifest = JSON.parse(readFileSync(join(canonical, "package.json"), "utf8")) as Manifest;
  const package_: Package = { source: canonical, manifest, dependencies: new Map() };
  graph.set(canonical, package_);
  for (const name of new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])) {
    // The optional Python extra installs the official upstream wheel, which
    // owns distribution of its native executable and applicable terms.
    if (name.startsWith("@anthropic-ai/claude-agent-sdk-")) continue;
    const resolved = resolveDependency(canonical, name);
    if (!resolved) {
      if (name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional)
        continue;
      throw new Error(
        `${manifest.name} is missing installed production dependency ${name}. Run pnpm install --frozen-lockfile.`,
      );
    }
    const dependency = collect(resolved);
    package_.dependencies.set(name, dependency);
  }
  return package_;
}

const packedDirectories = new Map<string, string>();
const installed = new Map<string, Package>();
const pending: { package_: Package; destination: string }[] = [];
function place(package_: Package, destination: string): void {
  const existing = installed.get(destination);
  if (existing) {
    if (existing.source !== package_.source)
      throw new Error(`Conflicting runtime dependency at ${destination}`);
    return;
  }
  const packed = packedDirectories.get(package_.manifest.name);
  if (packed) {
    copy(packed, destination);
  } else {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(package_.source)) {
      if (entry === "node_modules" || entry === ".DS_Store") continue;
      copy(join(package_.source, entry), join(destination, entry));
    }
  }
  installed.set(destination, package_);
  pending.push({ package_, destination });
}

function installedDependency(from: string, name: string): Package | undefined {
  for (let directory = from; directory.startsWith(app); directory = dirname(directory)) {
    const found = installed.get(join(directory, "node_modules", name));
    if (found) return found;
  }
  return undefined;
}

function placeDependencies(): void {
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    if (!entry) continue;
    for (const [name, dependency] of entry.package_.dependencies) {
      if (installedDependency(entry.destination, name)?.source === dependency.source) continue;
      place(dependency, join(entry.destination, "node_modules", name));
    }
  }
}

function checkNoSymlinks(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Runtime payload contains a symlink: ${path}`);
    if (entry.isDirectory()) checkNoSymlinks(path);
  }
}

function fileInventory(directory: string): Record<string, string> {
  const entries: [string, string][] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else entries.push([relative(directory, path).replaceAll("\\", "/"), sha256(path)]);
    }
  }
  visit(directory);
  return Object.fromEntries(entries.sort(([a], [b]) => compareStableStrings(a, b)));
}

function replaceGeneratedDirectory(from: string, to: string): void {
  if (to !== stage) throw new Error("Refusing to replace a non-generated directory.");
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) rmSync(to, { recursive: true });
  // Temporary directories and the checkout can reside on different filesystems.
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copy(from, to);
  }
}

try {
  process.stdout.write(`Assembling Python runtime for ${target}\n`);
  const publicPackages = discoverPublicPackages(root).filter((package_) =>
    package_.directory.replaceAll("\\", "/").startsWith("packages/"),
  );
  for (const required of ["@firedrill-run/cli", "@firedrill-run/sdk"]) {
    if (!publicPackages.some((package_) => package_.name === required)) {
      throw new Error(`The Python runtime package inventory is missing ${required}.`);
    }
  }
  mkdirSync(modules, { recursive: true });
  const nodeRoot = await installNode();
  await installPnpm();
  const artifacts = packPublicPackages({
    repositoryRoot: root,
    outputDirectory: join(temporary, "packages"),
  });
  for (const package_ of publicPackages) {
    const artifact = artifacts.find((candidate) => candidate.name === package_.name);
    if (!artifact) throw new Error(`No distribution artifact for ${package_.name}`);
    const directory = join(temporary, "unpacked", package_.name.replaceAll("/", "-"));
    mkdirSync(directory, { recursive: true });
    extract({
      cwd: directory,
      file: join(temporary, "packages", artifact.archive),
      sync: true,
      strict: true,
    });
    packedDirectories.set(package_.name, join(directory, "package"));
    collect(join(root, package_.directory));
  }
  // Flatten the common dependency version; differing peer/version contexts are
  // copied below their dependent package, using ordinary Node resolution.
  for (const package_ of graph.values()) {
    const destination = join(modules, package_.manifest.name);
    if (!installed.has(destination)) place(package_, destination);
  }
  placeDependencies();
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name: "firedrill-python-runtime", private: true, type: "module" }, null, 2)}\n`,
  );
  const bridge = join(python, "runtime/bridge.mjs");
  if (!existsSync(bridge))
    throw new Error("python/runtime/bridge.mjs must exist before assembling the runtime.");
  copy(bridge, join(app, "bridge.mjs"));
  for (const [destination, package_] of installed) {
    if (package_.manifest.name !== "better-sqlite3") continue;
    const probe = spawnSync(
      node,
      [
        "-e",
        "const D=require(process.argv[1]);const d=new D(':memory:');d.prepare('select 1').get();d.close()",
        destination,
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0) continue;
    const prebuild = resolveDependency(destination, "prebuild-install");
    if (!prebuild) throw new Error("SQLite native rebuild helper is missing.");
    const native = spawnSync(node, [join(prebuild, "bin.js")], { cwd: destination, encoding: "utf8" });
    if (native.status !== 0) {
      run(
        node,
        [
          join(modules, "npm/node_modules/node-gyp/bin/node-gyp.js"),
          "rebuild",
          "--release",
          ...(process.platform === "win32" ? [] : [`--nodedir=${nodeRoot}`]),
        ],
        destination,
        {
          PATH: `${join(runtime, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
      );
    }
    run(
      node,
      [
        "-e",
        "const D=require(process.argv[1]);const d=new D(':memory:');d.prepare('select 1').get();d.close()",
        destination,
      ],
      app,
    );
  }
  copy(join(root, "LICENSE"), join(runtime, "licenses/LICENSE"));
  copy(join(root, "NOTICE"), join(runtime, "licenses/NOTICE"));
  writeFileSync(
    join(runtime, "licenses/dependencies.json"),
    `${JSON.stringify(
      [...graph.values()].map(({ manifest }) => ({
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? "See bundled package license",
      })),
      null,
      2,
    )}\n`,
  );
  const npmEnvironment = {
    PATH: `${join(runtime, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };
  run(node, [join(modules, "@firedrill-run/cli/dist/bin.js"), "--help"], app, npmEnvironment);
  run(
    node,
    [
      "--input-type=module",
      "-e",
      "await import('@firedrill-run/sdk');await import('@firedrill-run/inspector');await import('@firedrill-run/browser-tests');await import('@firedrill-run/agent')",
    ],
    app,
    npmEnvironment,
  );
  run(node, [join(modules, "npm/bin/npm-cli.js"), "--version"], app, npmEnvironment);
  run(
    process.platform === "win32" ? "python" : "python3",
    [join(python, "packaging/check_native.py"), runtime],
    root,
  );
  checkNoSymlinks(runtime);
  const common = {
    schemaVersion: 1,
    target,
    wheelPlatform: release.wheelPlatform,
    nodeVersion: nodeReleases.version,
    nodeArchiveSha256: release.sha256,
    frameworkVersion: publicPackages[0]?.version,
  };
  writeFileSync(
    join(runtime, "manifest.json"),
    `${JSON.stringify({ ...common, files: fileInventory(runtime) }, null, 2)}\n`,
  );
  replaceGeneratedDirectory(runtime, stage);
  process.stdout.write(
    `Staged ${installed.size} production package instances with Node ${nodeReleases.version}, npm, pnpm, SQLite, and inspector.\nBuild: cd python && python -m build --wheel\n`,
  );
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
