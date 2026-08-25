import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(process.cwd());
const relativePackage = relative(repositoryRoot, packageRoot);

if (
  relativePackage === "" ||
  relativePackage === ".." ||
  relativePackage.startsWith(`..${sep}`) ||
  !/^(?:packages|tool-packs)[\\/][^\\/]+$/.test(relativePackage)
) {
  throw new Error("package file helper must run from a package or Tool-pack directory");
}

const action = process.argv[2];
const dist = resolve(packageRoot, "dist");

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function filesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files;
}

function embedSourceMapSources(): void {
  for (const mapPath of filesUnder(dist).filter((path) => path.endsWith(".map"))) {
    const document = JSON.parse(readFileSync(mapPath, "utf8")) as {
      sourceRoot?: string;
      sources?: string[];
      sourcesContent?: Array<string | null>;
      [key: string]: unknown;
    };
    if ((document.sources?.length ?? 0) === 0) continue;
    if (
      document.sourcesContent?.length === document.sources?.length &&
      document.sourcesContent.every((source) => source !== null)
    ) {
      continue;
    }
    document.sourcesContent = document.sources?.map((source) => {
      const sourcePath = resolve(dirname(mapPath), document.sourceRoot ?? "", source);
      if (!contained(packageRoot, sourcePath) || !existsSync(sourcePath)) {
        throw new Error(
          `source map references unavailable package source: ${relative(packageRoot, sourcePath)}`,
        );
      }
      return readFileSync(sourcePath, "utf8");
    });
    writeFileSync(mapPath, JSON.stringify(document));
  }
}

if (action === "clean") {
  rmSync(dist, { recursive: true, force: true });
} else if (action === "finalize") {
  if (!existsSync(dist)) throw new Error("package build produced no dist directory");
  embedSourceMapSources();
  copyFileSync(resolve(repositoryRoot, "LICENSE"), resolve(dist, "LICENSE"));
  copyFileSync(resolve(repositoryRoot, "NOTICE"), resolve(dist, "NOTICE"));
  const binIndex = process.argv.indexOf("--bin");
  if (binIndex >= 0) {
    const requested = process.argv[binIndex + 1];
    if (requested === undefined) throw new Error("--bin requires a package-relative path");
    const executable = resolve(packageRoot, requested);
    const relativeExecutable = relative(dist, executable);
    if (
      relativeExecutable === "" ||
      relativeExecutable === ".." ||
      relativeExecutable.startsWith(`..${sep}`) ||
      !existsSync(executable)
    ) {
      throw new Error("package executable must be an existing file inside dist");
    }
    chmodSync(executable, 0o755);
  }
} else {
  throw new Error("usage: package-files.mts clean | finalize [--bin <dist/file>]");
}
