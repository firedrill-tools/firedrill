import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_RELEASE_IDENTITIES,
  type NpmCommandRunner,
  type PublishArtifact,
  loadReleaseBundle,
  publishArchive,
  topologicalPublishLayers,
  verifyExistingPublication,
} from "./publish-release.mts";

function orderArtifact(name: string, dependencies: readonly string[] = []) {
  return {
    name,
    manifest: { dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "1.0.0"])) },
  };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function publishArtifact(): PublishArtifact {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-publish-test-"));
  temporaryDirectories.push(directory);
  const absolutePath = join(directory, "package.tgz");
  writeFileSync(absolutePath, "exact release bytes");
  return {
    name: "@firedrill-run/example",
    version: "1.2.3",
    path: "package.tgz",
    sha256: createHash("sha256").update("exact release bytes").digest("hex"),
    absolutePath,
    manifest: { name: "@firedrill-run/example", version: "1.2.3" },
  };
}

function exactRegistryDist(): string {
  const bytes = "exact release bytes";
  return JSON.stringify({
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  });
}

function exactRegistryTags(version = "1.2.3"): string {
  return JSON.stringify({ next: version });
}

function releaseBundle(
  options: {
    readonly clean?: boolean;
    readonly revision?: string;
    readonly identities?: readonly string[];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-release-bundle-test-"));
  temporaryDirectories.push(directory);
  const packagesDirectory = join(directory, "packages");
  const stagingDirectory = join(directory, "staging", "package");
  mkdirSync(packagesDirectory, { recursive: true });
  mkdirSync(stagingDirectory, { recursive: true });
  const packages = (options.identities ?? CORE_RELEASE_IDENTITIES).map((identity) => {
    const separator = identity.lastIndexOf("@");
    const name = identity.slice(0, separator);
    const version = identity.slice(separator + 1);
    writeFileSync(join(stagingDirectory, "package.json"), `${JSON.stringify({ name, version })}\n`);
    const archive = `${name.slice(1).replace("/", "-")}-${version}.tgz`;
    const absoluteArchive = join(packagesDirectory, archive);
    createTar(
      {
        cwd: join(directory, "staging"),
        file: absoluteArchive,
        gzip: true,
        portable: true,
        sync: true,
      },
      ["package/package.json"],
    );
    const relativePath = `packages/${archive}`;
    return {
      directory: `packages/${name.slice(name.lastIndexOf("/") + 1)}`,
      name,
      version,
      path: relativePath,
      sha256: createHash("sha256").update(readFileSync(absoluteArchive)).digest("hex"),
    };
  });
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${packages.map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`,
  );
  writeFileSync(
    join(directory, "release.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      status: "release-candidate",
      source: {
        clean: options.clean ?? true,
        revision: options.revision ?? "a".repeat(40),
      },
      packages,
      checksums: "SHA256SUMS",
    })}\n`,
  );
  return directory;
}

function commandResult(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

describe("release publication order", () => {
  it("publishes dependencies before consumers with stable ordering", () => {
    expect(
      topologicalPublishLayers([
        orderArtifact("@firedrill-run/cli", ["@firedrill-run/sdk"]),
        orderArtifact("@firedrill-run/contracts"),
        orderArtifact("@firedrill-run/sdk", ["@firedrill-run/contracts"]),
        orderArtifact("@firedrill-run/browser-tests"),
      ]),
    ).toEqual([
      ["@firedrill-run/browser-tests", "@firedrill-run/contracts"],
      ["@firedrill-run/sdk"],
      ["@firedrill-run/cli"],
    ]);
  });

  it("rejects a dependency cycle", () => {
    expect(() =>
      topologicalPublishLayers([
        orderArtifact("@firedrill-run/a", ["@firedrill-run/b"]),
        orderArtifact("@firedrill-run/b", ["@firedrill-run/a"]),
      ]),
    ).toThrow("dependency cycle");
  });
});

describe("reviewed release bundle", () => {
  it("accepts only the exact clean package set at the expected source revision", () => {
    const directory = releaseBundle();
    expect(
      loadReleaseBundle(directory, {
        expectedRevision: "a".repeat(40),
        requireReleaseCandidate: true,
      }),
    ).toHaveLength(20);
  });

  it("rejects dirty or mismatched source before publication", () => {
    expect(() =>
      loadReleaseBundle(releaseBundle({ clean: false }), {
        expectedRevision: "a".repeat(40),
        requireReleaseCandidate: true,
      }),
    ).toThrow("release source must be clean");
    expect(() =>
      loadReleaseBundle(releaseBundle({ revision: "b".repeat(40) }), {
        expectedRevision: "a".repeat(40),
        requireReleaseCandidate: true,
      }),
    ).toThrow("reviewed revision");
  });

  it("rejects any package set other than the exact 20-package allowlist", () => {
    const directory = releaseBundle({ identities: CORE_RELEASE_IDENTITIES.slice(1) });
    expect(() =>
      loadReleaseBundle(directory, {
        expectedRevision: "a".repeat(40),
        requireReleaseCandidate: true,
      }),
    ).toThrow("exact reviewed 20-package allowlist");
  });
});

describe("release publication failure reconciliation", () => {
  it("does not retry a successful upload while npm publish-time scanning is pending", () => {
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      return arguments_[0] === "publish"
        ? commandResult(0, "+ @firedrill-run/example@1.2.3")
        : commandResult(1, "", "npm error code E404");
    };

    expect(publishArchive(publishArtifact(), { provenance: false, tag: "next" }, runNpm)).toBe("accepted");
    expect(commands.map(([command]) => command)).toEqual(["publish", "view"]);
  });

  it("disables npm fetch retries and stops after one rate-limited registry write", () => {
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      return arguments_[0] === "publish"
        ? commandResult(1, "", "npm error code E429\nnpm error rate limit exceeded")
        : commandResult(1, "", "npm error code E404");
    };

    expect(() => publishArchive(publishArtifact(), { provenance: false, tag: "next" }, runNpm)).toThrow(
      "stopped after one registry write attempt",
    );

    expect(commands.map(([command]) => command)).toEqual(["publish", "view"]);
    expect(commands[0]).toContain("--fetch-retries=0");
  });

  it("accepts exact published bytes when a rate-limited write response is ambiguous", () => {
    const artifact = publishArtifact();
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      if (arguments_[0] === "publish") {
        return commandResult(1, "", "npm error code E429\nnpm error rate limit exceeded");
      }
      return arguments_.includes("dist-tags")
        ? commandResult(0, exactRegistryTags())
        : commandResult(0, exactRegistryDist());
    };

    expect(publishArchive(artifact, { provenance: false, tag: "next" }, runNpm)).toBe("reconciled");
    expect(commands.map(([command]) => command)).toEqual(["publish", "view", "view"]);
    for (const command of commands) {
      expect(command).toContain("--registry");
      expect(command).toContain("https://registry.npmjs.org");
    }
  });

  it("refuses a matching version when the requested tag is missing or points elsewhere", () => {
    const artifact = publishArtifact();
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      return arguments_.includes("dist-tags")
        ? commandResult(0, JSON.stringify({ next: "1.2.2" }))
        : commandResult(0, exactRegistryDist());
    };

    expect(() => verifyExistingPublication(artifact, "next", runNpm)).toThrow(
      "Refusing to mutate npm tags automatically",
    );
    expect(commands).toHaveLength(2);
    expect(commands.flat()).not.toContain("dist-tag");
  });

  it("verifies the requested tag after npm accepts a publish", () => {
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      if (arguments_[0] === "publish") return commandResult(0, "+ @firedrill-run/example@1.2.3");
      return arguments_.includes("dist-tags")
        ? commandResult(0, JSON.stringify({ next: "1.2.2" }))
        : commandResult(0, exactRegistryDist());
    };

    expect(() => publishArchive(publishArtifact(), { provenance: false, tag: "next" }, runNpm)).toThrow(
      "Refusing to mutate npm tags automatically",
    );
    expect(commands.filter(([command]) => command === "publish")).toHaveLength(1);
    expect(commands.flat()).not.toContain("dist-tag");
  });

  it("checks the registry before reporting an ordinary publish failure", () => {
    const commands: string[][] = [];
    const runNpm: NpmCommandRunner = (arguments_) => {
      commands.push([...arguments_]);
      return arguments_[0] === "publish"
        ? commandResult(1, "", "npm error code E403")
        : commandResult(1, "", "npm error code E404");
    };

    expect(() => publishArchive(publishArtifact(), { provenance: false, tag: "next" }, runNpm)).toThrow(
      "npm publish failed",
    );
    expect(commands.map(([command]) => command)).toEqual(["publish", "view"]);
  });
});
