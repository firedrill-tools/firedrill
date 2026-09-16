import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];
const revision = "a".repeat(40);

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  temporaryRoots.push(root);
  return root;
}

function fixture(): string {
  const root = temporaryRoot("firedrill-sync-source-");
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "README.md"), "# Catalog\n");
  writeFileSync(
    join(root, "registry", "index.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceRevision: revision, packages: [] }, null, 2)}\n`,
  );
  return root;
}

function artifactCommand(arguments_: readonly string[]) {
  return spawnSync("node", [".github/scripts/community-sync-artifact.mjs", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("community sync artifact", () => {
  it("moves only verified generated catalog files between jobs", () => {
    const source = fixture();
    const artifact = join(temporaryRoot("firedrill-sync-artifact-parent-"), "artifact");
    const target = temporaryRoot("firedrill-sync-target-");

    const prepared = artifactCommand([
      "prepare",
      "--root",
      source,
      "--artifact",
      artifact,
      "--revision",
      revision,
    ]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const applied = artifactCommand([
      "apply",
      "--root",
      target,
      "--artifact",
      artifact,
      "--revision",
      revision,
    ]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(join(target, "registry", "README.md"), "utf8")).toBe("# Catalog\n");
  });

  it("rejects payload changes before writing the consumer tree", () => {
    const source = fixture();
    const artifact = join(temporaryRoot("firedrill-sync-artifact-parent-"), "artifact");
    const target = temporaryRoot("firedrill-sync-target-");
    expect(
      artifactCommand(["prepare", "--root", source, "--artifact", artifact, "--revision", revision]).status,
    ).toBe(0);
    writeFileSync(join(artifact, "payload", "registry", "README.md"), "tampered\n");

    const applied = artifactCommand([
      "apply",
      "--root",
      target,
      "--artifact",
      artifact,
      "--revision",
      revision,
    ]);
    expect(applied.status).toBe(1);
    expect(applied.stderr).toContain("does not match its manifest");
  });
});
