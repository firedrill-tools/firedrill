import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NpmCommandRunner,
  type PublishArtifact,
  publishArchive,
  topologicalPublishLayers,
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
      return arguments_[0] === "publish"
        ? commandResult(1, "", "npm error code E429\nnpm error rate limit exceeded")
        : commandResult(0, exactRegistryDist());
    };

    expect(publishArchive(artifact, { provenance: false, tag: "next" }, runNpm)).toBe("reconciled");
    expect(commands.map(([command]) => command)).toEqual(["publish", "view"]);
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
