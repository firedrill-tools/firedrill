import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRestrictedRepositoryPath } from "./repository-policy.js";

const DEFAULT_FILE_LIMIT = 500;
const MAX_FILE_LIMIT = 5_000;
const MAX_DISCOVERED_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const GENERATED_DIRECTORIES = new Set([
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

export interface RepositoryFileListing {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface RepositorySearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface RepositorySearchResult {
  readonly matches: readonly RepositorySearchMatch[];
  readonly filesExamined: number;
  readonly bytesExamined: number;
  readonly truncated: boolean;
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeDirectory(repositoryRoot: string, requestedPath: string | undefined) {
  const root = realpathSync(resolve(repositoryRoot));
  const requested = requestedPath?.trim() || ".";
  if (isAbsolute(requested)) throw new Error("repository path must be relative");
  const lexical = resolve(root, requested);
  if (!contained(root, lexical)) throw new Error("repository path escapes the selected repository");
  const repositoryPath = relative(root, lexical).split(sep).join("/");
  if (isRestrictedRepositoryPath(repositoryPath)) {
    throw new Error("repository path points at secret or generated data");
  }
  const metadata = lstatSync(lexical);
  if (metadata.isSymbolicLink()) throw new Error("repository discovery does not follow symbolic links");
  if (!metadata.isDirectory()) throw new Error("repository discovery path must be a directory");
  const directory = realpathSync(lexical);
  if (!contained(root, directory)) throw new Error("repository path escapes through a symbolic link");
  return { root, directory };
}

function discover(repositoryRoot: string, requestedPath?: string): RepositoryFileListing {
  const { root, directory } = safeDirectory(repositoryRoot, requestedPath);
  const files: string[] = [];
  let truncated = false;
  const visit = (current: string) => {
    if (truncated) return;
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareStableStrings(left.name, right.name),
    );
    for (const entry of entries) {
      if (files.length >= MAX_DISCOVERED_FILES) {
        truncated = true;
        return;
      }
      const absolutePath = join(current, entry.name);
      const repositoryPath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink() || isRestrictedRepositoryPath(repositoryPath)) continue;
      if (entry.isDirectory()) {
        if (!GENERATED_DIRECTORIES.has(entry.name.toLowerCase())) visit(absolutePath);
      } else if (entry.isFile()) files.push(repositoryPath);
    }
  };
  visit(directory);
  return { files, truncated };
}

export function listRepositoryFiles(options: {
  readonly repositoryRoot: string;
  readonly path?: string;
  readonly contains?: string;
  readonly limit?: number;
}): RepositoryFileListing {
  const discovered = discover(options.repositoryRoot, options.path);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_FILE_LIMIT, 1), MAX_FILE_LIMIT);
  const needle = options.contains?.trim().toLowerCase();
  const matching =
    needle === undefined || needle.length === 0
      ? discovered.files
      : discovered.files.filter((path) => path.toLowerCase().includes(needle));
  return {
    files: matching.slice(0, limit),
    truncated: discovered.truncated || matching.length > limit,
  };
}

export function searchRepository(options: {
  readonly repositoryRoot: string;
  readonly query: string;
  readonly path?: string;
  readonly caseSensitive?: boolean;
  readonly limit?: number;
}): RepositorySearchResult {
  const query = options.query.trim();
  if (query.length === 0 || query.length > 500) {
    throw new Error("repository search query must contain 1 through 500 characters");
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const discovered = discover(options.repositoryRoot, options.path);
  const root = realpathSync(resolve(options.repositoryRoot));
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: RepositorySearchMatch[] = [];
  let filesExamined = 0;
  let bytesExamined = 0;
  let truncated = discovered.truncated;
  for (const repositoryPath of discovered.files) {
    if (matches.length >= limit || bytesExamined >= MAX_SEARCH_BYTES) {
      truncated = true;
      break;
    }
    const absolutePath = join(root, ...repositoryPath.split("/"));
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) continue;
    const body = readFileSync(absolutePath);
    if (body.includes(0)) continue;
    filesExamined += 1;
    bytesExamined += body.byteLength;
    const lines = body.toString("utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const haystack = options.caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column === -1) continue;
      matches.push({
        path: repositoryPath,
        line: index + 1,
        column: column + 1,
        preview: line.length <= 500 ? line : `${line.slice(0, 500)}…`,
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
  }
  return { matches, filesExamined, bytesExamined, truncated };
}
