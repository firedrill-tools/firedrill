import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { create as createTar, extract as extractTar } from "tar";
import { compareStableStrings } from "./stable-order.mts";

export interface PublicPackage {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
}

export interface PublicPackageArtifact extends PublicPackage {
  readonly archive: string;
  readonly sha256: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
}

function packageDirectories(root: string): readonly string[] {
  const result: string[] = [];
  for (const parent of ["packages", "tool-packs"]) {
    const absoluteParent = join(root, parent);
    if (!existsSync(absoluteParent)) continue;
    for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (entry.isDirectory()) result.push(join(absoluteParent, entry.name));
    }
  }
  return result.sort();
}

export function discoverPublicPackages(repositoryRoot: string): readonly PublicPackage[] {
  const root = resolve(repositoryRoot);
  const packages = packageDirectories(root).flatMap((directory): readonly PublicPackage[] => {
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    if (manifest.private === true || manifest.publishConfig?.access !== "public") return [];
    if (!manifest.name || !manifest.version) {
      throw new Error(`${relative(root, manifestPath)} has no publishable name or version`);
    }
    return [{ directory: relative(root, directory), name: manifest.name, version: manifest.version }];
  });
  const names = new Set<string>();
  for (const package_ of packages) {
    if (names.has(package_.name)) throw new Error(`duplicate public package name ${package_.name}`);
    names.add(package_.name);
  }
  return packages.sort((left, right) => compareStableStrings(left.name, right.name));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(directory, path));
      else throw new Error(`package archive contains an unsupported entry: ${relative(directory, path)}`);
    }
  };
  visit(directory);
  return files.sort();
}

function sortDependencyMap(value: unknown): unknown {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareStableStrings(left, right),
    ),
  );
}

function normalizePackedManifest(path: string): void {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ]) {
    if (field in manifest) manifest[field] = sortDependencyMap(manifest[field]);
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertSelfContainedSourceMaps(packageDirectory: string): void {
  for (const file of filesUnder(packageDirectory).filter((path) => path.endsWith(".map"))) {
    const document = JSON.parse(readFileSync(join(packageDirectory, file), "utf8")) as {
      readonly sources?: readonly string[];
      readonly sourcesContent?: readonly (string | null)[];
    };
    if (
      (document.sources?.length ?? 0) > 0 &&
      (!Array.isArray(document.sourcesContent) ||
        document.sourcesContent.length !== document.sources?.length ||
        document.sourcesContent.some((source) => source === null))
    ) {
      throw new Error(`package source map is not self-contained: ${file}`);
    }
  }
}

function repackDeterministically(rawArchive: string, destination: string, temporary: string): void {
  const unpacked = join(temporary, "unpacked");
  mkdirSync(unpacked);
  extractTar({ cwd: unpacked, file: rawArchive, strict: true, sync: true });
  const manifestPath = join(unpacked, "package", "package.json");
  if (!existsSync(manifestPath))
    throw new Error(`package archive has no package/package.json: ${rawArchive}`);
  normalizePackedManifest(manifestPath);
  assertSelfContainedSourceMaps(join(unpacked, "package"));
  createTar(
    {
      cwd: unpacked,
      file: destination,
      gzip: { level: 9 },
      jobs: 1,
      mtime: new Date(0),
      portable: true,
      strict: true,
      sync: true,
    },
    [...filesUnder(unpacked)],
  );
}

function runPnpm(arguments_: readonly string[], cwd: string) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (pnpmEntrypoint && existsSync(pnpmEntrypoint)) {
    return spawnSync(process.execPath, [pnpmEntrypoint, ...arguments_], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  }
  return spawnSync("pnpm", [...arguments_], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
}

export function packPublicPackages(options: {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
}): readonly PublicPackageArtifact[] {
  const root = resolve(options.repositoryRoot);
  const output = resolve(options.outputDirectory);
  if (existsSync(output)) {
    if (!statSync(output).isDirectory()) throw new Error(`pack output is not a directory: ${output}`);
    if (readdirSync(output).length > 0) throw new Error(`pack output must be empty: ${output}`);
  } else {
    mkdirSync(output, { recursive: true });
  }

  const artifacts: PublicPackageArtifact[] = [];
  for (const package_ of discoverPublicPackages(root)) {
    const temporary = mkdtempSync(join(tmpdir(), "firedrill-raw-pack-"));
    try {
      const result = runPnpm(["pack", "--pack-destination", temporary], join(root, package_.directory));
      if (result.status !== 0) {
        throw new Error(`packing ${package_.name} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      }
      const created = readdirSync(temporary).filter((name) => name.endsWith(".tgz"));
      if (created.length !== 1) {
        throw new Error(`${package_.name} produced ${created.length} package archives`);
      }
      const archive = created[0];
      if (archive === undefined) throw new Error(`${package_.name} produced no package archive`);
      const destination = join(output, archive);
      repackDeterministically(join(temporary, archive), destination, temporary);
      artifacts.push({ ...package_, archive, sha256: sha256(destination) });
    } finally {
      if (temporary.startsWith(`${tmpdir()}/firedrill-raw-pack-`)) {
        rmSync(temporary, { force: true, recursive: true });
      }
    }
  }

  writeFileSync(
    join(output, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: artifacts }, null, 2)}\n`,
  );
  return artifacts;
}
