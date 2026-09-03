import type { Diagnostic } from "@firedrill/contracts";
import type { ToolDefinition } from "@firedrill/tool-sdk";
import type { BuildManifest, CanonicalWorldIr, PackageLock, ResolvedRunSetup } from "@firedrill/world-ir";

export interface LoadedWorldBuild {
  readonly manifest: BuildManifest;
  readonly worldIr: CanonicalWorldIr;
  readonly packageLock: PackageLock;
  readonly setup?: ResolvedRunSetup;
  readonly tools: readonly ToolDefinition[];
  readonly directory: string;
}

export type LoadWorldBuildResult =
  | { readonly status: "success"; readonly build: LoadedWorldBuild; readonly diagnostics: readonly [] }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };
