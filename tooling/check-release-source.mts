import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSourceFiles, releaseSourceTreeDigest } from "./release-source.mts";

const repository = mkdtempSync(join(tmpdir(), "firedrill-release-source-"));

function git(arguments_: readonly string[]): void {
  const result = spawnSync("git", [...arguments_], {
    cwd: repository,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

try {
  git(["init", "--quiet"]);
  writeFileSync(join(repository, ".gitignore"), ".env.*\ndist/\n");
  writeFileSync(join(repository, "tracked.txt"), "tracked\n");
  writeFileSync(join(repository, "untracked.txt"), "untracked\n");
  writeFileSync(join(repository, ".env.private"), "first ignored value\n");
  mkdirSync(join(repository, "dist"));
  writeFileSync(join(repository, "dist", "generated.js"), "generated\n");
  git(["add", ".gitignore", "tracked.txt"]);

  const files = releaseSourceFiles(repository);
  if (JSON.stringify(files) !== JSON.stringify([".gitignore", "tracked.txt", "untracked.txt"])) {
    throw new Error(
      `release source inventory included ignored output or omitted source: ${files.join(", ")}`,
    );
  }

  const baseline = releaseSourceTreeDigest(repository);
  writeFileSync(join(repository, ".env.private"), "different ignored value\n");
  if (releaseSourceTreeDigest(repository) !== baseline) {
    throw new Error("ignored local files changed the release source digest");
  }
  writeFileSync(join(repository, "tracked.txt"), "changed tracked value\n");
  if (releaseSourceTreeDigest(repository) === baseline) {
    throw new Error("a tracked source change did not change the release source digest");
  }

  process.stdout.write("release source inventory excludes ignored local state and hashes source changes\n");
} finally {
  if (repository.startsWith(`${tmpdir()}/firedrill-release-source-`)) {
    rmSync(repository, { force: true, recursive: true });
  }
}
