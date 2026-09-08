import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectInstalledToolPackage, ProjectConfigSchema, ToolSourceSchema } from "@firedrill/compiler";
import {
  NodePackageNameSchema,
  type OperationRef,
  PackageIdSchema,
  type ToolPackageManifest,
} from "@firedrill/contracts";

export interface ToolSetupResult {
  readonly schemaVersion: 1;
  readonly kind: "tool-created" | "tool-package-added";
  readonly repositoryRoot: string;
  readonly packageId: string;
  readonly packageIds?: readonly string[];
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly grants: readonly OperationRef[];
  readonly grantGuidance: readonly string[];
  readonly starterRows?: number;
}

export class FiredrillToolSetupError extends Error {
  readonly code:
    | "framework.TOOL_SETUP_CONFLICT"
    | "framework.TOOL_SETUP_INVALID_ARGUMENT"
    | "framework.TOOL_SETUP_INVALID_PROJECT"
    | "framework.TOOL_PACKAGE_INVALID"
    | "framework.TOOL_PACKAGE_NOT_INSTALLED";
  readonly paths: readonly string[];

  constructor(code: FiredrillToolSetupError["code"], message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "FiredrillToolSetupError";
    this.code = code;
    this.paths = paths;
  }
}

const MAX_METADATA_BYTES = 1_048_576;
const RUNTIME_IGNORE = ".firedrill/";
const IGNORE_PATTERNS = new Set([".firedrill", ".firedrill/", "/.firedrill", "/.firedrill/"]);

interface ExistingFile {
  readonly body: Buffer;
  readonly metadata: Stats;
}

interface PlannedFile {
  readonly path: string;
  readonly body: Buffer;
  readonly previous?: ExistingFile;
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function conflict(message: string, path: string): never {
  throw new FiredrillToolSetupError("framework.TOOL_SETUP_CONFLICT", message, [path]);
}

function metadata(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function projectRoot(input: string): string {
  const root = resolve(input);
  const info = metadata(root);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_INVALID_PROJECT",
      "Tool setup requires an existing repository directory, not a symlink.",
    );
  return realpathSync(root);
}

/** Refuse symbolic links at every path component below the selected repository. */
function guardedPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    conflict("Tool setup path escapes the repository.", path);
  const segments = local.split(sep);
  if (
    segments.some(
      (part) => [".git", ".firedrill", "node_modules"].includes(part) || /^\.env(?:\.|$)/.test(part),
    )
  )
    conflict("Tool setup cannot write into secrets, dependencies, or generated directories.", path);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = metadata(current);
    if (info?.isSymbolicLink()) conflict("Tool setup refuses symbolic-link paths.", path);
    if (info !== undefined && index < segments.length - 1 && !info.isDirectory())
      conflict("A parent of the Tool setup path is not a directory.", path);
  }
  return absolute;
}

function readExisting(root: string, path: string): ExistingFile | undefined {
  const absolute = guardedPath(root, path);
  if (metadata(absolute) === undefined) return undefined;
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES || info.nlink > 1)
      conflict("Tool setup requires a regular file of at most 1 MiB.", path);
    return { body: readFileSync(descriptor), metadata: info };
  } finally {
    closeSync(descriptor);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeBytes(descriptor: number, body: Buffer): void {
  let offset = 0;
  while (offset < body.length) offset += writeSync(descriptor, body, offset, body.length - offset, offset);
  ftruncateSync(descriptor, body.length);
}

interface OpenedFile {
  readonly file: PlannedFile;
  readonly descriptor: number;
  readonly metadata: Stats;
  expected: Buffer;
}

function writePlannedFile(item: OpenedFile): void {
  const body = item.file.body;
  let offset = 0;
  while (offset < body.length) {
    const written = writeSync(item.descriptor, body, offset, body.length - offset, offset);
    if (written === 0) throw new Error("A file write made no progress.");
    if (item.expected.length < offset + written) {
      const extended = Buffer.alloc(offset + written);
      item.expected.copy(extended);
      item.expected = extended;
    }
    body.copy(item.expected, offset, offset, offset + written);
    offset += written;
  }
  ftruncateSync(item.descriptor, body.length);
  item.expected = Buffer.from(body);
}

/** Preflight every destination before writing and roll back only files this attempt owns. */
function applyPlan(root: string, files: readonly PlannedFile[]) {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const pending: PlannedFile[] = [];
  for (const file of files) {
    const existing = readExisting(root, file.path);
    if (file.previous === undefined) {
      if (existing === undefined) pending.push(file);
      else if (existing.body.equals(file.body)) unchanged.push(file.path);
      else conflict("Tool setup refuses to overwrite an existing file; reconcile it first.", file.path);
    } else {
      if (
        existing === undefined ||
        !sameIdentity(existing.metadata, file.previous.metadata) ||
        !existing.body.equals(file.previous.body)
      )
        conflict("A file changed while Tool setup was planning; retry the command.", file.path);
      if (existing.body.equals(file.body)) unchanged.push(file.path);
      else pending.push(file);
    }
  }
  const ownedDirectories: string[] = [];
  const opened: OpenedFile[] = [];
  try {
    for (const file of pending) {
      const absolute = guardedPath(root, file.path);
      const directories: string[] = [];
      let directory = dirname(absolute);
      while (directory !== root && metadata(directory) === undefined) {
        directories.unshift(directory);
        directory = dirname(directory);
      }
      for (const path of directories) {
        guardedPath(root, relative(root, path));
        mkdirSync(path);
        ownedDirectories.push(path);
      }
      guardedPath(root, file.path);
      const descriptor = openSync(
        absolute,
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          (file.previous === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
        0o644,
      );
      const info = fstatSync(descriptor);
      if (file.previous !== undefined) {
        if (
          !sameIdentity(info, file.previous.metadata) ||
          !readFileSync(descriptor).equals(file.previous.body)
        ) {
          closeSync(descriptor);
          conflict("A file changed while Tool setup was writing; retry the command.", file.path);
        }
      }
      const item = { file, descriptor, metadata: info, expected: Buffer.from(file.previous?.body ?? []) };
      opened.push(item);
      writePlannedFile(item);
      (file.previous === undefined ? created : updated).push(file.path);
    }
  } catch (error) {
    for (const item of [...opened].reverse()) {
      try {
        const absolute = guardedPath(root, item.file.path);
        const current = readExisting(root, item.file.path);
        if (
          current === undefined ||
          !sameIdentity(current.metadata, item.metadata) ||
          !current.body.equals(item.expected)
        )
          continue;
        if (item.file.previous === undefined) unlinkSync(absolute);
        else writeBytes(item.descriptor, item.file.previous.body);
      } catch {
        // Never remove or replace a file now owned by another writer.
      }
    }
    for (const path of ownedDirectories.reverse()) {
      try {
        guardedPath(root, relative(root, path));
        rmdirSync(path);
      } catch {
        // A directory with another writer's files must remain intact.
      }
    }
    if (error instanceof FiredrillToolSetupError) throw error;
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_CONFLICT",
      `Tool setup could not safely write its files: ${error instanceof Error ? error.message : String(error)}`,
      pending.map((file) => file.path),
    );
  } finally {
    for (const item of opened) closeSync(item.descriptor);
  }
  return { created: created.sort(), updated: updated.sort(), unchanged: unchanged.sort() };
}

function ignorePlan(root: string): PlannedFile {
  const previous = readExisting(root, ".gitignore");
  if (previous === undefined) return { path: ".gitignore", body: Buffer.from(`${RUNTIME_IGNORE}\n`) };
  const text = previous.body.toString("utf8");
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const lastRule = rules.at(-1);
  const body =
    lastRule !== undefined && IGNORE_PATTERNS.has(lastRule)
      ? previous.body
      : Buffer.from(`${text}${text.length === 0 || text.endsWith("\n") ? "" : "\n"}${RUNTIME_IGNORE}\n`);
  return { path: ".gitignore", body, previous };
}

function project(root: string) {
  const previous = readExisting(root, "firedrill.json");
  let raw: unknown = { schemaVersion: 1, sourceRoot: "firedrill", world: "world.json" };
  try {
    if (previous !== undefined) raw = JSON.parse(previous.body.toString("utf8"));
    const config = ProjectConfigSchema.parse(raw);
    if (resolve(root, config.sourceRoot) !== root) guardedPath(root, config.sourceRoot);
    const worldPath = relative(root, guardedPath(root, join(config.sourceRoot, config.world)))
      .split(sep)
      .join("/");
    if (previous !== undefined && readExisting(root, worldPath) === undefined)
      throw new Error(`Configured world source ${worldPath} does not exist.`);
    return { config, raw: raw as Record<string, unknown>, previous, worldPath };
  } catch (error) {
    if (error instanceof FiredrillToolSetupError) throw error;
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_INVALID_PROJECT",
      `Tool setup needs a valid firedrill.json and world source: ${error instanceof Error ? error.message : String(error)}`,
      ["firedrill.json"],
    );
  }
}

function exactGrants(manifest: ToolPackageManifest): readonly OperationRef[] {
  return manifest.operations.map((operation) => ({ packageId: manifest.id, operationId: operation.id }));
}

function worldShell(
  grants: readonly OperationRef[],
  starter?: { readonly virtualTimeUs: number; readonly state: readonly unknown[] },
) {
  return {
    schemaVersion: 1,
    id: "local-world",
    actors: [{ id: "local-dev", grants }],
    ...(starter === undefined ? {} : { virtualTimeUs: starter.virtualTimeUs, state: starter.state }),
  };
}

function grantGuidance(
  existing: boolean,
  worldPath: string,
  grants: readonly OperationRef[],
): readonly string[] {
  return existing
    ? [
        `Existing actors and grants in ${worldPath} were not changed. Add only the needed exact grants to the actor that will call this Tool: ${JSON.stringify(grants)}.`,
      ]
    : [`Created actor local-dev in ${worldPath} with exactly the declared operation grants.`];
}

const VALUE_SCHEMA = {
  type: "object",
  required: ["value"],
  properties: { value: {} },
  additionalProperties: false,
};
const ID_SCHEMA = { type: "string", minLength: 1, maxLength: 512 };

function declaration(id: string, template: "stateful" | "stateless") {
  const source =
    template === "stateless"
      ? {
          schemaVersion: 1,
          module: "./behavior.mjs",
          manifest: {
            schemaVersion: 1,
            id,
            version: "1.0.0",
            engine: ">=0.1.0 <0.2.0",
            capabilities: [],
            operations: [
              {
                id: "echo",
                inputSchema: VALUE_SCHEMA,
                outputSchema: VALUE_SCHEMA,
                idempotency: "none",
                fidelity: "contract",
              },
            ],
          },
        }
      : {
          schemaVersion: 1,
          module: "./behavior.mjs",
          manifest: {
            schemaVersion: 1,
            id,
            version: "1.0.0",
            engine: ">=0.1.0 <0.2.0",
            capabilities: ["state.read", "state.write"],
            state: [{ namespace: "records", schema: VALUE_SCHEMA }],
            operations: [
              {
                id: "get",
                inputSchema: {
                  type: "object",
                  required: ["id"],
                  properties: { id: ID_SCHEMA },
                  additionalProperties: false,
                },
                outputSchema: VALUE_SCHEMA,
                declaredErrors: ["NOT_FOUND"],
                idempotency: "none",
                fidelity: "stateful",
              },
              {
                id: "set",
                inputSchema: {
                  type: "object",
                  required: ["id", "value"],
                  properties: { id: ID_SCHEMA, value: {} },
                  additionalProperties: false,
                },
                outputSchema: VALUE_SCHEMA,
                idempotency: "optional",
                fidelity: "stateful",
              },
            ],
            http: [
              {
                id: "get-record",
                operationId: "get",
                method: "GET",
                path: `/${id}/records/{id}`,
                auth: { kind: "bearer" },
                requestBody: "none",
                response: { successStatus: 200, errors: [{ code: "NOT_FOUND", status: 404 }] },
              },
              {
                id: "set-record",
                operationId: "set",
                method: "PUT",
                path: `/${id}/records/{id}`,
                auth: { kind: "bearer" },
                requestBody: "json",
                response: { successStatus: 200 },
              },
            ],
          },
        };
  return { source, manifest: ToolSourceSchema.parse(source).manifest };
}

const STATEFUL_BEHAVIOR = `import { ToolFailure } from "@firedrill/tool-sdk";

function encode({ outcome }) {
  return { body: { kind: "json", value: outcome.status === "ok" ? outcome.value : { error: outcome.error } } };
}

export default {
  operations: {
    get: (input, context) => {
      const record = context.state.get("records", input.id);
      if (record === null) throw new ToolFailure({ code: "NOT_FOUND", message: "The requested record does not exist." });
      return record;
    },
    set: (input, context) => {
      const record = { value: input.value };
      context.state.put("records", input.id, record);
      return record;
    },
  },
  http: {
    "get-record": {
      decode: (request) => ({ arguments: { id: request.path.id } }),
      encode,
    },
    "set-record": {
      decode: (request) => ({ arguments: { ...request.body.value, id: request.path.id } }),
      encode,
    },
  },
};
`;

/** Create an ordinary local Tool declaration and behavior; this never loads the behavior module. */
export function createTool(input: {
  readonly root: string;
  readonly id: string;
  readonly template?: "stateful" | "stateless";
}): ToolSetupResult {
  if (
    !PackageIdSchema.safeParse(input.id).success ||
    (input.template !== undefined && !["stateful", "stateless"].includes(input.template))
  )
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_INVALID_ARGUMENT",
      "Choose a valid lowercase Tool id and stateful or stateless template.",
    );
  const root = projectRoot(input.root);
  const project_ = project(root);
  const template = input.template ?? "stateful";
  const tool = declaration(input.id, template);
  const grants = exactGrants(tool.manifest);
  const toolDirectory = join(project_.config.sourceRoot, "tools", input.id);
  const files: PlannedFile[] = [
    { path: join(toolDirectory, `${input.id}.tool.json`), body: json(tool.source) },
    {
      path: join(toolDirectory, "behavior.mjs"),
      body: Buffer.from(
        template === "stateful"
          ? STATEFUL_BEHAVIOR
          : "export default { operations: { echo: (input) => ({ value: input.value }) } };\n",
      ),
    },
    ignorePlan(root),
  ];
  if (project_.previous === undefined)
    files.push(
      { path: "firedrill.json", body: json(project_.raw) },
      { path: project_.worldPath, body: json(worldShell(grants)) },
    );
  return {
    schemaVersion: 1,
    kind: "tool-created",
    repositoryRoot: root,
    packageId: input.id,
    ...applyPlan(root, files),
    grants,
    grantGuidance: grantGuidance(project_.previous !== undefined, project_.worldPath, grants),
  };
}

/** Select already installed Tool packages atomically; never installs or executes package code. */
export function addToolPackages(input: {
  readonly root: string;
  readonly packageNames: readonly string[];
}): ToolSetupResult {
  const selected = [...new Set(input.packageNames)];
  if (selected.length === 0 || selected.some((name) => !NodePackageNameSchema.safeParse(name).success))
    throw new FiredrillToolSetupError(
      "framework.TOOL_SETUP_INVALID_ARGUMENT",
      "Select installed npm package names, not paths, URLs, or version selectors.",
    );
  const root = projectRoot(input.root);
  const project_ = project(root);
  const packages = [...new Set([...project_.config.toolPackages, ...selected])];
  const inspected = packages.map((packageName) => {
    try {
      createRequire(join(root, "package.json")).resolve(`${packageName}/package.json`);
    } catch {
      throw new FiredrillToolSetupError(
        "framework.TOOL_PACKAGE_NOT_INSTALLED",
        `Cannot resolve ${packageName} as an installed Tool package. Install it separately and ensure it exports ./package.json; no installation was performed.`,
      );
    }
    const result = inspectInstalledToolPackage({ repositoryRoot: root, packageName });
    if (result.status === "failed")
      throw new FiredrillToolSetupError(
        "framework.TOOL_PACKAGE_INVALID",
        result.diagnostics
          .map((item) => `${item.message}${item.suggestion === undefined ? "" : ` ${item.suggestion}`}`)
          .join("\n"),
      );
    return result;
  });
  const ids = new Set<string>();
  for (const item of inspected) {
    const id = item.declaration.manifest.id;
    if (ids.has(id))
      throw new FiredrillToolSetupError(
        "framework.TOOL_SETUP_CONFLICT",
        `Two selected packages own Tool ${id}; select only one.`,
        ["firedrill.json"],
      );
    ids.add(id);
  }
  const added = inspected.filter((item) => selected.includes(item.package.name));
  const grants = added.flatMap((item) => exactGrants(item.declaration.manifest));
  const state = added.flatMap((item) => item.starter?.state ?? []);
  const starter = added.some((item) => item.starter !== undefined)
    ? { virtualTimeUs: Math.max(...added.map((item) => item.starter?.virtualTimeUs ?? 0)), state }
    : undefined;
  const unchangedConfig = packages.length === project_.config.toolPackages.length;
  const files: PlannedFile[] = [
    {
      path: "firedrill.json",
      body:
        unchangedConfig && project_.previous !== undefined
          ? project_.previous.body
          : json({ ...project_.raw, toolPackages: packages }),
      ...(project_.previous === undefined ? {} : { previous: project_.previous }),
    },
    ignorePlan(root),
  ];
  if (project_.previous === undefined)
    files.push({ path: project_.worldPath, body: json(worldShell(grants, starter)) });
  return {
    schemaVersion: 1,
    kind: "tool-package-added",
    repositoryRoot: root,
    packageId: added[0]?.declaration.manifest.id ?? "",
    packageIds: added.map((item) => item.declaration.manifest.id),
    ...applyPlan(root, files),
    grants,
    grantGuidance: grantGuidance(project_.previous !== undefined, project_.worldPath, grants),
    starterRows: project_.previous === undefined ? state.length : 0,
  };
}

/** Select one installed package without importing its behavior. */
export function addToolPackage(input: {
  readonly root: string;
  readonly packageName: string;
}): ToolSetupResult {
  return addToolPackages({ root: input.root, packageNames: [input.packageName] });
}
