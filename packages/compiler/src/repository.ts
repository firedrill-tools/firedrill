import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diagnostic } from "./diagnostics.js";
import type { Diagnostic } from "@firedrill/contracts";
import { compareStableStrings } from "@firedrill/contracts";
import type { ResourceKind } from "./types.js";

const IGNORED_DIRECTORIES = new Set([".firedrill", ".git", "node_modules"]);
const MAX_RESOURCES = 1_000;

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export interface RepositoryContext {
  readonly root: string;
  readonly rootRealPath: string;
}

export interface ResolvedRepositoryPath {
  readonly absolutePath: string;
  readonly repositoryPath: string;
}

export interface DiscoveredSource extends ResolvedRepositoryPath {
  readonly kind: Exclude<ResourceKind, "world">;
}

export function openRepository(
  repositoryRoot: string,
):
  | { readonly status: "success"; readonly repository: RepositoryContext }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const root = resolve(repositoryRoot);
  try {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory()) throw new TypeError("repository root is not a directory");
    return { status: "success", repository: { root, rootRealPath: realpathSync(root) } };
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1001",
          message: `cannot open repository root: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ],
    };
  }
}

export function resolveRepositoryPath(
  repository: RepositoryContext,
  baseDirectory: string,
  path: string,
  purpose: string,
  missingSuggestion?: string,
):
  | { readonly status: "success"; readonly path: ResolvedRepositoryPath }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const absolutePath = resolve(baseDirectory, path);
  const repositoryPath = relative(repository.root, absolutePath).split(sep).join("/");
  if (!isContained(repository.root, absolutePath)) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1002",
          message: `${purpose} escapes the repository root`,
          span: { path: repositoryPath || path, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          suggestion: "Use a repository-relative path that stays inside the checkout.",
        }),
      ],
    };
  }
  if (!existsSync(absolutePath)) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1001",
          message: `${purpose} does not exist`,
          span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          ...(missingSuggestion === undefined ? {} : { suggestion: missingSuggestion }),
        }),
      ],
    };
  }
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1001",
          message: `cannot resolve ${purpose}: ${error instanceof Error ? error.message : String(error)}`,
          span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        }),
      ],
    };
  }
  if (!isContained(repository.rootRealPath, realPath)) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1002",
          message: `${purpose} resolves through a symlink outside the repository root`,
          span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          suggestion: "Move the source into the repository instead of following an external symlink.",
        }),
      ],
    };
  }
  return { status: "success", path: { absolutePath, repositoryPath } };
}

function resourceKind(fileName: string): DiscoveredSource["kind"] | undefined {
  const lower = fileName.toLowerCase();
  for (const kind of ["tool", "scenario", "drill", "suite", "target"] as const) {
    if ([`.${kind}.json`, `.${kind}.yaml`, `.${kind}.yml`].some((suffix) => lower.endsWith(suffix))) {
      return kind;
    }
  }
  return undefined;
}

export function discoverSources(
  repository: RepositoryContext,
  sourceRoot: ResolvedRepositoryPath,
): { readonly sources: readonly DiscoveredSource[]; readonly diagnostics: readonly Diagnostic[] } {
  const sources: DiscoveredSource[] = [];
  const diagnostics: Diagnostic[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareStableStrings(a.name, b.name),
    )) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const repositoryPath = relative(repository.root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathSync(absolutePath);
        } catch (error) {
          diagnostics.push(
            diagnostic({
              code: "FD1002",
              message: `cannot resolve source symlink: ${error instanceof Error ? error.message : String(error)}`,
              span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            }),
          );
          continue;
        }
        if (!isContained(repository.rootRealPath, resolved)) {
          diagnostics.push(
            diagnostic({
              code: "FD1002",
              message: "source symlink resolves outside the repository root",
              span: { path: repositoryPath, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
              suggestion: "Keep all compiled source within the repository checkout.",
            }),
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = resourceKind(entry.name);
      if (kind === undefined) continue;
      sources.push({ kind, absolutePath, repositoryPath });
      if (sources.length > MAX_RESOURCES) {
        diagnostics.push(
          diagnostic({
            code: "FD1003",
            message: `source root exceeds the ${MAX_RESOURCES}-resource limit`,
            span: {
              path: sourceRoot.repositoryPath,
              start: { line: 1, column: 1 },
              end: { line: 1, column: 2 },
            },
            suggestion: "Split the world or reduce generated source files.",
          }),
        );
        return;
      }
    }
  };

  try {
    if (!lstatSync(sourceRoot.absolutePath).isDirectory())
      throw new TypeError("source root is not a directory");
    visit(sourceRoot.absolutePath);
  } catch (error) {
    diagnostics.push(
      diagnostic({
        code: "FD1001",
        message: `cannot discover source root: ${error instanceof Error ? error.message : String(error)}`,
        span: {
          path: sourceRoot.repositoryPath,
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
      }),
    );
  }
  return { sources, diagnostics };
}

export function resolveToolModule(repository: RepositoryContext, toolSourcePath: string, modulePath: string) {
  return resolveRepositoryPath(repository, dirname(toolSourcePath), modulePath, "Tool behavior module");
}
