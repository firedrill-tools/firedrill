import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extract as extractTar } from "tar";
import { compareStableStrings } from "./stable-order.mts";

interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface PackedManifest extends DependencyManifest {
  readonly name?: string;
  readonly version?: string;
}

interface ReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
}

interface ReleaseDocument {
  readonly schemaVersion: number;
  readonly status: "release-candidate" | "rehearsal";
  readonly packages: readonly ReleasePackage[];
  readonly checksums: string;
}

export interface PublishArtifact extends ReleasePackage {
  readonly absolutePath: string;
  readonly manifest: PackedManifest;
}

interface RegistryDist {
  readonly integrity?: string;
  readonly shasum?: string;
}

interface NpmCommandResult {
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export type NpmCommandRunner = (arguments_: readonly string[]) => NpmCommandResult;

export type PublishOutcome = "published" | "reconciled" | "accepted";

const repositoryRoot = resolve(import.meta.dirname, "..");
const npmScope = "@firedrill-run/";

function digest(algorithm: "sha1" | "sha256" | "sha512", path: string): string {
  return createHash(algorithm)
    .update(readFileSync(path))
    .digest(algorithm === "sha512" ? "base64" : "hex");
}

function safeFile(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error(`release path is not portable: ${relativePath}`);
  }
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${sep}`))
    throw new Error(`release path escapes its bundle: ${relativePath}`);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`release file is missing or not a regular file: ${relativePath}`);
  }
  const real = realpathSync(absolute);
  if (!real.startsWith(`${realpathSync(root)}${sep}`)) {
    throw new Error(`release file resolves outside its bundle: ${relativePath}`);
  }
  return absolute;
}

function packedManifest(archive: string): PackedManifest {
  const temporary = mkdtempSync(join(tmpdir(), "firedrill-publish-manifest-"));
  try {
    extractTar({
      cwd: temporary,
      file: archive,
      filter: (path) => path === "package/package.json",
      strict: true,
      sync: true,
    });
    const path = join(temporary, "package", "package.json");
    if (!existsSync(path)) throw new Error(`package archive has no package/package.json: ${archive}`);
    return JSON.parse(readFileSync(path, "utf8")) as PackedManifest;
  } finally {
    if (temporary.startsWith(`${tmpdir()}/firedrill-publish-manifest-`)) {
      rmSync(temporary, { force: true, recursive: true });
    }
  }
}

function verifyChecksums(bundle: string, checksumPath: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  const source = readFileSync(safeFile(bundle, checksumPath), "utf8");
  for (const line of source.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    const [, expected, relativePath] = match;
    if (expected === undefined || relativePath === undefined) throw new Error("invalid checksum record");
    if (checksums.has(relativePath)) throw new Error(`duplicate checksum path: ${relativePath}`);
    const absolute = safeFile(bundle, relativePath);
    const actual = digest("sha256", absolute);
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${relativePath}`);
    checksums.set(relativePath, expected);
  }
  return checksums;
}

export function loadReleaseBundle(
  directory: string,
  options: { readonly requireReleaseCandidate: boolean },
): readonly PublishArtifact[] {
  const bundle = realpathSync(resolve(directory));
  const release = JSON.parse(readFileSync(safeFile(bundle, "release.json"), "utf8")) as ReleaseDocument;
  if (release.schemaVersion !== 1 || !Array.isArray(release.packages)) {
    throw new Error("release.json is not a supported Firedrill release manifest");
  }
  if (options.requireReleaseCandidate && release.status !== "release-candidate") {
    throw new Error(`refusing to publish a ${release.status ?? "unknown"} bundle`);
  }
  const checksums = verifyChecksums(bundle, release.checksums);
  const identities = new Set<string>();
  return release.packages.map((package_) => {
    if (!package_.name.startsWith(npmScope)) {
      throw new Error(`refusing package outside ${npmScope}: ${package_.name}`);
    }
    const identity = `${package_.name}@${package_.version}`;
    if (identities.has(identity)) throw new Error(`duplicate release package ${identity}`);
    identities.add(identity);
    const absolutePath = safeFile(bundle, package_.path);
    const actualSha256 = digest("sha256", absolutePath);
    if (actualSha256 !== package_.sha256 || checksums.get(package_.path) !== package_.sha256) {
      throw new Error(`release manifest digest mismatch for ${identity}`);
    }
    const manifest = packedManifest(absolutePath);
    if (manifest.name !== package_.name || manifest.version !== package_.version) {
      throw new Error(`packed manifest identity mismatch for ${identity}`);
    }
    return { ...package_, absolutePath, manifest };
  });
}

export function topologicalPublishLayers(
  artifacts: readonly Pick<PublishArtifact, "name" | "manifest">[],
): readonly (readonly string[])[] {
  const names = new Set(artifacts.map(({ name }) => name));
  const remaining = new Map(
    artifacts.map(({ name, manifest }) => [
      name,
      new Set(
        Object.keys({
          ...(manifest.dependencies ?? {}),
          ...(manifest.optionalDependencies ?? {}),
          ...(manifest.peerDependencies ?? {}),
        }).filter((dependency) => names.has(dependency)),
      ),
    ]),
  );
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort(compareStableStrings);
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].sort(compareStableStrings).join(", ");
      throw new Error(`release package dependency cycle: ${cycle}`);
    }
    layers.push(ready);
    for (const name of ready) remaining.delete(name);
    for (const dependencies of remaining.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }
  return layers;
}

function npm(arguments_: readonly string[]): NpmCommandResult {
  return spawnSync("npm", [...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: "pipe",
  });
}

function publishedDist(
  name: string,
  version: string,
  runNpm: NpmCommandRunner = npm,
): RegistryDist | undefined {
  const result = runNpm(["view", `${name}@${version}`, "dist", "--json"]);
  if (result.status === 0) {
    const value = JSON.parse(result.stdout || "{}") as RegistryDist;
    return value;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry/i.test(output)) return undefined;
  throw new Error(`could not inspect ${name}@${version}\n${output}`);
}

function assertPublishedBytes(artifact: PublishArtifact, remote: RegistryDist): void {
  const localIntegrity = `sha512-${digest("sha512", artifact.absolutePath)}`;
  const localShasum = digest("sha1", artifact.absolutePath);
  if (
    (remote.integrity === undefined && remote.shasum === undefined) ||
    (remote.integrity !== undefined && remote.integrity !== localIntegrity) ||
    (remote.shasum !== undefined && remote.shasum !== localShasum)
  ) {
    throw new Error(
      `${artifact.name}@${artifact.version} already exists with different or unverifiable bytes`,
    );
  }
}

function rateLimited(output: string): boolean {
  return /E429|429 Too Many Requests|rate limit/i.test(output);
}

export function publishArchive(
  artifact: PublishArtifact,
  options: { readonly provenance: boolean; readonly tag: string },
  runNpm: NpmCommandRunner = npm,
): PublishOutcome {
  const arguments_ = [
    "publish",
    artifact.absolutePath,
    "--access",
    "public",
    "--tag",
    options.tag,
    "--fetch-retries=0",
  ];
  if (options.provenance) arguments_.push("--provenance");
  const result = runNpm(arguments_);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  let remote: RegistryDist | undefined;
  try {
    remote = publishedDist(artifact.name, artifact.version, runNpm);
  } catch (error) {
    if (result.status === 0) throw error;
    const inspectionFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      `npm publish failed for ${artifact.name}@${artifact.version}\n${output}\n` +
        `registry reconciliation also failed:\n${inspectionFailure}`,
    );
  }

  if (remote) {
    assertPublishedBytes(artifact, remote);
    return result.status === 0 ? "published" : "reconciled";
  }
  if (result.status === 0) {
    // npm may hold a successful upload for publish-time malware scanning before
    // exposing registry metadata. Never repeat the write just because the
    // accepted version is not readable yet; a later idempotent rerun will
    // reconcile the exact archive bytes once scanning completes.
    return "accepted";
  }
  if (rateLimited(output)) {
    throw new Error(
      `npm rate-limited ${artifact.name}@${artifact.version}; stopped after one registry write attempt. ` +
        `Rerun the same release bundle after the npm publication window resets.\n${output}`,
    );
  }
  throw new Error(`npm publish failed for ${artifact.name}@${artifact.version}\n${output}`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const release = argument("--release");
  const dryRun = process.argv.includes("--dry-run");
  const provenance = process.argv.includes("--provenance");
  const tag = argument("--tag") ?? "next";
  if (!release || !/^[a-z][a-z0-9._-]*$/.test(tag)) {
    process.stderr.write(
      "Usage: pnpm release:publish -- --release <prepared-bundle> [--tag next] [--provenance] [--dry-run]\n",
    );
    process.exitCode = 2;
    return;
  }

  const artifacts = loadReleaseBundle(release, { requireReleaseCandidate: !dryRun });
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const layers = topologicalPublishLayers(artifacts);
  process.stdout.write(`${layers.map((layer, index) => `${index + 1}. ${layer.join(", ")}`).join("\n")}\n`);
  if (dryRun) {
    process.stdout.write(`validated ${artifacts.length} package archive(s); registry was not changed\n`);
    return;
  }

  for (const layer of layers) {
    for (const name of layer) {
      const artifact = byName.get(name);
      if (!artifact) throw new Error(`publish plan lost ${name}`);
      const remote = publishedDist(artifact.name, artifact.version);
      if (remote) {
        assertPublishedBytes(artifact, remote);
        process.stdout.write(
          `already published with identical bytes: ${artifact.name}@${artifact.version}\n`,
        );
        continue;
      }
      const outcome = publishArchive(artifact, { provenance, tag });
      process.stdout.write(
        outcome === "accepted"
          ? `accepted by npm; registry scan pending: ${artifact.name}@${artifact.version}\n`
          : `${outcome === "reconciled" ? "reconciled" : "published"} and verified: ` +
              `${artifact.name}@${artifact.version}\n`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
