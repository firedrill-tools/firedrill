import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CompiledBuild } from "@firedrill-run/compiler";
import {
  type SimulationToolImplementation,
  SimulationToolImplementationSchema,
  type SimulationToolSourceDocument,
  SimulationToolSourceDocumentSchema,
  type SimulationToolSourceUnavailableReason,
} from "./contracts.js";

const MAX_FILE_BYTES = 1024 * 1024;
type ToolSourceOrigin = CompiledBuild["toolSources"][number]["origin"];
const MAX_SNAPSHOT_BYTES = 16 * MAX_FILE_BYTES;
const BLOCKED_SEGMENTS = new Set([".firedrill", ".git", ".ssh", ".aws", "node_modules"]);
const SECRET_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^\.(?:netrc|npmrc|pypirc|yarnrc)$/i,
  /^(?:id_rsa|id_ed25519)$/i,
  /^(?:credentials|secrets?)(?:\..+)?$/i,
  /\.(?:key|p12|pfx|pem)$/i,
];

export interface CapturedToolSources {
  readonly implementations: ReadonlyMap<string, SimulationToolImplementation>;
  readonly documents: ReadonlyMap<string, ReadonlyMap<string, SimulationToolSourceDocument>>;
}

class UnavailableSource extends Error {
  constructor(readonly reason: SimulationToolSourceUnavailableReason) {
    super(reason);
  }
}

function hash(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate !== "" && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)
  );
}

function pathSegments(path: string): readonly string[] {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0"))
    throw new UnavailableSource("unsafe_path");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnavailableSource("unsafe_path");
  }
  return segments;
}

function checkRestrictedPath(segments: readonly string[]): void {
  if (
    segments.some((segment, index) => {
      const name = segment.toLowerCase();
      return (
        BLOCKED_SEGMENTS.has(name) ||
        (name === ".config" && segments[index + 1]?.toLowerCase() === "gcloud") ||
        SECRET_NAMES.some((pattern) => pattern.test(segment))
      );
    })
  ) {
    throw new UnavailableSource("restricted_path");
  }
}

function checkedPath(root: string, path: string): string {
  const segments = pathSegments(path);
  checkRestrictedPath(segments);
  const absolute = resolve(root, ...segments);
  if (!contained(root, absolute)) throw new UnavailableSource("unsafe_path");
  let component = root;
  for (const segment of segments) {
    component = join(component, segment);
    if (lstatSync(component).isSymbolicLink()) throw new UnavailableSource("unsafe_path");
  }
  if (!contained(root, realpathSync(absolute))) throw new UnavailableSource("unsafe_path");
  if (!lstatSync(absolute).isFile()) throw new UnavailableSource("unsafe_path");
  return absolute;
}

/** Bounded reads only; neither package resolution nor source capture imports executable code. */
function readText(root: string, path: string): { readonly bytes: Uint8Array; readonly content: string } {
  const absolute = checkedPath(root, path);
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new UnavailableSource("unsafe_path");
    if (before.size > MAX_FILE_BYTES) throw new UnavailableSource("too_large");
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.byteLength) {
      const count = readSync(descriptor, bytes, size, bytes.byteLength - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_FILE_BYTES) throw new UnavailableSource("too_large");
    const after = fstatSync(descriptor);
    const current = lstatSync(checkedPath(root, path));
    if (
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new UnavailableSource("unsafe_path");
    }
    const captured = bytes.subarray(0, size);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured);
    } catch {
      throw new UnavailableSource("invalid_text");
    }
    if (content.includes("\0") || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(content)) {
      throw new UnavailableSource("invalid_text");
    }
    return { bytes: captured, content };
  } finally {
    closeSync(descriptor);
  }
}

function sourceLanguage(path: string): "typescript" | "javascript" | undefined {
  if (/\.d\.(?:ts|mts|cts)$/i.test(path)) return undefined;
  const extension = extname(path).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return undefined;
}

function sourceRoot(repositoryRoot: string, origin: ToolSourceOrigin): string {
  if (origin.kind !== "npm") return realpathSync(repositoryRoot);
  // Resolve the explicitly selected package as the compiler does. Package-manager root
  // symlinks (including pnpm stores) are allowed; symlinks below that real root are not.
  const manifest = createRequire(join(repositoryRoot, "package.json")).resolve(
    `${origin.packageName}/package.json`,
  );
  const root = realpathSync(dirname(manifest));
  const parsed: unknown = JSON.parse(readText(root, "package.json").content);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    parsed.name !== origin.packageName ||
    !("version" in parsed) ||
    parsed.version !== origin.packageVersion
  ) {
    throw new UnavailableSource("package_changed");
  }
  return root;
}

function sourcePath(path: string, origin: ToolSourceOrigin): string {
  if (origin.kind !== "npm") return path;
  const prefix = `npm/${origin.packageName}/`;
  if (!path.startsWith(prefix)) throw new UnavailableSource("unsafe_path");
  return path.slice(prefix.length);
}

function unavailableReason(error: unknown): SimulationToolSourceUnavailableReason {
  if (error instanceof UnavailableSource) return error.reason;
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "MODULE_NOT_FOUND")
  ) {
    return "missing_source";
  }
  return "unsafe_path";
}

/**
 * Captures the compiler-selected behavior closure at refresh, without importing it.
 * This is current source, not an assertion that its bytes reproduce the immutable
 * artifact: builds retain executable bundles, not original TS/JS snapshots.
 * Known secret paths and private-key text are blocked; arbitrary source may still
 * contain embedded secrets and must not be treated as automatically redacted.
 */
export function captureToolSources(
  repositoryRoot: string,
  build: Pick<CompiledBuild, "manifest" | "packageLock" | "toolSources">,
): CapturedToolSources {
  const implementations = new Map<string, SimulationToolImplementation>();
  const documents = new Map<string, ReadonlyMap<string, SimulationToolSourceDocument>>();
  let remainingBytes = MAX_SNAPSHOT_BYTES;
  for (const lock of build.packageLock.packages) {
    const sources = build.toolSources.find((item) => item.packageId === lock.packageId);
    const files: SimulationToolImplementation["files"] = [];
    const toolDocuments = new Map<string, SimulationToolSourceDocument>();
    let root: string | undefined;
    let rootFailure: SimulationToolSourceUnavailableReason | undefined;
    try {
      root = sourceRoot(repositoryRoot, lock.source);
    } catch (error) {
      rootFailure = unavailableReason(error);
    }
    for (const path of [...new Set(sources?.behaviorPaths ?? [])]) {
      const id = `file-${hash(JSON.stringify([lock.packageId, path])).slice(7)}`;
      const language = sourceLanguage(path);
      const reference = {
        id,
        path,
        ...(language === undefined ? {} : { language }),
        ...(sources?.entryPath === undefined
          ? {}
          : { role: path === sources.entryPath ? ("entry" as const) : ("helper" as const) }),
      };
      try {
        if (root === undefined) throw new UnavailableSource(rootFailure ?? "missing_source");
        const relativePath = sourcePath(path, lock.source);
        checkRestrictedPath(pathSegments(relativePath));
        if (language === undefined) throw new UnavailableSource("unsupported_file");
        if (remainingBytes <= 0) throw new UnavailableSource("snapshot_limit");
        const captured = readText(root, relativePath);
        if (captured.bytes.byteLength > remainingBytes) throw new UnavailableSource("snapshot_limit");
        const document = SimulationToolSourceDocumentSchema.parse({
          schemaVersion: 1,
          toolId: lock.packageId,
          fileId: id,
          snapshot: "compiled_refresh",
          buildHash: build.manifest.buildHash,
          artifactHash: lock.artifactHash,
          path,
          language,
          contentHash: hash(captured.bytes),
          content: captured.content,
        });
        remainingBytes -= captured.bytes.byteLength;
        toolDocuments.set(id, document);
        files.push({ ...reference, readable: true, contentHash: document.contentHash });
      } catch (error) {
        files.push({ ...reference, readable: false, unavailableReason: unavailableReason(error) });
      }
    }
    implementations.set(
      lock.packageId,
      SimulationToolImplementationSchema.parse({
        snapshot: "compiled_refresh",
        buildHash: build.manifest.buildHash,
        artifactHash: lock.artifactHash,
        exportName: lock.exportName,
        origin: lock.source,
        files,
      }),
    );
    documents.set(lock.packageId, toolDocuments);
  }
  return { implementations, documents };
}
