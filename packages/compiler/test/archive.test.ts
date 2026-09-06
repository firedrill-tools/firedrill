import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "tar";
import { afterEach, expect, it } from "vitest";
import { compileWorld, packWorldBuildArtifact } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-archive-test-"));
  directories.push(directory);
  const repositoryRoot = join(directory, "repository");
  cpSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), repositoryRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, ".env"), "NOT_FOR_DISTRIBUTION=local-only-fixture\n");
  const result = await compileWorld({ repositoryRoot });
  if (result.status !== "success") throw new Error(JSON.stringify(result.diagnostics));
  return { directory, build: result.build };
}

it.each(["appointments", "facility", "laboratory"])(
  "packs %s reproducibly without repository or runtime data",
  async (name) => {
    const { directory, build } = await fixture(name);
    const first = await packWorldBuildArtifact({ build, archivePath: join(directory, "first.tgz") });
    const originalMask = process.umask(0o077);
    const second = await packWorldBuildArtifact({
      build,
      archivePath: join(directory, "second.tgz"),
    }).finally(() => process.umask(originalMask));
    expect(first.artifactDigest).toBe(second.artifactDigest);
    expect(first.buildHash).toBe(build.manifest.buildHash);
    expect(first.bytes).toBe(readFileSync(first.archivePath).length);
    const files: string[] = [];
    await list({
      file: first.archivePath,
      onReadEntry(entry) {
        if (entry.type === "File") files.push(entry.path);
      },
    });
    expect(files.sort()).toEqual(
      [
        "build.json",
        "packages.lock.json",
        "world.ir.json",
        ...build.packageLock.packages.map((tool) => tool.artifactPath),
      ].sort(),
    );
    await expect(packWorldBuildArtifact({ build, archivePath: first.archivePath })).rejects.toThrow();
    expect(readFileSync(first.archivePath)).toEqual(readFileSync(second.archivePath));
  },
);

it("rejects changed artifacts and symlinked artifacts without creating or overwriting an archive", async () => {
  const { directory, build } = await fixture("facility");
  const artifact = build.packageLock.packages[0];
  if (!artifact || !build.buildDirectory) throw new Error("missing fixture artifact");
  const path = join(build.buildDirectory, artifact.artifactPath);
  const original = readFileSync(path);
  writeFileSync(path, "throw new Error('must never execute');\n");
  await expect(
    packWorldBuildArtifact({ build, archivePath: join(directory, "changed.tgz") }),
  ).rejects.toThrow(/changed/);
  rmSync(path);
  writeFileSync(join(directory, "outside.mjs"), original);
  symlinkSync(join(directory, "outside.mjs"), path);
  await expect(
    packWorldBuildArtifact({ build, archivePath: join(directory, "symlink.tgz") }),
  ).rejects.toThrow();
  mkdirSync(join(directory, "protected"));
  await expect(
    packWorldBuildArtifact({ build, archivePath: join(directory, "protected") }),
  ).rejects.toThrow();
});
