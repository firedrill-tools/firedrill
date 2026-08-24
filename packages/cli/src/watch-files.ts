import { watch } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const IGNORED_SEGMENTS = new Set([".firedrill", ".git", "coverage", "dist", "node_modules"]);

export interface WatchCycle {
  readonly sequence: number;
  readonly trigger: "initial" | "change";
  readonly changedFiles: readonly string[];
}

export interface WatchFilesOptions {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly ignorePaths?: readonly string[];
  readonly debounceMs?: number;
  readonly onCycle: (cycle: WatchCycle) => void | Promise<void>;
}

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function normalizedRelative(root: string, filename: string | null): string {
  if (filename === null) return "<unknown>";
  const absolute = resolve(root, filename);
  if (!contained(root, absolute)) return "<outside-root>";
  return relative(root, absolute).split(sep).join("/") || ".";
}

function ignored(root: string, path: string, ignoredPaths: readonly string[]): boolean {
  if (path === "<outside-root>") return true;
  if (path !== "<unknown>" && path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return true;
  }
  if (path === "<unknown>") return false;
  const absolute = resolve(root, path);
  return ignoredPaths.some((ignoredPath) => contained(ignoredPath, absolute));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay(false);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      resolveDelay(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function watchFiles(options: WatchFilesOptions): Promise<void> {
  const root = resolve(options.root);
  const ignoredPaths = (options.ignorePaths ?? [])
    .map((path) => resolve(path))
    .filter((path) => contained(root, path));
  const debounceMs = options.debounceMs ?? 80;
  let version = 0;
  let observedVersion = 0;
  let sequence = 0;
  let wake: (() => void) | undefined;
  const changedFiles = new Set<string>();

  const watcher = watch(root, { encoding: "utf8", recursive: true }, (_event, filename) => {
    const path = normalizedRelative(root, filename);
    if (ignored(root, path, ignoredPaths)) return;
    changedFiles.add(path);
    version += 1;
    wake?.();
    wake = undefined;
  });
  const wakeOnAbort = () => {
    wake?.();
    wake = undefined;
  };
  options.signal.addEventListener("abort", wakeOnAbort);

  try {
    sequence += 1;
    await options.onCycle({ sequence, trigger: "initial", changedFiles: [] });
    observedVersion = 0;
    while (!options.signal.aborted) {
      if (version === observedVersion) {
        await new Promise<void>((resolveChange) => {
          wake = resolveChange;
          if (version !== observedVersion || options.signal.aborted) {
            wake = undefined;
            resolveChange();
          }
        });
      }
      if (options.signal.aborted) break;

      let stableVersion = version;
      if (!(await delay(debounceMs, options.signal))) break;
      while (version !== stableVersion) {
        stableVersion = version;
        if (!(await delay(debounceMs, options.signal))) return;
      }

      observedVersion = version;
      const files = [...changedFiles].sort();
      changedFiles.clear();
      sequence += 1;
      await options.onCycle({ sequence, trigger: "change", changedFiles: files });
    }
  } finally {
    options.signal.removeEventListener("abort", wakeOnAbort);
    watcher.close();
  }
}
