import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compileWorld, ProjectConfigSchema, ScenarioSourceSchema } from "@firedrill/compiler";
import { canonicalJson, compareStableStrings, PackageIdSchema, StableIdSchema } from "@firedrill/contracts";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import type { LocalWorld } from "./local-world.js";
import { FiredrillProjectError } from "./project-error.js";

export interface ExportLocalScenarioOptions {
  readonly id: string;
  readonly title?: string;
  /** Omit to capture all Tool packages. Unselected Tools inherit world baseline data. */
  readonly packages?: readonly string[];
}

export interface LocalScenarioExport {
  readonly schemaVersion: 1;
  readonly scope: "tool-state";
  readonly worldInstanceId: string;
  readonly buildHash: string;
  readonly generation: number;
  readonly sourceHash: string;
  readonly packages: readonly string[];
  readonly recordCount: number;
  readonly deletionCount: number;
  readonly scenario: ReturnType<typeof ScenarioSourceSchema.parse>;
  /** This is seed data, not a checkpoint: all other settings inherit the repository baseline. */
  readonly omitted: readonly string[];
}

export interface SaveLocalScenarioOptions extends ExportLocalScenarioOptions {
  /** Reject if state changed since an export preview. */
  readonly expectedSourceHash?: string;
  readonly expectedGeneration?: number;
}

export interface LocalScenarioSaveResult {
  readonly id: string;
  readonly path: string;
  readonly sourceHash: string;
  readonly recordCount: number;
  readonly deletionCount: number;
  readonly scope: "tool-state";
  readonly runtimeChanged: false;
}

const MAX_RECORDS = 50_000;
// Generated source must fit the compiler's per-file limit, including formatting.
const MAX_BYTES = 1_048_576;
const OMITTED = [
  "actors",
  "clock",
  "faults",
  "pending events",
  "callbacks",
  "history",
  "random position",
  "idempotency receipts",
] as const;

/** Synchronous capture cannot interleave with an in-process world operation or reset. */
export function captureLocalScenario(
  world: LocalWorld,
  baseline: LoadedWorldBuild["worldIr"]["baseline"],
  options: ExportLocalScenarioOptions,
): LocalScenarioExport {
  const id = StableIdSchema.safeParse(options.id);
  if (
    !id.success ||
    (options.title !== undefined &&
      (typeof options.title !== "string" || options.title.trim().length === 0 || options.title.length > 200))
  )
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "provide a valid scenario id and an optional title of 1–200 characters",
    );
  const description = world.describe();
  const available = description.tools.map((tool) => tool.packageId);
  if (options.packages !== undefined && !Array.isArray(options.packages))
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "packages must be an array of Tool package ids",
    );
  const packages = options.packages === undefined ? available : [...new Set(options.packages)];
  if (
    packages.length === 0 ||
    packages.some((value) => !PackageIdSchema.safeParse(value).success || !available.includes(value))
  )
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "select at least one Tool package present in this environment",
    );
  packages.sort(compareStableStrings);
  const state: ReturnType<typeof ScenarioSourceSchema.parse>["state"] = [];
  const present = new Set<string>();
  const key = (record: { packageId: string; namespace: string; rowId: string }) =>
    JSON.stringify([record.packageId, record.namespace, record.rowId]);
  let recordCount = 0;
  let bytes = 0;
  const append = (record: (typeof state)[number]) => {
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (state.length >= MAX_RECORDS || bytes > MAX_BYTES)
      throw new FiredrillProjectError(
        "framework.SCENARIO_EXPORT_TOO_LARGE",
        "scenario capture exceeds 50,000 records or the 1 MiB source-file limit; export fewer Tool packages",
      );
    state.push(record);
  };
  for (const tool of description.tools) {
    if (!packages.includes(tool.packageId)) continue;
    for (const namespace of tool.stateNamespaces) {
      let afterRowId: string | undefined;
      for (;;) {
        const rows = world.state({
          packageId: tool.packageId,
          namespace,
          limit: 1_000,
          ...(afterRowId === undefined ? {} : { afterRowId }),
        });
        for (const row of rows) {
          present.add(key(row));
          append({
            action: "upsert",
            packageId: row.packageId,
            namespace: row.namespace,
            rowId: row.rowId,
            value: structuredClone(row.value),
          });
          recordCount += 1;
        }
        if (rows.length < 1_000) break;
        afterRowId = rows.at(-1)?.rowId;
      }
    }
  }
  const starting = new Map<string, (typeof baseline.state)[number]>();
  for (const row of baseline.state) {
    if (row.action === "delete") starting.delete(key(row));
    else starting.set(key(row), row);
  }
  let deletionCount = 0;
  for (const [rowKey, row] of starting) {
    if (!packages.includes(row.packageId) || present.has(rowKey)) continue;
    append({ action: "delete", packageId: row.packageId, namespace: row.namespace, rowId: row.rowId });
    deletionCount += 1;
  }
  state.sort((left, right) => compareStableStrings(key(left), key(right)));
  const scenario = ScenarioSourceSchema.parse({
    schemaVersion: 1,
    id: id.data,
    ...(options.title === undefined ? {} : { title: options.title }),
    state,
  });
  scenarioSourceText(scenario);
  return {
    schemaVersion: 1,
    scope: "tool-state",
    worldInstanceId: world.metadata().worldInstanceId,
    buildHash: description.buildHash,
    generation: description.generation,
    sourceHash: `sha256:${createHash("sha256").update(JSON.stringify(scenario)).digest("hex")}`,
    packages,
    recordCount,
    deletionCount,
    scenario,
    omitted: OMITTED,
  };
}

function scenarioSourceText(scenario: LocalScenarioExport["scenario"]): string {
  const text = `${JSON.stringify(scenario, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new FiredrillProjectError(
      "framework.SCENARIO_EXPORT_TOO_LARGE",
      "formatted scenario source exceeds the compiler's 1 MiB source-file limit; export fewer Tool packages",
    );
  return text;
}

function guardedDirectory(root: string, directory: string): void {
  const segments = relative(root, directory).split(/[\\/]/).filter(Boolean);
  if (isAbsolute(relative(root, directory)) || segments.includes(".."))
    throw new FiredrillProjectError(
      "framework.SOURCE_INVALID",
      "scenario destination must remain inside the repository",
    );
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new FiredrillProjectError(
          "framework.SOURCE_INVALID",
          "scenario destination must contain only real repository directories",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
}

/** Explicit source write; no overwrite, runtime mutation, executable imports, or credential/config edits. */
export async function persistLocalScenario(
  world: LocalWorld,
  build: LoadedWorldBuild,
  options: SaveLocalScenarioOptions,
): Promise<LocalScenarioSaveResult> {
  // Validate arguments before compiler work or filesystem creation.
  const initial = world.exportScenario(options);
  const compiled = await compileWorld({ repositoryRoot: world.repositoryRoot, materialize: false });
  if (compiled.status !== "success")
    throw new FiredrillProjectError(
      "framework.SOURCE_INVALID",
      "fix repository source before saving a scenario",
      { diagnostics: compiled.diagnostics },
    );
  // Saving a scenario must not prevent a second save. Reject changes to the
  // captured world's basis, but permit other scenario/drill additions.
  const basis = (value: Pick<LoadedWorldBuild, "worldIr" | "packageLock">) =>
    canonicalJson(
      JSON.parse(
        JSON.stringify({
          world: value.worldIr.world,
          baseline: value.worldIr.baseline,
          tools: value.worldIr.tools,
          packageLock: value.packageLock,
        }),
      ),
    );
  if (basis(compiled.build) !== basis(build))
    throw new FiredrillProjectError(
      "framework.BUILD_HASH_MISMATCH",
      "repository source changed since this environment started; restart it before saving a scenario",
    );
  if (compiled.build.worldIr.scenarios.some((scenario) => scenario.id === options.id))
    throw new FiredrillProjectError(
      "framework.SCENARIO_EXISTS",
      "a scenario with this id already exists; choose another id",
    );
  const captured = world.exportScenario(options);
  if (
    captured.generation !== (options.expectedGeneration ?? initial.generation) ||
    captured.sourceHash !== (options.expectedSourceHash ?? initial.sourceHash)
  )
    throw new FiredrillProjectError(
      "framework.SCENARIO_CAPTURE_CHANGED",
      "tool data changed after the preview; preview the scenario again before saving",
    );
  const sourceText = scenarioSourceText(captured.scenario);
  const root = realpathSync(world.repositoryRoot);
  const configPath = join(root, "firedrill.json");
  if (lstatSync(configPath).isSymbolicLink())
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "firedrill.json must not be a symbolic link");
  const config = ProjectConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const path = resolve(root, config.sourceRoot, "scenarios", `${captured.scenario.id}.scenario.json`);
  guardedDirectory(root, dirname(path));
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new FiredrillProjectError(
        "framework.SCENARIO_EXISTS",
        "the scenario destination already exists; choose another id",
      );
    throw error;
  }
  try {
    writeFileSync(descriptor, sourceText);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(descriptor);
  }
  return {
    id: captured.scenario.id,
    path: relative(root, path).split("\\").join("/"),
    sourceHash: captured.sourceHash,
    recordCount: captured.recordCount,
    deletionCount: captured.deletionCount,
    scope: "tool-state",
    runtimeChanged: false,
  };
}
