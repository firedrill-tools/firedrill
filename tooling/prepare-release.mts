import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { discoverPublicPackages, packPublicPackages } from "./public-packages.mts";
import { compareStableStrings } from "./stable-order.mts";

const SYFT_VERSION = "1.51.0";
const repositoryRoot = resolve(import.meta.dirname, "..");
const excludedSourceDirectories = new Set([".firedrill", ".git", "coverage", "dist", "node_modules"]);

interface SpdxPackage {
  readonly name?: string;
  readonly versionInfo?: string;
}

interface SpdxDocument {
  readonly spdxVersion?: string;
  readonly packages?: readonly SpdxPackage[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, [...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function ensureEmptyOutput(path: string): void {
  if (path === repositoryRoot || path.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("release output must be outside the source repository");
  }
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error(`release output is not a directory: ${path}`);
    if (readdirSync(path).length > 0) throw new Error(`release output must be empty: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

function sourceFiles(): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedSourceDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(repositoryRoot, path));
      else throw new Error(`public source contains an unsupported entry: ${relative(repositoryRoot, path)}`);
    }
  };
  visit(repositoryRoot);
  return files.sort();
}

function sourceTreeDigest(): string {
  const hash = createHash("sha256");
  for (const path of sourceFiles()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(repositoryRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitState(): { readonly clean: boolean; readonly revision: string | null } {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  return {
    clean: revision.status === 0 && status.trim() === "",
    revision: revision.status === 0 ? revision.stdout.trim() : null,
  };
}

function readSpdx(path: string): SpdxDocument {
  const document = JSON.parse(readFileSync(path, "utf8")) as SpdxDocument;
  if (document.spdxVersion !== "SPDX-2.3" || !Array.isArray(document.packages)) {
    throw new Error(`Syft did not produce a valid SPDX 2.3 document: ${path}`);
  }
  return document;
}

function generateSbom(
  syft: string,
  source: string,
  output: string,
  sourceName: string,
  sourceVersion: string,
): SpdxDocument {
  run(
    syft,
    [
      "scan",
      source,
      "-o",
      `spdx-json=${output}`,
      "--source-name",
      sourceName,
      "--source-version",
      sourceVersion,
    ],
    {
      env: { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: "false" },
    },
  );
  return readSpdx(output);
}

function assertReproducible(
  first: readonly { readonly name: string; readonly version: string; readonly sha256: string }[],
  second: readonly { readonly name: string; readonly version: string; readonly sha256: string }[],
): void {
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("release package archives are not byte-for-byte reproducible");
  }
}

const outputArgument = argument("--output");
const syftArgument = argument("--syft") ?? "syft";
const requireClean = process.argv.includes("--require-clean");

if (!outputArgument) {
  process.stderr.write(
    "Usage: pnpm release:prepare -- --output <empty-directory-outside-repo> [--syft <binary>] [--require-clean]\n",
  );
  process.exitCode = 2;
} else {
  const output = resolve(outputArgument);
  ensureEmptyOutput(output);
  const syftVersionOutput = run(syftArgument, ["version", "-o", "json"]);
  const syftVersion = (JSON.parse(syftVersionOutput) as { readonly version?: string }).version;
  if (syftVersion !== SYFT_VERSION) {
    throw new Error(`release preparation requires Syft ${SYFT_VERSION}; found ${syftVersion ?? "unknown"}`);
  }

  const source = gitState();
  if (requireClean && !source.clean) {
    throw new Error("release candidate preparation requires a committed, clean source tree");
  }

  const publicPackages = discoverPublicPackages(repositoryRoot);
  const frameworkVersions = new Set(
    publicPackages
      .filter((package_) => package_.directory.startsWith("packages/"))
      .map(({ version }) => version),
  );
  if (frameworkVersions.size !== 1) {
    throw new Error(`framework package versions differ: ${[...frameworkVersions].sort().join(", ")}`);
  }
  const frameworkVersion = [...frameworkVersions][0];
  if (frameworkVersion === undefined) throw new Error("no publishable framework packages were discovered");

  const packagesDirectory = join(output, "packages");
  const artifacts = packPublicPackages({ repositoryRoot, outputDirectory: packagesDirectory });
  const temporary = mkdtempSync(join(tmpdir(), "firedrill-release-"));
  try {
    const reproduced = packPublicPackages({
      repositoryRoot,
      outputDirectory: join(temporary, "reproduced"),
    });
    assertReproducible(artifacts, reproduced);

    const runtimeConsumer = join(temporary, "runtime-consumer");
    mkdirSync(runtimeConsumer);
    const artifactPaths = new Map(
      artifacts.map((artifact) => [artifact.name, join(packagesDirectory, artifact.archive)]),
    );
    writeFileSync(
      join(runtimeConsumer, "package.json"),
      `${JSON.stringify(
        {
          name: "firedrill-release-runtime",
          private: true,
          version: frameworkVersion,
          dependencies: Object.fromEntries([...artifactPaths].map(([name, path]) => [name, `file:${path}`])),
          pnpm: {
            overrides: Object.fromEntries([...artifactPaths].map(([name, path]) => [name, `file:${path}`])),
          },
        },
        null,
        2,
      )}\n`,
    );
    run("pnpm", ["install", "--offline", "--prod", "--ignore-scripts"], {
      cwd: runtimeConsumer,
    });

    const sbomDirectory = join(output, "sbom");
    const packageSbomDirectory = join(sbomDirectory, "packages");
    mkdirSync(packageSbomDirectory, { recursive: true });

    const sourceSbom = join(sbomDirectory, "firedrill-source.spdx.json");
    const sourceDocument = generateSbom(
      syftArgument,
      `file:${join(repositoryRoot, "pnpm-lock.yaml")}`,
      sourceSbom,
      "firedrill-source",
      frameworkVersion,
    );
    if ((sourceDocument.packages?.length ?? 0) < 10) {
      throw new Error("source SBOM omitted the pnpm dependency graph");
    }

    const runtimeSbom = join(sbomDirectory, "firedrill-runtime.spdx.json");
    const runtimeDocument = generateSbom(
      syftArgument,
      `dir:${runtimeConsumer}`,
      runtimeSbom,
      "firedrill-runtime",
      frameworkVersion,
    );
    const runtimeNames = new Set(runtimeDocument.packages?.map(({ name }) => name));
    const missingRuntimePackages = artifacts
      .map(({ name }) => name)
      .filter((name) => !runtimeNames.has(name));
    if (missingRuntimePackages.length > 0) {
      throw new Error(`runtime SBOM omitted public packages: ${missingRuntimePackages.join(", ")}`);
    }

    const packageSboms = artifacts.map((artifact) => {
      const path = join(packageSbomDirectory, `${basename(artifact.archive, ".tgz")}.spdx.json`);
      const document = generateSbom(
        syftArgument,
        `file:${join(packagesDirectory, artifact.archive)}`,
        path,
        artifact.name,
        artifact.version,
      );
      if (
        !document.packages?.some(
          (package_) => package_.name === artifact.name && package_.versionInfo === artifact.version,
        )
      ) {
        throw new Error(`package SBOM omitted ${artifact.name}@${artifact.version}`);
      }
      return {
        kind: "package" as const,
        package: artifact.name,
        path: relative(output, path),
        sha256: sha256(path),
      };
    });

    const sboms = [
      {
        kind: "source" as const,
        path: relative(output, sourceSbom),
        sha256: sha256(sourceSbom),
      },
      {
        kind: "runtime" as const,
        path: relative(output, runtimeSbom),
        sha256: sha256(runtimeSbom),
      },
      ...packageSboms,
    ];

    const checksums = [
      ...artifacts.map(({ archive, sha256: digest }) => ({
        path: `packages/${archive}`,
        sha256: digest,
      })),
      { path: "packages/manifest.json", sha256: sha256(join(packagesDirectory, "manifest.json")) },
      ...sboms.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    ].sort((left, right) => compareStableStrings(left.path, right.path));
    writeFileSync(
      join(output, "SHA256SUMS"),
      `${checksums.map(({ path, sha256: digest }) => `${digest}  ${path}`).join("\n")}\n`,
    );

    const release = {
      schemaVersion: 1,
      status: source.clean ? "release-candidate" : "rehearsal",
      source: {
        clean: source.clean,
        revision: source.revision,
        treeSha256: sourceTreeDigest(),
      },
      toolchain: {
        node: process.version,
        pnpm: run("pnpm", ["--version"]).trim(),
        syft: syftVersion,
      },
      packages: artifacts.map(({ directory, name, version, archive, sha256: digest }) => ({
        directory,
        name,
        version,
        path: `packages/${archive}`,
        sha256: digest,
      })),
      sboms,
      checksums: "SHA256SUMS",
    };
    writeFileSync(join(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: release.status,
          outputDirectory: output,
          packages: artifacts.length,
          sboms: sboms.length,
          releaseManifest: join(output, "release.json"),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (temporary.startsWith(`${tmpdir()}/firedrill-release-`)) {
      rmSync(temporary, { force: true, recursive: true });
    }
  }
}
