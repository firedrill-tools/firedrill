import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { canonicalJson } from "@firedrill/contracts";
import {
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  semanticHash,
} from "@firedrill/world-ir";
import { create } from "tar";
import type { CompiledBuild } from "./types.js";

const MAX_BUILD_BYTES = 256 * 1024 * 1024;

export class WorldBuildArchiveError extends Error {
  readonly code = "FD1502";
  constructor(message: string) {
    super(message);
    this.name = "WorldBuildArchiveError";
  }
}

export interface WorldBuildArchive {
  readonly archivePath: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly buildHash: string;
  readonly bytes: number;
}

/** Package only verified compiled artifacts; never execute behavior or include repository source. */
export async function packWorldBuildArtifact(options: {
  readonly build: CompiledBuild;
  readonly archivePath: string;
}): Promise<WorldBuildArchive> {
  const manifest = BuildManifestSchema.parse(options.build.manifest);
  const worldIr = CanonicalWorldIrSchema.parse(options.build.worldIr);
  const lock = PackageLockSchema.parse(options.build.packageLock);
  if (
    options.build.buildDirectory === undefined ||
    semanticHash(worldIr) !== manifest.irHash ||
    semanticHash(lock) !== manifest.packageLockHash
  )
    throw new WorldBuildArchiveError("Compile and materialize the world before packaging its build.");
  const root = realpathSync(options.build.buildDirectory);
  const archivePath = resolve(options.archivePath);
  const relativeOutput = relative(root, join(realpathSync(dirname(archivePath)), basename(archivePath)));
  if (relativeOutput === "" || (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== ".."))
    throw new WorldBuildArchiveError("The archive destination must be outside the immutable build.");
  const expected = new Map<string, { bytes?: Buffer; hash?: string; size?: number }>();
  const encode = (value: unknown) => Buffer.from(`${canonicalJson(value as never)}\n`);
  expected.set("build.json", { bytes: encode(manifest) });
  expected.set("packages.lock.json", { bytes: encode(lock) });
  expected.set("world.ir.json", { bytes: encode(worldIr) });
  if (options.build.setup !== undefined) {
    if (manifest.artifacts.setup !== "run-setup.json")
      throw new WorldBuildArchiveError("Run setup does not match its build manifest.");
    expected.set("run-setup.json", { bytes: encode(options.build.setup) });
  } else if (manifest.artifacts.setup !== undefined) {
    throw new WorldBuildArchiveError("Run setup is missing from the compiled build.");
  }
  for (const artifact of lock.packages) {
    if (
      !/^tools\/[a-zA-Z0-9._/-]+$/.test(artifact.artifactPath) ||
      artifact.artifactPath.split("/").some((part) => part === ".." || part === "." || part === "") ||
      expected.has(artifact.artifactPath)
    )
      throw new WorldBuildArchiveError("Tool artifact paths must be distinct files inside tools/.");
    expected.set(artifact.artifactPath, { hash: artifact.artifactHash });
    for (const asset of artifact.ui?.assets ?? []) {
      if (expected.has(asset.artifactPath))
        throw new WorldBuildArchiveError("UI assets must be distinct locked files inside tools/.");
      expected.set(asset.artifactPath, { hash: asset.artifactHash, size: asset.bytes });
    }
  }

  const staged = mkdtempSync(join(tmpdir(), "firedrill-build-archive-"));
  let ownedOutput = false;
  try {
    let total = 0;
    // Copy verified bytes into an owned staging tree. A concurrent repository edit
    // cannot change bytes after verification or add a source/secret file to tar.
    for (const [path, expectation] of expected) {
      let parent = root;
      const parts = path.split("/");
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        if (!lstatSync(parent).isDirectory())
          throw new WorldBuildArchiveError("Build artifact parent is not a directory.");
      }
      const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BUILD_BYTES - total)
          throw new WorldBuildArchiveError("Build artifacts exceed the archive safety bound.");
        if (expectation.size !== undefined) {
          if (stat.size !== expectation.size)
            throw new WorldBuildArchiveError("Immutable UI artifact size changed; recompile from source.");
          const bounded = Buffer.alloc(expectation.size + 1);
          let length = 0;
          while (length < bounded.length) {
            const count = readSync(fd, bounded, length, bounded.length - length, null);
            if (count === 0) break;
            length += count;
          }
          bytes = bounded.subarray(0, length);
        } else bytes = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      total += bytes.length;
      if (
        total > MAX_BUILD_BYTES ||
        (expectation.size !== undefined && bytes.length !== expectation.size) ||
        (expectation.bytes !== undefined && !bytes.equals(expectation.bytes)) ||
        (expectation.hash !== undefined &&
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectation.hash)
      )
        throw new WorldBuildArchiveError(
          "Immutable build artifacts changed; recompile from the intended source.",
        );
      const destination = join(staged, path);
      mkdirSync(dirname(destination), { recursive: true });
      for (let parent = dirname(destination); parent !== staged; parent = dirname(parent))
        chmodSync(parent, 0o755);
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
      chmodSync(destination, 0o644);
    }
    // This order and portable metadata are shared by every artifact producer.
    const roots = ["build.json", "packages.lock.json", "world.ir.json", "tools"];
    if (expected.has("run-setup.json")) roots.push("run-setup.json");
    const fd = openSync(archivePath, "wx", 0o600);
    ownedOutput = true;
    await pipeline(
      create({ cwd: staged, gzip: true, portable: true, noMtime: true, strict: true }, roots),
      createWriteStream(archivePath, { fd }),
    );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(archivePath)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return {
      archivePath,
      artifactDigest: `sha256:${hash.digest("hex")}`,
      buildHash: manifest.buildHash,
      bytes,
    };
  } catch (error) {
    if (ownedOutput) rmSync(archivePath, { force: true });
    throw error;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
