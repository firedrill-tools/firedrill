import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Diagnostic,
  InlineScenarioDefinition,
  RunScenarioOverlay,
  RunWorldSetup,
  ScenarioDefinition,
  ToolPackageManifest,
} from "@firedrill-run/contracts";
import {
  canonicalJson,
  compareStableStrings,
  FIREDRILL_ENGINE_VERSION,
  InlineScenarioDefinitionSchema,
  mergeToolOverrides,
  RunWorldSetupSchema,
  SourcePathSchema,
  StableIdSchema,
  TargetDescriptorSchema,
} from "@firedrill-run/contracts";
import type { BuildProvenanceEntry, CanonicalWorldIr, ResolvedRunSetup } from "@firedrill-run/world-ir";
import {
  BuildIdentitySchema,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  ResolvedRunSetupSchema,
  semanticHash,
} from "@firedrill-run/world-ir";
import { satisfies, validRange } from "semver";
import type { z } from "zod";
import { bundleTool } from "./bundle-tool.js";
import { bundleToolUi } from "./bundle-tool-ui.js";
import { diagnostic, schemaDiagnostics, sortDiagnostics } from "./diagnostics.js";
import {
  baselineFromWorld,
  normalizeDrill,
  normalizeManifest,
  normalizeSuite,
  resolveScenario,
} from "./normalize.js";
import { parseSource } from "./parse.js";
import {
  type DiscoveredSource,
  discoverSources,
  openRepository,
  type RepositoryContext,
  type ResolvedRepositoryPath,
  resolveRepositoryPath,
  resolveToolModule,
} from "./repository.js";
import {
  type DrillSource,
  DrillSourceSchema,
  ProjectConfigSchema,
  type ScenarioSource,
  ScenarioSourceSchema,
  type SuiteSource,
  SuiteSourceSchema,
  type TargetSource,
  TargetSourceSchema,
  type ToolSource,
  ToolSourceSchema,
  type WorldSource,
  WorldSourceSchema,
} from "./source-schemas.js";
import {
  type InstalledToolPackage,
  resolveInstalledToolModule,
  resolveInstalledToolPackage,
} from "./tool-package.js";
import type {
  BundledTool,
  CompileWorldOptions,
  CompileWorldResult,
  ResourceKind,
  SourceDocument,
  SourceProvenance,
  ToolSourceOrigin,
} from "./types.js";
import { validateWorldData, type WorldDataIssue } from "./validate-world-data.js";
import { authoredSourceVersionDiagnostic } from "./versioning.js";

export const FIREDRILL_COMPILER_VERSION = "0.1.0";

interface TypedResource<T> {
  readonly document: SourceDocument;
  readonly value: T;
}

type DeclaredToolResource = TypedResource<ToolSource> &
  (
    | {
        readonly origin: Extract<ToolSourceOrigin, { readonly kind: "repository" }>;
        readonly behaviorRoot: string;
        readonly installedPackage?: undefined;
      }
    | {
        readonly origin: Extract<ToolSourceOrigin, { readonly kind: "npm" }>;
        readonly behaviorRoot: string;
        readonly installedPackage: InstalledToolPackage;
      }
  );

type ToolResource = DeclaredToolResource & {
  readonly manifest: ToolPackageManifest;
  readonly bundle: BundledTool;
};

function parseTyped<T>(
  path: ResolvedRepositoryPath | DiscoveredSource,
  schema: z.ZodType<T>,
):
  | { readonly status: "success"; readonly resource: TypedResource<T> }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const parsed = parseSource(path.absolutePath, path.repositoryPath);
  if (parsed.status === "failed") return parsed;
  const versionDiagnostic = authoredSourceVersionDiagnostic(parsed.document);
  if (versionDiagnostic !== undefined) {
    return { status: "failed", diagnostics: [versionDiagnostic] };
  }
  const validated = schema.safeParse(parsed.document.value);
  if (!validated.success) {
    return { status: "failed", diagnostics: schemaDiagnostics(parsed.document, validated.error.issues) };
  }
  return { status: "success", resource: { document: parsed.document, value: validated.data } };
}

function sameIdentity(left: SourceProvenance, right: SourceProvenance): boolean {
  return left.id === right.id;
}

function resourceProvenance(
  kind: ResourceKind,
  id: string,
  document: SourceDocument,
  semanticValue: unknown,
  origin: ToolSourceOrigin = { kind: "repository" },
): SourceProvenance {
  return {
    kind,
    id,
    sourcePath: document.repositoryPath,
    contentHash: semanticHash(semanticValue),
    origin,
  };
}

function normalizeRunSetup(input: RunWorldSetup): RunWorldSetup {
  const scenario = input.scenario;
  return RunWorldSetupSchema.parse({
    ...(scenario === undefined
      ? {}
      : {
          scenario: {
            ...(scenario.virtualTimeUs === undefined ? {} : { virtualTimeUs: scenario.virtualTimeUs }),
            actors: scenario.actors
              .map((actor) => ({
                ...actor,
                grants: [...actor.grants].sort((left, right) =>
                  compareStableStrings(
                    `${left.packageId}\u0000${left.operationId}`,
                    `${right.packageId}\u0000${right.operationId}`,
                  ),
                ),
              }))
              .sort((left, right) => compareStableStrings(left.id, right.id)),
            state: scenario.state,
            faults: [...scenario.faults].sort((left, right) =>
              compareStableStrings(
                `${left.packageId}\u0000${left.faultId}`,
                `${right.packageId}\u0000${right.faultId}`,
              ),
            ),
            initialEvents: scenario.initialEvents,
            ...(scenario.toolOverrides === undefined ? {} : { toolOverrides: scenario.toolOverrides }),
          },
        }),
    tools: {
      packages: [...input.tools.packages].sort(compareStableStrings),
      behaviorOverrides: [...input.tools.behaviorOverrides].sort((left, right) =>
        compareStableStrings(left.packageId, right.packageId),
      ),
    },
    bindings: {
      environment: Object.fromEntries(
        Object.entries(input.bindings.environment).sort(([left], [right]) =>
          compareStableStrings(left, right),
        ),
      ),
    },
  });
}

function resolvedRunSetup(
  options: CompileWorldOptions["runSetup"],
):
  | { readonly status: "success"; readonly setup?: ResolvedRunSetup }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  if (options === undefined) return { status: "success" };
  const drillId = StableIdSchema.safeParse(options.drillId);
  const setup = RunWorldSetupSchema.safeParse(options.setup);
  if (!drillId.success || !setup.success) {
    const messages = [
      ...(drillId.success ? [] : drillId.error.issues.map((issue) => `drillId: ${issue.message}`)),
      ...(setup.success
        ? []
        : setup.error.issues.map(
            (issue) =>
              `${issue.path.length === 0 ? "setup" : `setup.${issue.path.join(".")}`}: ${issue.message}`,
          )),
    ];
    return {
      status: "failed",
      diagnostics: messages.map((message) =>
        diagnostic({
          code: "FD1202",
          message: `invalid run setup: ${message}`,
          suggestion: "Use a serializable scenario, Tool selection, and binding projection.",
        }),
      ),
    };
  }
  const normalized = normalizeRunSetup(setup.data);
  const identity = { schemaVersion: 1 as const, drillId: drillId.data, setup: normalized };
  return {
    status: "success",
    setup: ResolvedRunSetupSchema.parse({ ...identity, setupHash: semanticHash(identity) }),
  };
}

function applyRunScenarioOverlay(
  base: InlineScenarioDefinition,
  overlay: RunScenarioOverlay,
  drillId: string,
): InlineScenarioDefinition {
  const activatedFaults = new Set(overlay.faults.map((fault) => `${fault.packageId}\u0000${fault.faultId}`));
  const resolved = resolveScenario(
    {
      ...base,
      faults: base.faults.filter((fault) => !activatedFaults.has(`${fault.packageId}\u0000${fault.faultId}`)),
    },
    {
      schemaVersion: 1,
      id: "run-setup",
      ...(overlay.virtualTimeUs === undefined ? {} : { virtualTimeUs: overlay.virtualTimeUs }),
      actors: overlay.actors,
      state: overlay.state,
      faults: overlay.faults,
      initialEvents: overlay.initialEvents,
      ...(overlay.toolOverrides === undefined ? {} : { toolOverrides: overlay.toolOverrides }),
    },
    { kind: "run", drillId },
  );
  return InlineScenarioDefinitionSchema.parse({
    virtualTimeUs: resolved.virtualTimeUs,
    actors: resolved.actors,
    state: resolved.state,
    faults: resolved.faults,
    initialEvents: resolved.initialEvents,
    ...(resolved.toolOverrides === undefined ? {} : { toolOverrides: resolved.toolOverrides }),
  });
}

function addDuplicateDiagnostics(values: readonly SourceProvenance[], diagnostics: Diagnostic[]): void {
  for (const [index, current] of values.entries()) {
    const first = values.findIndex((candidate) => sameIdentity(candidate, current));
    if (first !== index) {
      diagnostics.push(
        diagnostic({
          code: "FD1201",
          message: `duplicate resource identity ${current.id}; first declared as ${values[first]?.kind} in ${values[first]?.sourcePath}`,
          span: {
            path: current.sourcePath,
            start: { line: 1, column: 1 },
            end: { line: 1, column: 2 },
          },
          suggestion: "Give every project resource a stable, unique in-file id.",
        }),
      );
    }
  }
}

function issueDocument(
  issuePath: readonly (string | number)[],
  fallback: SourceDocument,
  world: TypedResource<WorldSource>,
  tools: readonly ToolResource[],
  scenarios: readonly TypedResource<ScenarioSource>[],
  drills: readonly TypedResource<DrillSource>[],
  suites: readonly TypedResource<SuiteSource>[],
  targets: readonly TypedResource<TargetSource>[],
): { readonly document: SourceDocument; readonly localPath: readonly (string | number)[] } {
  const [group, index, ...rest] = issuePath;
  if (group === "baseline") return { document: world.document, localPath: issuePath.slice(1) };
  if (group === "tools" && typeof index === "number") {
    return {
      document: tools[index]?.document ?? fallback,
      localPath: ["manifest", ...rest] as (string | number)[],
    };
  }
  if (group === "scenarios" && typeof index === "number") {
    const source = scenarios[index];
    if (source === undefined) return { document: fallback, localPath: [] };
    try {
      const baseline = baselineFromWorld(world.value);
      const resolved = resolveScenario(baseline, source.value);
      const [field, itemIndex, ...tail] = rest;
      if (field === "state" && typeof itemIndex === "number") {
        return itemIndex < baseline.state.length
          ? { document: world.document, localPath: ["state", itemIndex, ...tail] }
          : {
              document: source.document,
              localPath: ["state", itemIndex - baseline.state.length, ...tail],
            };
      }
      if (field === "initialEvents" && typeof itemIndex === "number") {
        return itemIndex < baseline.initialEvents.length
          ? { document: world.document, localPath: ["initialEvents", itemIndex, ...tail] }
          : {
              document: source.document,
              localPath: ["initialEvents", itemIndex - baseline.initialEvents.length, ...tail],
            };
      }
      if (field === "actors" && typeof itemIndex === "number") {
        const actor = resolved.actors[itemIndex];
        if (actor !== undefined) {
          const overlayIndex = source.value.actors.findIndex((candidate) => candidate.id === actor.id);
          const owner = overlayIndex >= 0 ? source : world;
          const ownerIndex =
            overlayIndex >= 0
              ? overlayIndex
              : world.value.actors.findIndex((candidate) => candidate.id === actor.id);
          if (ownerIndex >= 0) {
            const [nested, nestedIndex, ...nestedTail] = tail;
            if (nested === "grants" && typeof nestedIndex === "number") {
              const grant = actor.grants[nestedIndex];
              const authoredActor = owner.value.actors[ownerIndex];
              const grantIndex = authoredActor?.grants.findIndex(
                (candidate) =>
                  candidate.packageId === grant?.packageId && candidate.operationId === grant?.operationId,
              );
              if (grantIndex !== undefined && grantIndex >= 0) {
                return {
                  document: owner.document,
                  localPath: ["actors", ownerIndex, "grants", grantIndex, ...nestedTail],
                };
              }
            }
            return { document: owner.document, localPath: ["actors", ownerIndex, ...tail] };
          }
        }
      }
      if (field === "faults" && typeof itemIndex === "number") {
        const fault = resolved.faults[itemIndex];
        if (fault !== undefined) {
          const overlayIndex = source.value.faults.findIndex(
            (candidate) => candidate.packageId === fault.packageId && candidate.faultId === fault.faultId,
          );
          if (overlayIndex >= 0) {
            return { document: source.document, localPath: ["faults", overlayIndex, ...tail] };
          }
          const baselineIndex = world.value.faults.findIndex(
            (candidate) => candidate.packageId === fault.packageId && candidate.faultId === fault.faultId,
          );
          if (baselineIndex >= 0) {
            return { document: world.document, localPath: ["faults", baselineIndex, ...tail] };
          }
        }
      }
      if (field === "toolOverrides" && typeof itemIndex === "number") {
        const rule = resolved.toolOverrides?.[itemIndex];
        if (rule !== undefined) {
          const owner = rule.scope.kind === "baseline" ? world : source;
          const ownerIndex = owner.value.toolOverrides?.findIndex((candidate) => candidate.id === rule.id);
          if (ownerIndex !== undefined && ownerIndex >= 0) {
            return { document: owner.document, localPath: ["toolOverrides", ownerIndex, ...tail] };
          }
        }
      }
    } catch {
      // Resolution diagnostics may be emitted while the scenario is incomplete.
      // The authored document is still the safest available anchor.
    }
    return { document: source.document, localPath: rest as (string | number)[] };
  }
  if (group === "drills" && typeof index === "number") {
    return { document: drills[index]?.document ?? fallback, localPath: rest as (string | number)[] };
  }
  if (group === "suites" && typeof index === "number") {
    return { document: suites[index]?.document ?? fallback, localPath: rest as (string | number)[] };
  }
  if (group === "targets" && typeof index === "number") {
    return {
      document: targets[index]?.document ?? fallback,
      localPath: ["target", ...rest] as (string | number)[],
    };
  }
  return { document: fallback, localPath: [] };
}

function semanticDiagnostics(
  issues: readonly (z.core.$ZodIssue | WorldDataIssue)[],
  config: SourceDocument,
  world: TypedResource<WorldSource>,
  tools: readonly ToolResource[],
  scenarios: readonly TypedResource<ScenarioSource>[],
  drills: readonly TypedResource<DrillSource>[],
  suites: readonly TypedResource<SuiteSource>[],
  targets: readonly TypedResource<TargetSource>[],
): Diagnostic[] {
  const baselineMessages = new Set(
    issues.filter((issue) => issue.path[0] === "baseline").map((issue) => issue.message),
  );
  return issues.flatMap((issue) => {
    const path = issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
    if (path[0] === "scenarios" && baselineMessages.has(issue.message)) return [];
    const mapped = issueDocument(path, config, world, tools, scenarios, drills, suites, targets);
    return [
      diagnostic({
        code: "FD1202",
        message: issue.message,
        span: mapped.document.spanAt(mapped.localPath),
        path,
        suggestion: "Correct the referenced Tool surface or resource id and compile again.",
      }),
    ];
  });
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function buildOutputRoot(
  repository: RepositoryContext,
  requested: string,
):
  | { readonly status: "success"; readonly path: string }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const valid = SourcePathSchema.safeParse(requested);
  if (!valid.success || requested === ".") {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1501",
          message: "build root must be a non-root repository-relative POSIX path",
          suggestion: "Use .firedrill/builds or another directory inside the repository.",
        }),
      ],
    };
  }
  const absolute = resolve(repository.root, requested);
  if (!contained(repository.root, absolute)) {
    return {
      status: "failed",
      diagnostics: [diagnostic({ code: "FD1501", message: "build root escapes the repository" })],
    };
  }
  const ancestor = nearestExisting(absolute);
  if (!contained(repository.rootRealPath, realpathSync(ancestor))) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1501",
          message: "build root resolves through a symlink outside the repository",
        }),
      ],
    };
  }
  return { status: "success", path: absolute };
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

function materializeBuild(input: {
  readonly repository: RepositoryContext;
  readonly buildRoot: string;
  readonly buildHash: string;
  readonly manifest: unknown;
  readonly worldIr: unknown;
  readonly packageLock: unknown;
  readonly setup?: unknown;
  readonly tools: readonly BundledTool[];
}):
  | { readonly status: "success"; readonly buildDirectory: string }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const outputRoot = buildOutputRoot(input.repository, input.buildRoot);
  if (outputRoot.status === "failed") return outputRoot;
  mkdirSync(outputRoot.path, { recursive: true });
  if (!contained(input.repository.rootRealPath, realpathSync(outputRoot.path))) {
    return {
      status: "failed",
      diagnostics: [diagnostic({ code: "FD1501", message: "created build root escaped the repository" })],
    };
  }

  const expected = new Map<string, Uint8Array>();
  const encode = (value: unknown) => Buffer.from(`${canonicalJson(value as never)}\n`);
  expected.set("build.json", encode(input.manifest));
  expected.set("world.ir.json", encode(input.worldIr));
  expected.set("packages.lock.json", encode(input.packageLock));
  if (input.setup !== undefined) expected.set("run-setup.json", encode(input.setup));
  for (const tool of input.tools) {
    expected.set(tool.lock.artifactPath, tool.bytes);
    for (const asset of tool.ui?.assets ?? []) expected.set(asset.artifactPath, asset.bytes);
  }

  const buildDirectory = join(outputRoot.path, input.buildHash.replace("sha256:", ""));
  if (existsSync(buildDirectory)) {
    const actualFiles = filesUnder(buildDirectory);
    const expectedFiles = [...expected.keys()].sort();
    const sameFiles =
      actualFiles.length === expectedFiles.length &&
      actualFiles.every((file, index) => file === expectedFiles[index]);
    const sameBytes =
      sameFiles &&
      expectedFiles.every((file) =>
        Buffer.from(readFileSync(join(buildDirectory, file))).equals(Buffer.from(expected.get(file) ?? [])),
      );
    if (!sameBytes) {
      return {
        status: "failed",
        diagnostics: [
          diagnostic({
            code: "FD1501",
            message: `immutable build directory is present with different contents: ${relative(
              input.repository.root,
              buildDirectory,
            )}`,
            suggestion: "Do not edit build artifacts; remove the corrupted build deliberately and rebuild.",
          }),
        ],
      };
    }
    return { status: "success", buildDirectory };
  }

  const stage = mkdtempSync(join(outputRoot.path, ".stage-"));
  try {
    for (const [file, bytes] of expected) {
      const absolutePath = join(stage, ...file.split("/"));
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, bytes, { flag: "wx" });
    }
    renameSync(stage, buildDirectory);
    return { status: "success", buildDirectory };
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1501",
          message: `cannot materialize immutable build: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ],
    };
  } finally {
    if (existsSync(stage) && statSync(stage).isDirectory() && dirname(stage) === outputRoot.path) {
      rmSync(stage, { force: true, recursive: true });
    }
  }
}

export async function compileWorld(options: CompileWorldOptions): Promise<CompileWorldResult> {
  const diagnostics: Diagnostic[] = [];
  const setupResult = resolvedRunSetup(options.runSetup);
  if (setupResult.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(setupResult.diagnostics) };
  }
  const runSetup = setupResult.setup;
  const opened = openRepository(options.repositoryRoot);
  if (opened.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(opened.diagnostics) };
  }
  const repository = opened.repository;
  const configPath = resolveRepositoryPath(
    repository,
    repository.root,
    "firedrill.json",
    "project manifest",
    "Add firedrill.json at the repository root. Run firedrill init --help, or start with https://docs.firedrill.run/quickstart.",
  );
  if (configPath.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(configPath.diagnostics) };
  }
  const config = parseTyped(configPath.path, ProjectConfigSchema);
  if (config.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(config.diagnostics) };
  }
  const sourceRoot = resolveRepositoryPath(
    repository,
    repository.root,
    config.resource.value.sourceRoot,
    "source root",
  );
  if (sourceRoot.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(sourceRoot.diagnostics) };
  }
  const worldPath = resolveRepositoryPath(
    repository,
    sourceRoot.path.absolutePath,
    config.resource.value.world,
    "world source",
  );
  if (worldPath.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(worldPath.diagnostics) };
  }
  const world = parseTyped(worldPath.path, WorldSourceSchema);
  if (world.status === "failed") {
    return { status: "failed", diagnostics: sortDiagnostics(world.diagnostics) };
  }

  const discovered = discoverSources(repository, sourceRoot.path);
  diagnostics.push(...discovered.diagnostics);
  const toolSources: DeclaredToolResource[] = [];
  const scenarioSources: TypedResource<ScenarioSource>[] = [];
  const drillSources: TypedResource<DrillSource>[] = [];
  const suiteSources: TypedResource<SuiteSource>[] = [];
  const targetSources: TypedResource<TargetSource>[] = [];
  for (const source of discovered.sources) {
    const parsed =
      source.kind === "tool"
        ? parseTyped(source, ToolSourceSchema)
        : source.kind === "scenario"
          ? parseTyped(source, ScenarioSourceSchema)
          : source.kind === "drill"
            ? parseTyped(source, DrillSourceSchema)
            : source.kind === "suite"
              ? parseTyped(source, SuiteSourceSchema)
              : parseTyped(source, TargetSourceSchema);
    if (parsed.status === "failed") {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (source.kind === "tool") {
      toolSources.push({
        ...(parsed.resource as TypedResource<ToolSource>),
        origin: { kind: "repository" },
        behaviorRoot: realpathSync(sourceRoot.path.absolutePath),
      });
    } else if (source.kind === "scenario") {
      scenarioSources.push(parsed.resource as TypedResource<ScenarioSource>);
    } else if (source.kind === "drill") {
      drillSources.push(parsed.resource as TypedResource<DrillSource>);
    } else if (source.kind === "suite") {
      suiteSources.push(parsed.resource as TypedResource<SuiteSource>);
    } else targetSources.push(parsed.resource as TypedResource<TargetSource>);
  }
  const selectedToolPackages = [
    ...config.resource.value.toolPackages.map((packageName, index) => ({
      packageName,
      span: config.resource.document.spanAt(["toolPackages", index]),
    })),
    ...(runSetup?.setup.tools.packages.map((packageName) => ({ packageName, span: undefined })) ?? []),
  ];
  const duplicateSelectedPackage = selectedToolPackages.find(
    (item, index) =>
      selectedToolPackages.findIndex((candidate) => candidate.packageName === item.packageName) !== index,
  );
  if (duplicateSelectedPackage !== undefined) {
    diagnostics.push(
      diagnostic({
        code: "FD1402",
        message: `Tool package ${duplicateSelectedPackage.packageName} is selected more than once`,
        ...(duplicateSelectedPackage.span === undefined ? {} : { span: duplicateSelectedPackage.span }),
        suggestion:
          "Select each installed Tool package either in firedrill.json or in the run setup, not both.",
      }),
    );
  }
  for (const { packageName, span } of selectedToolPackages) {
    const resolvedPackage = resolveInstalledToolPackage(repository.root, packageName, span);
    if (resolvedPackage.status === "failed") {
      diagnostics.push(...resolvedPackage.diagnostics);
      continue;
    }
    if (resolvedPackage.package.lifecycle === "revoked") {
      diagnostics.push(
        diagnostic({
          code: "FD1403",
          message: `Tool package ${packageName}@${resolvedPackage.package.version} is revoked`,
          severity: "error",
          ...(span === undefined ? {} : { span }),
          suggestion: `Remove ${packageName} or install a non-revoked version. Firedrill will not execute this installed artifact.`,
        }),
      );
      continue;
    }
    if (resolvedPackage.package.lifecycle === "deprecated") {
      diagnostics.push(
        diagnostic({
          code: "FD1403",
          message: `Tool package ${packageName}@${resolvedPackage.package.version} is deprecated`,
          severity: "warning",
          ...(span === undefined ? {} : { span }),
          suggestion: `Plan an upgrade or replacement for ${packageName}; this installed version remains runnable.`,
        }),
      );
    }
    const parsed = parseTyped(resolvedPackage.package.declaration, ToolSourceSchema);
    if (parsed.status === "failed") {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    toolSources.push({
      ...parsed.resource,
      origin: {
        kind: "npm",
        packageName: resolvedPackage.package.name,
        packageVersion: resolvedPackage.package.version,
      },
      behaviorRoot: resolvedPackage.package.root,
      installedPackage: resolvedPackage.package,
    });
  }
  if (diagnostics.some((item) => item.severity === "error")) {
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }

  const behaviorOverrides = new Map(
    (runSetup?.setup.tools.behaviorOverrides ?? []).map((override) => [override.packageId, override]),
  );
  const appliedBehaviorOverrides = new Set<string>();
  const tools: ToolResource[] = [];
  for (const source of toolSources) {
    const manifest = normalizeManifest(source.value.manifest);
    if (source.origin.kind === "npm" && manifest.version !== source.origin.packageVersion) {
      diagnostics.push(
        diagnostic({
          code: "FD1402",
          message: `Tool ${manifest.id} declares version ${manifest.version}, but npm package ${source.origin.packageName} is ${source.origin.packageVersion}`,
          span: source.document.spanAt(["manifest", "version"]),
          path: ["manifest", "version"],
          suggestion:
            "Publish matching package and Tool manifest versions so the selected dependency is auditable.",
        }),
      );
      continue;
    }
    const range = validRange(manifest.engine);
    if (range === null || !satisfies(FIREDRILL_ENGINE_VERSION, range, { includePrerelease: true })) {
      diagnostics.push(
        diagnostic({
          code: "FD1401",
          message: `Tool ${manifest.id}@${manifest.version} requires engine ${manifest.engine}; compiler targets ${FIREDRILL_ENGINE_VERSION}`,
          span: source.document.spanAt(["manifest", "engine"]),
          path: ["manifest", "engine"],
          suggestion: "Change the Tool engine range or use a compatible Firedrill release.",
        }),
      );
      continue;
    }
    const behaviorOverride = behaviorOverrides.get(manifest.id);
    const module =
      behaviorOverride !== undefined
        ? resolveRepositoryPath(
            repository,
            repository.root,
            behaviorOverride.module,
            `Tool ${manifest.id} behavior override`,
          )
        : source.installedPackage === undefined
          ? resolveToolModule(repository, source.document.absolutePath, source.value.module)
          : resolveInstalledToolModule(source.installedPackage, source.value.module);
    if (module.status === "failed") {
      diagnostics.push(...module.diagnostics);
      continue;
    }
    if (behaviorOverride !== undefined) appliedBehaviorOverrides.add(manifest.id);
    const bundled = await bundleTool({
      provenanceRoot:
        behaviorOverride === undefined ? (source.installedPackage?.root ?? repository.root) : repository.root,
      ...(behaviorOverride === undefined && source.origin.kind === "npm"
        ? { provenancePrefix: `npm/${source.origin.packageName}` }
        : {}),
      sourceRoot: behaviorOverride === undefined ? source.behaviorRoot : repository.rootRealPath,
      modulePath: module.path.absolutePath,
      repositoryModulePath: module.path.repositoryPath,
      exportName: behaviorOverride?.exportName ?? source.value.exportName,
      manifest,
      source:
        behaviorOverride === undefined
          ? source.origin
          : {
              kind: "repository_override",
              module: module.path.repositoryPath,
              base: source.origin,
            },
    });
    if (bundled.status === "failed") {
      diagnostics.push(...bundled.diagnostics);
      continue;
    }
    const ui =
      source.value.ui === undefined
        ? undefined
        : bundleToolUi({
            packageId: manifest.id,
            declarationPath: source.document.absolutePath,
            declarationLabel: source.document.repositoryPath,
            sourceRoot: source.behaviorRoot,
            provenanceRoot: source.installedPackage?.root ?? repository.root,
            ...(source.origin.kind === "npm" ? { provenancePrefix: `npm/${source.origin.packageName}` } : {}),
            ui: source.value.ui,
          });
    if (ui?.status === "failed") {
      diagnostics.push(...ui.diagnostics);
      continue;
    }
    tools.push({
      ...source,
      manifest,
      bundle:
        ui === undefined
          ? bundled.tool
          : {
              ...bundled.tool,
              lock: { ...bundled.tool.lock, ui: ui.ui.lock },
              ui: { assets: ui.ui.assets, sourcePaths: ui.ui.sourcePaths },
            },
    });
  }
  for (const packageId of behaviorOverrides.keys()) {
    if (appliedBehaviorOverrides.has(packageId)) continue;
    diagnostics.push(
      diagnostic({
        code: "FD1402",
        message: `Tool behavior override references unknown package ${packageId}`,
        suggestion:
          "Declare the Tool in the repository or select its installed package before overriding it.",
      }),
    );
  }
  if (diagnostics.some((item) => item.severity === "error")) {
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }

  let baseline: InlineScenarioDefinition;
  try {
    baseline = baselineFromWorld(world.resource.value);
  } catch (error) {
    if (error instanceof Error && "issues" in error && Array.isArray(error.issues)) {
      const issues = (error.issues as z.core.$ZodIssue[]).map((issue) => ({
        ...issue,
        path: ["baseline", ...issue.path],
      }));
      diagnostics.push(
        ...semanticDiagnostics(
          issues,
          config.resource.document,
          world.resource,
          tools,
          scenarioSources,
          drillSources,
          suiteSources,
          targetSources,
        ),
      );
    } else {
      diagnostics.push(
        diagnostic({ code: "FD1202", message: error instanceof Error ? error.message : String(error) }),
      );
    }
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }
  const scenarios: ScenarioDefinition[] = [];
  for (const [index, source] of scenarioSources.entries()) {
    try {
      scenarios.push(resolveScenario(baseline, source.value));
    } catch (error) {
      if (error instanceof Error && "issues" in error && Array.isArray(error.issues)) {
        const issues = (error.issues as z.core.$ZodIssue[]).map((issue) => ({
          ...issue,
          path: ["scenarios", index, ...issue.path],
        }));
        diagnostics.push(
          ...semanticDiagnostics(
            issues,
            config.resource.document,
            world.resource,
            tools,
            scenarioSources,
            drillSources,
            suiteSources,
            targetSources,
          ),
        );
      } else {
        diagnostics.push(
          diagnostic({ code: "FD1202", message: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }
  if (diagnostics.some((item) => item.severity === "error")) {
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }

  const sortedTools = tools.sort((left, right) => compareStableStrings(left.manifest.id, right.manifest.id));
  const sortedScenarios = scenarioSources
    .map((source, index) => ({ source, resolved: scenarios[index] }))
    .sort((left, right) => compareStableStrings(left.resolved?.id ?? "", right.resolved?.id ?? ""));
  const sortedDrills = drillSources
    .map((source) => ({ source, resolved: normalizeDrill(source.value) }))
    .sort((left, right) => compareStableStrings(left.resolved.id, right.resolved.id));
  const sortedSuites = suiteSources
    .map((source) => ({ source, resolved: normalizeSuite(source.value) }))
    .sort((left, right) => compareStableStrings(left.resolved.id, right.resolved.id));
  const sortedTargets = targetSources
    .map((source) => ({ source, resolved: source.value.target }))
    .sort((left, right) => compareStableStrings(left.resolved.id, right.resolved.id));

  let resolvedDrills = sortedDrills.map((item) => item.resolved);
  let resolvedTargets = sortedTargets.map((item) => item.resolved);
  if (runSetup !== undefined) {
    const selectedDrill = resolvedDrills.find((drill) => drill.id === runSetup.drillId);
    if (selectedDrill === undefined) {
      diagnostics.push(
        diagnostic({
          code: "FD1202",
          message: `run setup references unknown drill ${runSetup.drillId}`,
          suggestion: "Select an existing repository drill before applying test-local setup.",
        }),
      );
      return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
    }
    if (runSetup.setup.scenario !== undefined) {
      const baseScenario =
        selectedDrill.inlineScenario ??
        sortedScenarios.find((item) => item.resolved?.id === selectedDrill.scenarioId)?.resolved;
      if (baseScenario === undefined) {
        diagnostics.push(
          diagnostic({
            code: "FD1202",
            message: `run setup cannot resolve the scenario for drill ${runSetup.drillId}`,
            suggestion: "Correct the drill's repository scenario before applying test-local setup.",
          }),
        );
        return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
      }
      const {
        scenarioId: _scenarioId,
        inlineScenario: _inlineScenario,
        toolOverrides: _toolOverrides,
        ...drillWithoutScenario
      } = selectedDrill;
      const derivedDrill = {
        ...drillWithoutScenario,
        inlineScenario: applyRunScenarioOverlay(
          {
            ...baseScenario,
            ...(baseScenario.toolOverrides === undefined && selectedDrill.toolOverrides === undefined
              ? {}
              : {
                  toolOverrides: mergeToolOverrides(baseScenario.toolOverrides, selectedDrill.toolOverrides),
                }),
          },
          runSetup.setup.scenario,
          selectedDrill.id,
        ),
      };
      resolvedDrills = resolvedDrills.map((drill) => (drill.id === selectedDrill.id ? derivedDrill : drill));
    }
    if (Object.keys(runSetup.setup.bindings.environment).length > 0) {
      const target = resolvedTargets.find((candidate) => candidate.id === selectedDrill.targetId);
      if (target === undefined) {
        diagnostics.push(
          diagnostic({
            code: "FD1202",
            message: `run setup cannot resolve target ${selectedDrill.targetId}`,
            suggestion: "Correct the drill target before applying a binding projection.",
          }),
        );
        return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
      }
      const projected = TargetDescriptorSchema.safeParse({
        ...target,
        bindingEnvironment: {
          ...(target.bindingEnvironment ?? {}),
          ...runSetup.setup.bindings.environment,
        },
      });
      if (!projected.success) {
        diagnostics.push(
          ...projected.error.issues.map((issue) => {
            const issuePath = issue.path.map((segment) =>
              typeof segment === "symbol" ? String(segment) : segment,
            );
            return diagnostic({
              code: "FD1202",
              message: `invalid binding projection for target ${target.id}: ${issue.message}`,
              path: ["setup", "bindings", "environment", ...issuePath],
              suggestion:
                "Map each agent variable to a canonical FIREDRILL_* value provided by a binding declared on the target.",
            });
          }),
        );
        return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
      }
      resolvedTargets = resolvedTargets.map((candidate) =>
        candidate.id === target.id ? projected.data : candidate,
      );
    }
  }

  const provisionalIr = {
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    world: {
      id: world.resource.value.id,
      ...(world.resource.value.title === undefined ? {} : { title: world.resource.value.title }),
      seed: world.resource.value.seed,
    },
    tools: sortedTools.map((tool) => tool.manifest),
    baseline,
    scenarios: sortedScenarios.flatMap((item) => (item.resolved === undefined ? [] : [item.resolved])),
    drills: resolvedDrills,
    suites: sortedSuites.map((item) => item.resolved),
    targets: resolvedTargets,
  };
  const parsedIr = CanonicalWorldIrSchema.safeParse(provisionalIr);
  if (!parsedIr.success) {
    diagnostics.push(
      ...semanticDiagnostics(
        parsedIr.error.issues,
        config.resource.document,
        world.resource,
        sortedTools,
        sortedScenarios.map((item) => item.source),
        sortedDrills.map((item) => item.source),
        sortedSuites.map((item) => item.source),
        sortedTargets.map((item) => item.source),
      ),
    );
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }
  const worldIr: CanonicalWorldIr = parsedIr.data;
  const worldDataIssues = validateWorldData(worldIr);
  if (worldDataIssues.length > 0) {
    diagnostics.push(
      ...semanticDiagnostics(
        worldDataIssues,
        config.resource.document,
        world.resource,
        sortedTools,
        sortedScenarios.map((item) => item.source),
        sortedDrills.map((item) => item.source),
        sortedSuites.map((item) => item.source),
        sortedTargets.map((item) => item.source),
      ).map((item) => ({ ...item, code: "FD1203" })),
    );
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }

  const sourceProvenance: SourceProvenance[] = [
    resourceProvenance("world", worldIr.world.id, world.resource.document, {
      schemaVersion: world.resource.value.schemaVersion,
      world: worldIr.world,
      baseline: worldIr.baseline,
    }),
    ...sortedTools.map((tool) =>
      resourceProvenance(
        "tool",
        tool.manifest.id,
        tool.document,
        {
          schemaVersion: tool.value.schemaVersion,
          manifest: tool.manifest,
          artifactHash: tool.bundle.lock.artifactHash,
          exportName: tool.bundle.lock.exportName,
          ...(tool.bundle.lock.ui === undefined ? {} : { ui: tool.bundle.lock.ui }),
        },
        tool.bundle.lock.source,
      ),
    ),
    ...sortedScenarios.flatMap((item) =>
      item.resolved === undefined
        ? []
        : [resourceProvenance("scenario", item.resolved.id, item.source.document, item.resolved)],
    ),
    ...sortedDrills.map((item) =>
      resourceProvenance("drill", item.resolved.id, item.source.document, item.resolved),
    ),
    ...sortedSuites.map((item) =>
      resourceProvenance("suite", item.resolved.id, item.source.document, item.resolved),
    ),
    ...sortedTargets.map((item) =>
      resourceProvenance("target", item.resolved.id, item.source.document, item.resolved),
    ),
  ].sort((left, right) =>
    compareStableStrings(`${left.kind}\u0000${left.id}`, `${right.kind}\u0000${right.id}`),
  );
  addDuplicateDiagnostics(sourceProvenance, diagnostics);
  if (diagnostics.some((item) => item.severity === "error")) {
    return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  }

  const packageLock = PackageLockSchema.parse({
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    packages: sortedTools.map((tool) => tool.bundle.lock),
  });
  const buildProvenance: BuildProvenanceEntry[] = [
    ...sourceProvenance.map(({ kind, id, contentHash }) => ({ kind, id, contentHash })),
    ...(runSetup === undefined
      ? []
      : [{ kind: "setup" as const, id: runSetup.drillId, contentHash: runSetup.setupHash }]),
  ].sort((left, right) =>
    compareStableStrings(`${left.kind}\u0000${left.id}`, `${right.kind}\u0000${right.id}`),
  );
  const irHash = semanticHash(worldIr);
  const packageLockHash = semanticHash(packageLock);
  const sourceDigest = semanticHash(buildProvenance);
  const identity = BuildIdentitySchema.parse({
    schemaVersion: 1,
    worldIrSchemaVersion: 1,
    packageLockSchemaVersion: 1,
    compilerVersion: FIREDRILL_COMPILER_VERSION,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    irHash,
    packageLockHash,
    sourceDigest,
  });
  const manifest = BuildManifestSchema.parse({
    ...identity,
    buildHash: semanticHash(identity),
    worldId: worldIr.world.id,
    artifacts: {
      worldIr: "world.ir.json",
      packageLock: "packages.lock.json",
      ...(runSetup === undefined ? {} : { setup: "run-setup.json" }),
    },
    provenance: buildProvenance,
    diagnostics: {
      errors: diagnostics.filter((item) => item.severity === "error").length,
      warnings: diagnostics.filter((item) => item.severity === "warning").length,
      info: diagnostics.filter((item) => item.severity === "info").length,
    },
  });

  let buildDirectory: string | undefined;
  if (options.materialize ?? true) {
    const materialized = materializeBuild({
      repository,
      buildRoot: options.buildRoot ?? ".firedrill/builds",
      buildHash: manifest.buildHash,
      manifest,
      worldIr,
      packageLock,
      ...(runSetup === undefined ? {} : { setup: runSetup }),
      tools: sortedTools.map((tool) => tool.bundle),
    });
    if (materialized.status === "failed") {
      return {
        status: "failed",
        diagnostics: sortDiagnostics([...diagnostics, ...materialized.diagnostics]),
      };
    }
    buildDirectory = materialized.buildDirectory;
  }

  return {
    status: "success",
    diagnostics: sortDiagnostics(diagnostics),
    build: {
      manifest,
      worldIr,
      packageLock,
      ...(runSetup === undefined ? {} : { setup: runSetup }),
      sourceProvenance,
      toolSources: sortedTools.map((tool) => ({
        packageId: tool.manifest.id,
        declarationPath: tool.document.repositoryPath,
        entryPath: tool.bundle.entryPath,
        behaviorPaths: tool.bundle.sourcePaths,
        ...(tool.bundle.ui === undefined ? {} : { uiPaths: tool.bundle.ui.sourcePaths }),
        origin: tool.bundle.lock.source,
      })),
      ...(buildDirectory === undefined ? {} : { buildDirectory }),
    },
  };
}
