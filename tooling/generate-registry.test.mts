import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  temporaryRoots.push(root);
  return root;
}

function command(cwd: string, executable: string, arguments_: readonly string[]): string {
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sourceRepository(lifecycle: "active" | "deprecated" | "revoked" = "active"): {
  readonly root: string;
  readonly revision: string;
} {
  const root = temporaryRoot("firedrill-registry-source-");
  mkdirSync(join(root, "packages", "records"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"community-tools","private":true}\n');
  writeFileSync(
    join(root, "packages", "records", "package.json"),
    `${JSON.stringify(
      {
        name: "@firedrill-tools/records",
        version: "0.1.0",
        description: "A stateful records Tool.",
        license: "Apache-2.0",
        firedrill: {
          layer: "tool-pack",
          tool: "records.tool.json",
          lifecycle,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "packages", "records", "records.tool.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        manifest: {
          id: "records",
          version: "0.1.0",
          engine: ">=0.1.0",
          operations: [{ id: "records.get", fidelity: "behavioral" }],
        },
      },
      null,
      2,
    )}\n`,
  );
  command(root, "git", ["init"]);
  command(root, "git", ["config", "user.name", "Registry Test"]);
  command(root, "git", ["config", "user.email", "registry-test@example.invalid"]);
  command(root, "git", ["remote", "add", "origin", "git@github.com:firedrill-tools/community-fixture.git"]);
  command(root, "git", ["add", "."]);
  command(root, "git", ["commit", "-m", "fixture"]);
  return { root, revision: command(root, "git", ["rev-parse", "HEAD"]) };
}

function generate(arguments_: readonly string[]) {
  return spawnSync("pnpm", ["exec", "tsx", "tooling/generate-registry.mts", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("community registry generation", () => {
  it("generates from one clean checkout at the requested exact revision", () => {
    const source = sourceRepository();
    const output = temporaryRoot("firedrill-registry-output-");

    const result = generate(["--source", source.root, "--revision", source.revision, "--output", output]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const index = JSON.parse(readFileSync(join(output, "index.json"), "utf8"));
    expect(index.sourceRevision).toBe(source.revision);
    expect(index.packages).toHaveLength(1);
  });

  it("rejects a checkout that differs from the requested revision", () => {
    const source = sourceRepository();
    const result = generate([
      "--source",
      source.root,
      "--revision",
      "0".repeat(40),
      "--output",
      temporaryRoot("firedrill-registry-output-"),
    ]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain("not requested revision");
  });

  it("rejects uncommitted source instead of silently importing it", () => {
    const source = sourceRepository();
    writeFileSync(join(source.root, "unreviewed.txt"), "not committed\n");
    const result = generate([
      "--source",
      source.root,
      "--revision",
      source.revision,
      "--output",
      temporaryRoot("firedrill-registry-output-"),
    ]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain("must be clean");
  });

  it("requires source metadata to match the verified release catalog", () => {
    const source = sourceRepository();
    const releaseRoot = temporaryRoot("firedrill-registry-release-");
    const catalog = join(releaseRoot, "catalog.json");
    writeFileSync(
      catalog,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceRepository: "https://github.com/firedrill-tools/community-fixture.git",
          sourceRevision: source.revision,
          packages: [
            {
              name: "@firedrill-tools/records",
              version: "0.1.0",
              tool: "records",
              lifecycle: "active",
              sourceSubdirectory: "packages/records",
              definition: "records.tool.json",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const accepted = generate([
      "--source",
      source.root,
      "--revision",
      source.revision,
      "--release-catalog",
      catalog,
      "--output",
      temporaryRoot("firedrill-registry-output-"),
    ]);
    expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);

    const changed = JSON.parse(readFileSync(catalog, "utf8"));
    changed.packages[0].version = "0.1.1";
    writeFileSync(catalog, `${JSON.stringify(changed, null, 2)}\n`);
    const rejected = generate([
      "--source",
      source.root,
      "--revision",
      source.revision,
      "--release-catalog",
      catalog,
      "--output",
      temporaryRoot("firedrill-registry-output-"),
    ]);
    expect(rejected.status).toBe(1);
    expect(`${rejected.stderr}${rejected.stdout}`).toContain(
      "does not match the verified community release catalog",
    );
  });

  it("retains revoked package tombstones without offering an installable release", () => {
    const source = sourceRepository("revoked");
    const releaseRoot = temporaryRoot("firedrill-registry-release-");
    const catalog = join(releaseRoot, "catalog.json");
    writeFileSync(
      catalog,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceRepository: "https://github.com/firedrill-tools/community-fixture.git",
          sourceRevision: source.revision,
          packages: [
            {
              name: "@firedrill-tools/records",
              version: "0.1.0",
              tool: "records",
              lifecycle: "revoked",
              sourceSubdirectory: "packages/records",
              definition: "records.tool.json",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const output = temporaryRoot("firedrill-registry-output-");
    const result = generate([
      "--source",
      source.root,
      "--revision",
      source.revision,
      "--release-catalog",
      catalog,
      "--output",
      output,
    ]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const index = JSON.parse(readFileSync(join(output, "index.json"), "utf8"));
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0].lifecycle).toBe("revoked");
  });

  it("rejects duplicate package names in a verified release", () => {
    const source = sourceRepository();
    const releaseRoot = temporaryRoot("firedrill-registry-release-");
    const catalog = join(releaseRoot, "catalog.json");
    const record = {
      name: "@firedrill-tools/records",
      version: "0.1.0",
      tool: "records",
      lifecycle: "active",
      sourceSubdirectory: "packages/records",
      definition: "records.tool.json",
    };
    writeFileSync(
      catalog,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceRepository: "https://github.com/firedrill-tools/community-fixture.git",
          sourceRevision: source.revision,
          packages: [record, { ...record, version: "0.1.1" }],
        },
        null,
        2,
      )}\n`,
    );

    const result = generate([
      "--source",
      source.root,
      "--revision",
      source.revision,
      "--release-catalog",
      catalog,
      "--output",
      temporaryRoot("firedrill-registry-output-"),
    ]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain("duplicate package name");
  });
});
