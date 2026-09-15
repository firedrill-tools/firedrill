import type { Diagnostic, RunWorldSetupInput, SourceSpan, StableId } from "@firedrill/contracts";
import type {
  BuildManifest,
  CanonicalWorldIr,
  PackageLock,
  ResolvedRunSetup,
  ToolArtifactLock,
} from "@firedrill/world-ir";

export type ToolSourceOrigin = ToolArtifactLock["source"];

export type ResourceKind = "world" | "tool" | "scenario" | "drill" | "suite" | "target";

export interface SourceDocument {
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly value: unknown;
  readonly spanAt: (path: readonly (string | number)[]) => SourceSpan;
}

export interface SourceProvenance {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly origin: ToolSourceOrigin;
}

export interface BundledTool {
  readonly lock: ToolArtifactLock;
  readonly bytes: Uint8Array;
  /** Canonical entry label resolved in the same guarded pass as sourcePaths. */
  readonly entryPath: string;
  /** Exact repository-relative source closure used to produce the locked artifact. */
  readonly sourcePaths: readonly string[];
  readonly ui?: {
    readonly assets: readonly { readonly artifactPath: string; readonly bytes: Uint8Array }[];
    readonly sourcePaths: readonly string[];
  };
}

export interface ToolSourceSet {
  readonly packageId: string;
  readonly declarationPath: string;
  /** Compiler-resolved entry module, using the same labels as behaviorPaths. */
  readonly entryPath?: string;
  readonly behaviorPaths: readonly string[];
  /** Exact static UI closure, separate from executable Tool behavior. */
  readonly uiPaths?: readonly string[];
  readonly origin: ToolSourceOrigin;
}

export interface CompiledBuild {
  readonly manifest: BuildManifest;
  readonly worldIr: CanonicalWorldIr;
  readonly packageLock: PackageLock;
  readonly setup?: ResolvedRunSetup;
  readonly sourceProvenance: readonly SourceProvenance[];
  readonly toolSources: readonly ToolSourceSet[];
  readonly buildDirectory?: string;
}

export interface CompileWorldOptions {
  readonly repositoryRoot: string;
  readonly materialize?: boolean;
  readonly buildRoot?: string;
  /** Produces a traceable immutable build for one test-local run setup. */
  readonly runSetup?: {
    readonly drillId: StableId;
    readonly setup: RunWorldSetupInput;
  };
}

export type CompileWorldResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly Diagnostic[];
      readonly build: CompiledBuild;
    }
  | {
      readonly status: "failed";
      readonly diagnostics: readonly Diagnostic[];
    };

export interface FormatWorldOptions {
  readonly repositoryRoot: string;
  readonly check?: boolean;
}

export interface FormattedSource {
  readonly path: string;
  readonly changed: boolean;
}

export type FormatWorldResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly Diagnostic[];
      readonly files: readonly FormattedSource[];
    }
  | {
      readonly status: "failed";
      readonly diagnostics: readonly Diagnostic[];
    };
