import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXCLUDED_SOURCE_DIRECTORIES = new Set([".firedrill", ".git", "coverage", "dist", "node_modules"]);

export function releaseSourceFiles(repositoryRoot: string): readonly string[] {
  const root = resolve(repositoryRoot);
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  });
  if (listed.status !== 0) {
    throw new Error(`release source inventory requires a Git worktree\n${listed.stderr ?? ""}`);
  }
  const files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.split("/").some((segment) => EXCLUDED_SOURCE_DIRECTORIES.has(segment)))
    .sort();
  for (const path of files) {
    const metadata = lstatSync(resolve(root, path));
    if (!metadata.isFile()) {
      throw new Error(`public source contains an unsupported entry: ${path}`);
    }
  }
  return files;
}

export function releaseSourceTreeDigest(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const hash = createHash("sha256");
  for (const path of releaseSourceFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
