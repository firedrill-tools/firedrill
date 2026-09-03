import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DiagnosticSchema, FIREDRILL_ENGINE_VERSION } from "@firedrill/contracts";
import type { Diagnostic, ToolPackageManifest } from "@firedrill/contracts";
import { defineTool } from "@firedrill/tool-sdk";
import type {
  ToolBehaviorDefinition,
  ToolCallbackCodec,
  ToolHttpRouteCodec,
  ToolOperationHandler,
  ToolSubscriptionHandler,
} from "@firedrill/tool-sdk";
import {
  BUILD_MANIFEST_SCHEMA_VERSION,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PACKAGE_LOCK_SCHEMA_VERSION,
  PackageLockSchema,
  ResolvedRunSetupSchema,
  WORLD_IR_SCHEMA_VERSION,
  semanticHash,
  sha256Text,
} from "@firedrill/world-ir";
import type { ToolArtifactLock } from "@firedrill/world-ir";
import { loadToolModule } from "./load-tool-module.js";
import type { LoadWorldBuildResult } from "./types.js";

function diagnostic(code: string, message: string, path?: string, suggestion?: string): Diagnostic {
  return DiagnosticSchema.parse({
    code,
    severity: "error",
    message,
    ...(path === undefined
      ? {}
      : { span: { path, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }),
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function filesUnder(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else files.push(`${relativePath}/<unsupported>`);
  }
  return files.sort();
}

function parseArtifact<T>(
  buildRoot: string,
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error } },
  label: string,
  expectedSchemaVersion: number,
):
  | { readonly status: "success"; readonly value: T }
  | { readonly status: "failed"; readonly diagnostic: Diagnostic } {
  const absolutePath = resolve(buildRoot, ...path.split("/"));
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    return {
      status: "failed",
      diagnostic: diagnostic(
        "FD1601",
        `cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ),
    };
  }
  if (!contained(buildRoot, realPath)) {
    return {
      status: "failed",
      diagnostic: diagnostic("FD1601", `${label} escapes the build directory`, path),
    };
  }
  try {
    const value = JSON.parse(readFileSync(realPath, "utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Number.isSafeInteger((value as Record<string, unknown>).schemaVersion) &&
      (value as Record<string, unknown>).schemaVersion !== expectedSchemaVersion
    ) {
      return {
        status: "failed",
        diagnostic: diagnostic(
          "FD1604",
          `unsupported ${label} schemaVersion ${String((value as Record<string, unknown>).schemaVersion)}; this release supports ${expectedSchemaVersion}`,
          path,
          "Rebuild the world with a compatible Firedrill release; generated build files must not be edited or relabeled.",
        ),
      };
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        status: "failed",
        diagnostic: diagnostic("FD1601", `invalid ${label}: ${parsed.error.message}`, path),
      };
    }
    return { status: "success", value: parsed.data };
  } catch (error) {
    return {
      status: "failed",
      diagnostic: diagnostic(
        "FD1601",
        `cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ),
    };
  }
}

function behaviorExport(value: unknown): ToolBehaviorDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool export must be an object with operation handlers");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) => key !== "operations" && key !== "subscriptions" && key !== "http" && key !== "callbacks",
    )
  ) {
    throw new TypeError("Tool export accepts only operations, subscriptions, http, and callbacks");
  }
  if (
    typeof record.operations !== "object" ||
    record.operations === null ||
    Array.isArray(record.operations)
  ) {
    throw new TypeError("Tool export operations must be an object");
  }
  if (
    record.subscriptions !== undefined &&
    (typeof record.subscriptions !== "object" ||
      record.subscriptions === null ||
      Array.isArray(record.subscriptions))
  ) {
    throw new TypeError("Tool export subscriptions must be an object");
  }
  if (
    record.http !== undefined &&
    (typeof record.http !== "object" || record.http === null || Array.isArray(record.http))
  ) {
    throw new TypeError("Tool export http must be an object");
  }
  if (
    record.callbacks !== undefined &&
    (typeof record.callbacks !== "object" || record.callbacks === null || Array.isArray(record.callbacks))
  ) {
    throw new TypeError("Tool export callbacks must be an object");
  }
  return {
    operations: record.operations as Readonly<Record<string, ToolOperationHandler>>,
    ...(record.subscriptions === undefined
      ? {}
      : {
          subscriptions: record.subscriptions as Readonly<Record<string, ToolSubscriptionHandler>>,
        }),
    ...(record.http === undefined
      ? {}
      : {
          http: record.http as Readonly<Record<string, ToolHttpRouteCodec>>,
        }),
    ...(record.callbacks === undefined
      ? {}
      : {
          callbacks: record.callbacks as Readonly<Record<string, ToolCallbackCodec>>,
        }),
  };
}

async function loadTool(input: {
  readonly buildRoot: string;
  readonly manifest: ToolPackageManifest;
  readonly lock: ToolArtifactLock;
}): Promise<
  | { readonly status: "success"; readonly tool: ReturnType<typeof defineTool> }
  | { readonly status: "failed"; readonly diagnostic: Diagnostic }
> {
  const artifactPath = resolve(input.buildRoot, ...input.lock.artifactPath.split("/"));
  let realPath: string;
  try {
    realPath = realpathSync(artifactPath);
  } catch (error) {
    return {
      status: "failed",
      diagnostic: diagnostic(
        "FD1601",
        `cannot read Tool artifact: ${error instanceof Error ? error.message : String(error)}`,
        input.lock.artifactPath,
      ),
    };
  }
  if (!contained(input.buildRoot, realPath)) {
    return {
      status: "failed",
      diagnostic: diagnostic("FD1601", "Tool artifact escapes the build directory", input.lock.artifactPath),
    };
  }
  const bytes = readFileSync(realPath);
  if (sha256Text(bytes) !== input.lock.artifactHash) {
    return {
      status: "failed",
      diagnostic: diagnostic(
        "FD1602",
        "Tool artifact hash does not match the package lock",
        input.lock.artifactPath,
      ),
    };
  }
  try {
    const module = await loadToolModule(
      `${pathToFileURL(realPath).href}?firedrillArtifact=${input.lock.artifactHash.slice(7)}`,
    );
    if (!(input.lock.exportName in module)) {
      throw new TypeError(`module does not export ${input.lock.exportName}`);
    }
    const behavior = behaviorExport(module[input.lock.exportName]);
    return {
      status: "success",
      tool: defineTool({
        manifest: input.manifest,
        operations: behavior.operations,
        ...(behavior.subscriptions === undefined ? {} : { subscriptions: behavior.subscriptions }),
        ...(behavior.http === undefined ? {} : { http: behavior.http }),
        ...(behavior.callbacks === undefined ? {} : { callbacks: behavior.callbacks }),
      }),
    };
  } catch (error) {
    return {
      status: "failed",
      diagnostic: diagnostic(
        "FD1603",
        `cannot load Tool behavior: ${error instanceof Error ? error.message : String(error)}`,
        input.lock.artifactPath,
      ),
    };
  }
}

export async function loadWorldBuild(buildDirectory: string): Promise<LoadWorldBuildResult> {
  let root: string;
  try {
    root = realpathSync(resolve(buildDirectory));
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic(
          "FD1601",
          `cannot open build directory: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  const manifestResult = parseArtifact(
    root,
    "build.json",
    BuildManifestSchema,
    "build manifest",
    BUILD_MANIFEST_SCHEMA_VERSION,
  );
  if (manifestResult.status === "failed")
    return { status: "failed", diagnostics: [manifestResult.diagnostic] };
  const manifest = manifestResult.value;
  const irResult = parseArtifact(
    root,
    manifest.artifacts.worldIr,
    CanonicalWorldIrSchema,
    "world IR",
    WORLD_IR_SCHEMA_VERSION,
  );
  if (irResult.status === "failed") return { status: "failed", diagnostics: [irResult.diagnostic] };
  const lockResult = parseArtifact(
    root,
    manifest.artifacts.packageLock,
    PackageLockSchema,
    "package lock",
    PACKAGE_LOCK_SCHEMA_VERSION,
  );
  if (lockResult.status === "failed") return { status: "failed", diagnostics: [lockResult.diagnostic] };
  const setupResult =
    manifest.artifacts.setup === undefined
      ? undefined
      : parseArtifact(root, manifest.artifacts.setup, ResolvedRunSetupSchema, "run setup", 1);
  if (setupResult?.status === "failed") {
    return { status: "failed", diagnostics: [setupResult.diagnostic] };
  }
  const worldIr = irResult.value;
  const packageLock = lockResult.value;
  const setup = setupResult?.value;

  const errors: Diagnostic[] = [];
  if (semanticHash(worldIr) !== manifest.irHash) {
    errors.push(
      diagnostic("FD1602", "world IR hash does not match the build manifest", manifest.artifacts.worldIr),
    );
  }
  if (semanticHash(packageLock) !== manifest.packageLockHash) {
    errors.push(
      diagnostic(
        "FD1602",
        "package-lock hash does not match the build manifest",
        manifest.artifacts.packageLock,
      ),
    );
  }
  if (
    manifest.engineVersion !== FIREDRILL_ENGINE_VERSION ||
    worldIr.engineVersion !== FIREDRILL_ENGINE_VERSION ||
    packageLock.engineVersion !== FIREDRILL_ENGINE_VERSION
  ) {
    errors.push(
      diagnostic(
        "FD1602",
        `build requires engine ${manifest.engineVersion}; current engine is ${FIREDRILL_ENGINE_VERSION}`,
        "build.json",
      ),
    );
  }
  if (manifest.worldId !== worldIr.world.id) {
    errors.push(diagnostic("FD1602", "build world id does not match world IR", "build.json"));
  }
  if (setup !== undefined) {
    const setupEntry = manifest.provenance.find((entry) => entry.kind === "setup");
    if (
      setupEntry === undefined ||
      setupEntry.id !== setup.drillId ||
      setupEntry.contentHash !== setup.setupHash
    ) {
      errors.push(
        diagnostic("FD1602", "run setup does not match build provenance", manifest.artifacts.setup),
      );
    }
    if (!worldIr.drills.some((drill) => drill.id === setup.drillId)) {
      errors.push(
        diagnostic(
          "FD1602",
          `run setup references unavailable drill ${setup.drillId}`,
          manifest.artifacts.setup,
        ),
      );
    }
  }

  const manifests = new Map(worldIr.tools.map((manifest_) => [manifest_.id, manifest_]));
  const locks = new Map(packageLock.packages.map((lock) => [lock.packageId, lock]));
  if (manifests.size !== locks.size) {
    errors.push(
      diagnostic("FD1602", "world IR and package lock contain different Tool sets", "packages.lock.json"),
    );
  }
  for (const [packageId, manifest_] of manifests) {
    const lock = locks.get(packageId);
    if (lock === undefined) {
      errors.push(
        diagnostic("FD1602", `Tool ${packageId} is absent from the package lock`, "packages.lock.json"),
      );
      continue;
    }
    if (lock.version !== manifest_.version || lock.manifestHash !== semanticHash(manifest_)) {
      errors.push(
        diagnostic(
          "FD1602",
          `Tool ${packageId} manifest does not match its package lock`,
          "packages.lock.json",
        ),
      );
    }
  }

  const expectedFiles = [
    "build.json",
    manifest.artifacts.worldIr,
    manifest.artifacts.packageLock,
    ...(manifest.artifacts.setup === undefined ? [] : [manifest.artifacts.setup]),
    ...packageLock.packages.map((entry) => entry.artifactPath),
  ].sort();
  const actualFiles = filesUnder(root);
  if (
    expectedFiles.length !== actualFiles.length ||
    !expectedFiles.every((file, index) => file === actualFiles[index])
  ) {
    errors.push(
      diagnostic(
        "FD1602",
        `immutable build artifact set differs from its lock (expected ${expectedFiles.join(", ")}; found ${actualFiles.join(", ")})`,
        "build.json",
      ),
    );
  }
  if (errors.length > 0) return { status: "failed", diagnostics: errors };

  const tools = [];
  for (const lock of packageLock.packages) {
    const manifest_ = manifests.get(lock.packageId);
    if (manifest_ === undefined) continue;
    const loaded = await loadTool({ buildRoot: root, manifest: manifest_, lock });
    if (loaded.status === "failed") errors.push(loaded.diagnostic);
    else tools.push(loaded.tool);
  }
  if (errors.length > 0) return { status: "failed", diagnostics: errors };
  return {
    status: "success",
    diagnostics: [],
    build: {
      manifest,
      worldIr,
      packageLock,
      ...(setup === undefined ? {} : { setup }),
      tools,
      directory: root,
    },
  };
}
