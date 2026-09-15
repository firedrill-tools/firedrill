import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compileWorld, inspectInstalledToolPackage, ProjectConfigSchema } from "@firedrill/compiler";
import { FiredrillProjectError } from "./project-error.js";
import type { ToolInspection } from "./tool-authoring.js";

const OMITTED = new Set([
  "node_modules",
  ".git",
  ".firedrill",
  ".firedrill-tools",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".pypirc",
  ".DS_Store",
]);
const MAX_FILES = 4_096;
const MAX_BYTES = 33_554_432;

function invalid(message: string): never {
  throw new FiredrillProjectError("framework.TOOL_CONFORMANCE_FAILED", message);
}

/** Copy owned source only: never write into installed dependencies or follow their symlinks. */
export async function stagePackagedToolConformance(input: {
  readonly root: string;
  readonly output: string;
  readonly tool: ToolInspection;
}): Promise<{ readonly root: string; readonly suite: string } | undefined> {
  if (input.tool.origin.kind !== "npm") return undefined;
  const installed = inspectInstalledToolPackage({
    repositoryRoot: input.root,
    packageName: input.tool.origin.packageName,
  });
  if (installed.status === "failed")
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "Installed Tool metadata is invalid", {
      diagnostics: installed.diagnostics,
    });
  const conformance = installed.conformance;
  if (conformance === undefined) return undefined;
  const sourceRoot = realpathSync(conformance.packageRoot);
  const projectPath = relative(sourceRoot, conformance.projectPath);
  if (isAbsolute(projectPath) || projectPath === ".." || projectPath.startsWith(`..${sep}`))
    invalid("Packaged conformance project escapes its package");
  mkdirSync(input.output, { recursive: true });
  const staging = mkdtempSync(join(input.output, "package-source-"));
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const copy = (source: string, destination: string, depth = 0) => {
    entries += 1;
    if (entries > MAX_FILES || depth > 32)
      invalid("Packaged conformance source exceeds 4096 entries or 32 directory levels");
    const info = lstatSync(source);
    if (info.isSymbolicLink()) invalid("Packaged conformance source must not contain symbolic links");
    const actualPath = relative(sourceRoot, realpathSync(source));
    if (actualPath === ".." || actualPath.startsWith(`..${sep}`) || isAbsolute(actualPath))
      invalid("Packaged conformance source escaped its installed package while being read");
    if (info.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      for (const name of readdirSync(source).sort()) {
        if (OMITTED.has(name) || /^\.env(?:\.|$)/.test(name)) continue;
        copy(join(source, name), join(destination, name), depth + 1);
      }
    } else if (info.isFile()) {
      files += 1;
      if (files > MAX_FILES || bytes + info.size > MAX_BYTES)
        invalid("Packaged conformance source exceeds 4096 files or 32 MiB");
      const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
          invalid("Packaged conformance source changed while being opened");
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const chunk = Buffer.alloc(Math.min(65_536, MAX_BYTES - bytes + 1));
          const count = readSync(descriptor, chunk, 0, chunk.length, null);
          if (count === 0) break;
          bytes += count;
          size += count;
          if (bytes > MAX_BYTES) invalid("Packaged conformance source exceeds 32 MiB");
          chunks.push(chunk.subarray(0, count));
        }
        const final = fstatSync(descriptor);
        if (size !== opened.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs)
          invalid("Packaged conformance source changed while being copied");
        writeFileSync(destination, Buffer.concat(chunks, size), { flag: "wx" });
      } finally {
        closeSync(descriptor);
      }
    } else invalid("Packaged conformance source must contain only regular files and directories");
  };
  try {
    copy(sourceRoot, staging);
    const root = dirname(join(staging, projectPath));
    const config = ProjectConfigSchema.safeParse(
      JSON.parse(readFileSync(join(root, "firedrill.json"), "utf8")),
    );
    if (!config.success || config.data.toolPackages.length !== 0)
      invalid(
        "Packaged conformance must be a self-contained Firedrill project without external toolPackages",
      );
    const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
    if (compiled.status === "failed")
      throw new FiredrillProjectError("framework.SOURCE_INVALID", "Packaged conformance source is invalid", {
        diagnostics: compiled.diagnostics,
      });
    const locks = compiled.build.packageLock.packages;
    const locked = locks[0];
    if (
      locks.length !== 1 ||
      locked === undefined ||
      locked.packageId !== input.tool.toolId ||
      locked.manifestHash !== input.tool.artifact.manifestHash ||
      locked.artifactHash !== input.tool.artifact.artifactHash ||
      JSON.stringify(locked.ui ?? null) !== JSON.stringify(input.tool.artifact.ui ?? null)
    )
      invalid(
        "Packaged conformance must exercise the exact installed Tool contract, behavior, and UI assets—not a replacement or another Tool",
      );
    return { root: resolve(root), suite: conformance.suite };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof FiredrillProjectError) throw error;
    throw new FiredrillProjectError(
      "framework.TOOL_CONFORMANCE_FAILED",
      `Cannot prepare package-authored conformance: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
