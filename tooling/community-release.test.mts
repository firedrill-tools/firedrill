import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];
const revision = "a".repeat(40);

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-community-release-"));
  temporaryRoots.push(root);
  return root;
}

function digest(algorithm: "sha256" | "sha512", bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

function activeRecord(root: string) {
  const archive = "firedrill-tools-records-0.1.0.tgz";
  const bytes = Buffer.from("deterministic package bytes\n");
  writeFileSync(join(root, archive), bytes);
  return {
    name: "@firedrill-tools/records",
    version: "0.1.0",
    tool: "records",
    lifecycle: "active",
    sourceSubdirectory: "packages/records",
    definition: "records.tool.json",
    engines: { node: ">=20.19", firedrill: ">=0.1.0 <0.2.0" },
    archive,
    size: bytes.length,
    sha256: digest("sha256", bytes),
    sha512: digest("sha512", bytes),
  };
}

function revokedRecord() {
  return {
    name: "@firedrill-tools/retired",
    version: "0.1.0",
    tool: "retired",
    lifecycle: "revoked",
    sourceSubdirectory: "packages/retired",
    definition: "retired.tool.json",
    engines: { node: ">=20.19", firedrill: ">=0.1.0 <0.2.0" },
  };
}

function writeCatalog(root: string, packages: readonly unknown[]): string {
  const path = join(root, "catalog.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceRepository: "https://github.com/firedrill-tools/firedrill-tools.git",
        sourceRevision: revision,
        packages,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function verify(root: string, extraArguments: readonly string[] = []) {
  return spawnSync(
    "node",
    [
      ".github/scripts/verify-community-release.mjs",
      "--artifact",
      root,
      "--revision",
      revision,
      ...extraArguments,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("community release verification", () => {
  it("accepts exact package bytes and revoked tombstones", () => {
    const root = temporaryRoot();
    const catalog = writeCatalog(root, [activeRecord(root), revokedRecord()]);
    const catalogDigest = digest("sha256", readFileSync(catalog));

    const result = verify(root, ["--catalog-sha256", catalogDigest]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("verified 2 community Tool record(s)");
  });

  it("rejects duplicate package names before catalog generation", () => {
    const root = temporaryRoot();
    const record = activeRecord(root);
    writeCatalog(root, [record, { ...record, version: "0.1.1", tool: "records-next" }]);

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate package name");
  });

  it("rejects the redundant tool prefix in the community package scope", () => {
    const root = temporaryRoot();
    const record = activeRecord(root);
    writeCatalog(root, [{ ...record, name: "@firedrill-tools/tool-records" }]);

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package name is invalid");
  });

  it("rejects package bytes that do not match the release catalog", () => {
    const root = temporaryRoot();
    const record = activeRecord(root);
    writeCatalog(root, [record]);
    writeFileSync(join(root, record.archive), "changed package bytes\n");

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/size does not match|SHA-256 does not match/);
  });
});
