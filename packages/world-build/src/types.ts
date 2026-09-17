import type { Diagnostic } from "@firedrill-tools/contracts";
import type { ToolDefinition } from "@firedrill-tools/tool-sdk";
import type {
  BuildManifest,
  CanonicalWorldIr,
  PackageLock,
  ResolvedRunSetup,
} from "@firedrill-tools/world-ir";

export interface LoadedToolUiAsset {
  readonly path: string;
  readonly mediaType: string;
  readonly artifactHash: string;
  readonly bytes: Uint8Array;
}

export interface LoadedToolUi {
  readonly packageId: string;
  readonly entry: string;
  readonly assets: readonly LoadedToolUiAsset[];
}

export interface LoadedWorldBuild {
  readonly manifest: BuildManifest;
  readonly worldIr: CanonicalWorldIr;
  readonly packageLock: PackageLock;
  readonly setup?: ResolvedRunSetup;
  readonly tools: readonly ToolDefinition[];
  /** Verified immutable static assets; never a path back to repository source. */
  readonly toolUis: readonly LoadedToolUi[];
  readonly directory: string;
}

export type LoadWorldBuildResult =
  | { readonly status: "success"; readonly build: LoadedWorldBuild; readonly diagnostics: readonly [] }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };
