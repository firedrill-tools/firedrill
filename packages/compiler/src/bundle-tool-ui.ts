import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  compareStableStrings,
  type Diagnostic,
  MAX_TOOL_UI_ASSET_BYTES,
  MAX_TOOL_UI_ASSETS,
  MAX_TOOL_UI_BYTES,
  ToolUiPathSchema,
  type ToolUiSource,
  toolUiMediaType,
} from "@firedrill-run/contracts";
import { sha256Text, type ToolUiLock, ToolUiLockSchema } from "@firedrill-run/world-ir";
import { diagnostic } from "./diagnostics.js";

export interface BundledToolUi {
  readonly lock: ToolUiLock;
  readonly assets: readonly { readonly artifactPath: string; readonly bytes: Uint8Array }[];
  readonly sourcePaths: readonly string[];
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Collect static bytes only. Browser JavaScript is never imported or evaluated here. */
export function bundleToolUi(input: {
  readonly packageId: string;
  readonly declarationPath: string;
  readonly declarationLabel: string;
  readonly sourceRoot: string;
  readonly provenanceRoot: string;
  readonly provenancePrefix?: string;
  readonly ui: ToolUiSource;
}):
  | { readonly status: "success"; readonly ui: BundledToolUi }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  try {
    const owner = realpathSync(input.sourceRoot);
    // Canonicalize the already-selected declaration directory (e.g. macOS /var
    // aliases), but inspect every authored UI path component before following it.
    const root = resolve(realpathSync(dirname(input.declarationPath)), input.ui.root);
    if (!contained(owner, root)) throw new Error("UI root escapes the Tool source/package root");
    let component = owner;
    for (const segment of relative(owner, root).split(sep)) {
      component = join(component, segment);
      if (!lstatSync(component).isDirectory() || lstatSync(component).isSymbolicLink())
        throw new Error("UI root must be a directory without symlinks");
    }
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot !== root) throw new Error("UI root must not resolve through symlinks");
    const provenanceRoot = realpathSync(input.provenanceRoot);
    const paths: string[] = [];
    let directories = 0;
    const visit = (directory: string, prefix: string) => {
      if (++directories > MAX_TOOL_UI_ASSETS) throw new Error("UI directory count exceeds its safety bound");
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        compareStableStrings(a.name, b.name),
      )) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!ToolUiPathSchema.safeParse(path).success) throw new Error(`Unsafe UI asset path: ${path}`);
        if (entry.isDirectory()) visit(join(directory, entry.name), path);
        else if (entry.isFile()) {
          if (paths.length >= MAX_TOOL_UI_ASSETS) throw new Error("UI asset count exceeds its safety bound");
          if (toolUiMediaType(path) === undefined) throw new Error(`Unsupported UI asset extension: ${path}`);
          paths.push(path);
        } else throw new Error(`UI assets must be regular files/directories without symlinks: ${path}`);
      }
    };
    visit(root, "");
    paths.sort(compareStableStrings);
    let total = 0;
    const assets = paths.map((path) => {
      const absolute = join(root, ...path.split("/"));
      let parent = root;
      for (const segment of path.split("/").slice(0, -1)) {
        parent = join(parent, segment);
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
          throw new Error("UI asset parent changed to a non-directory or symlink");
      }
      if (realpathSync(absolute) !== absolute) throw new Error("UI asset resolves through a symlink");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const metadata = fstatSync(fd);
        if (
          !metadata.isFile() ||
          metadata.size > MAX_TOOL_UI_ASSET_BYTES ||
          metadata.size > MAX_TOOL_UI_BYTES - total
        )
          throw new Error("UI asset bytes exceed the per-file or per-Tool bound");
        const bounded = Buffer.alloc(metadata.size + 1);
        let length = 0;
        while (length < bounded.length) {
          const count = readSync(fd, bounded, length, bounded.length - length, null);
          if (count === 0) break;
          length += count;
        }
        bytes = bounded.subarray(0, length);
        if (bytes.length !== metadata.size) throw new Error("UI asset changed while being read");
      } finally {
        closeSync(fd);
      }
      total += bytes.length;
      if (total > MAX_TOOL_UI_BYTES) throw new Error("UI assets exceed the per-Tool byte limit");
      const mediaType = toolUiMediaType(path);
      if (mediaType === undefined) throw new Error("UI extension changed while being read");
      if (
        (mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("svg")) &&
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(
          bytes.toString("utf8"),
        )
      )
        throw new Error(`UI asset contains credential-like material: ${path}`);
      const artifactHash = sha256Text(bytes);
      const sourcePath = relative(provenanceRoot, absolute).split(sep).join("/");
      if (!contained(provenanceRoot, absolute)) throw new Error("UI asset escapes its provenance root");
      return {
        path,
        artifactPath: `tools/${input.packageId}-ui/${artifactHash.slice(7)}/${path}`,
        artifactHash,
        bytes,
        mediaType,
        sourcePath:
          input.provenancePrefix === undefined ? sourcePath : `${input.provenancePrefix}/${sourcePath}`,
      };
    });
    const lock = ToolUiLockSchema.parse({
      entry: input.ui.entry,
      assets: assets.map(({ path, artifactPath, artifactHash, bytes, mediaType }) => ({
        path,
        artifactPath,
        artifactHash,
        bytes: bytes.length,
        mediaType,
      })),
    });
    return {
      status: "success",
      ui: {
        lock,
        assets: assets.map(({ artifactPath, bytes }) => ({ artifactPath, bytes })),
        sourcePaths: assets.map((asset) => asset.sourcePath),
      },
    };
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1302",
          message: `Cannot bundle Tool UI: ${error instanceof Error ? error.message : String(error)}`,
          span: { path: input.declarationLabel, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          suggestion:
            "Use a bounded static UI directory inside the Tool's source/package root, with an HTML entry, supported extensions and no hidden/secret files or symlinks.",
        }),
      ],
    };
  }
}
