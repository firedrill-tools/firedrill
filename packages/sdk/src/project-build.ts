import { join } from "node:path";
import { compileWorld } from "@firedrill/compiler";
import type { Diagnostic } from "@firedrill/contracts";
import { Sha256Schema } from "@firedrill/contracts";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import { loadWorldBuild } from "@firedrill/world-build";
import { FiredrillProjectError } from "./project-error.js";

export interface PreparedExecutableBuild {
  readonly build: LoadedWorldBuild;
  readonly diagnostics: readonly Diagnostic[];
}

/** Internal shared entry point for repository-level SDK operations. */
export async function prepareExecutableBuild(
  root: string,
  buildHash?: string,
): Promise<PreparedExecutableBuild> {
  if (buildHash !== undefined) {
    const parsed = Sha256Schema.safeParse(buildHash);
    if (!parsed.success) {
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        "buildHash must be a sha256:<64 lowercase hex> value",
      );
    }
    const directory = join(root, ".firedrill", "builds", parsed.data.slice("sha256:".length));
    const loaded = await loadWorldBuild(directory);
    if (loaded.status === "failed") {
      throw new FiredrillProjectError("framework.BUILD_INVALID", "the requested build is unavailable", {
        diagnostics: loaded.diagnostics,
        details: { buildHash: parsed.data },
      });
    }
    if (loaded.build.manifest.buildHash !== parsed.data) {
      throw new FiredrillProjectError(
        "framework.BUILD_HASH_MISMATCH",
        "the loaded build does not match buildHash",
        { details: { expected: parsed.data, actual: loaded.build.manifest.buildHash } },
      );
    }
    return { build: loaded.build, diagnostics: [] };
  }

  const compiled = await compileWorld({ repositoryRoot: root, materialize: true });
  if (compiled.status === "failed") {
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "Firedrill source is invalid", {
      diagnostics: compiled.diagnostics,
    });
  }
  const directory = compiled.build.buildDirectory;
  if (directory === undefined) {
    throw new FiredrillProjectError("framework.BUILD_INVALID", "the compiler produced no executable build");
  }
  const loaded = await loadWorldBuild(directory);
  if (loaded.status === "failed") {
    throw new FiredrillProjectError("framework.BUILD_INVALID", "the compiled build failed verification", {
      diagnostics: loaded.diagnostics,
    });
  }
  return { build: loaded.build, diagnostics: compiled.diagnostics };
}
