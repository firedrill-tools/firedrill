import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic, ToolPackageManifest } from "@firedrill-tools/contracts";
import { compareStableStrings, Sha256Schema, SourcePathSchema } from "@firedrill-tools/contracts";
import { semanticHash, sha256Text } from "@firedrill-tools/world-ir";
import { build, type Plugin } from "esbuild";
import { diagnostic } from "./diagnostics.js";
import type { BundledTool } from "./types.js";

const BUNDLED_FRAMEWORK_PACKAGES = new Set(["@firedrill-tools/tool-sdk"]);
const ALLOWED_TOOL_SDK_IMPORTS = new Set([
  "@firedrill-tools/tool-sdk",
  "@firedrill-tools/tool-sdk/behavior-runtime",
  // Existing repository-owned Tools used this scope before npm publication.
  // Resolve only these two entry points to our bundled runtime, never to npm.
  "@firedrill/tool-sdk",
  "@firedrill/tool-sdk/behavior-runtime",
]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const FRAMEWORK_RESOLVER = createRequire(import.meta.url);

function toolSdkRuntimePath(): string {
  const manifestPath = FRAMEWORK_RESOLVER.resolve("@firedrill-tools/tool-sdk/package.json");
  return resolve(dirname(manifestPath), "dist/behavior-runtime.js");
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function packageOwner(filePath: string): string | undefined {
  let directory = dirname(filePath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly name?: unknown };
        if (typeof manifest.name === "string") return manifest.name;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function importPolicy(): Plugin {
  return {
    name: "firedrill-tool-import-policy",
    setup(context) {
      context.onResolve({ filter: /.*/ }, (arguments_) => {
        if (arguments_.kind === "entry-point") return undefined;
        if (ALLOWED_TOOL_SDK_IMPORTS.has(arguments_.path)) return { path: toolSdkRuntimePath() };
        if (BUILTINS.has(arguments_.path)) {
          return {
            errors: [
              {
                text: `Node built-in ${arguments_.path} is not available to deterministic Tool behavior; use ToolContext`,
              },
            ],
          };
        }
        if (!arguments_.path.startsWith(".") && !arguments_.path.startsWith("/")) {
          return {
            errors: [
              {
                text: `bare import ${arguments_.path} is not allowed in a locked Tool artifact; bundle local deterministic code or use the Tool SDK`,
              },
            ],
          };
        }
        return undefined;
      });
    },
  };
}

export async function bundleTool(input: {
  /** Root used to render stable, user-facing source labels. */
  readonly provenanceRoot: string;
  readonly provenancePrefix?: string;
  readonly sourceRoot: string;
  readonly modulePath: string;
  readonly repositoryModulePath: string;
  readonly exportName: string;
  readonly manifest: ToolPackageManifest;
  readonly source: BundledTool["lock"]["source"];
}): Promise<
  | { readonly status: "success"; readonly tool: BundledTool }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] }
> {
  let provenanceRoot = input.provenanceRoot;
  try {
    provenanceRoot = realpathSync(input.provenanceRoot);
    const result = await build({
      absWorkingDir: input.sourceRoot,
      entryPoints: [input.modulePath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      metafile: true,
      minify: true,
      legalComments: "none",
      sourcemap: false,
      plugins: [importPolicy()],
      logLevel: "silent",
    });
    const entrySourcePath = relative(provenanceRoot, realpathSync(input.modulePath)).split(sep).join("/");
    const entryPath =
      input.provenancePrefix === undefined ? entrySourcePath : `${input.provenancePrefix}/${entrySourcePath}`;
    const sourcePaths: string[] = [];
    for (const inputPath of Object.keys(result.metafile.inputs)) {
      const absoluteInput = realpathSync(resolve(input.sourceRoot, inputPath));
      if (!contained(input.sourceRoot, absoluteInput)) {
        const owner = packageOwner(absoluteInput);
        if (owner !== undefined && BUNDLED_FRAMEWORK_PACKAGES.has(owner)) continue;
        return {
          status: "failed",
          diagnostics: [
            diagnostic({
              code: "FD1301",
              message: `Tool behavior imports source outside the configured source root: ${inputPath}`,
              span: {
                path: input.repositoryModulePath,
                start: { line: 1, column: 1 },
                end: { line: 1, column: 2 },
              },
              suggestion: "Move deterministic Tool behavior beneath the source root.",
            }),
          ],
        };
      }
      const sourcePath = relative(provenanceRoot, absoluteInput).split(sep).join("/");
      sourcePaths.push(
        input.provenancePrefix === undefined ? sourcePath : `${input.provenancePrefix}/${sourcePath}`,
      );
    }
    if (!sourcePaths.includes(entryPath))
      throw new TypeError("Tool entry is not in the bundled source closure");
    const output = result.outputFiles[0];
    if (output === undefined) throw new TypeError("esbuild produced no Tool artifact");
    const artifactHash = sha256Text(output.contents);
    const artifactPath = `tools/${input.manifest.id}-${artifactHash.slice(7, 31)}.mjs`;
    return {
      status: "success",
      tool: {
        lock: {
          packageId: input.manifest.id,
          version: input.manifest.version,
          manifestHash: semanticHash(input.manifest),
          artifactHash: Sha256Schema.parse(artifactHash),
          artifactPath,
          exportName: input.exportName,
          moduleFormat: "esm",
          source: input.source,
        },
        bytes: output.contents,
        entryPath,
        sourcePaths: [...new Set(sourcePaths)].sort(compareStableStrings),
      },
    };
  } catch (error) {
    const details = error as {
      readonly errors?: readonly {
        readonly text?: string;
        readonly location?: { readonly file?: string; readonly line?: number; readonly column?: number };
      }[];
    };
    const messages = details.errors?.length
      ? details.errors
      : [{ text: error instanceof Error ? error.message : String(error) }];
    return {
      status: "failed",
      diagnostics: messages.map((message) => {
        const path = message.location?.file;
        const candidatePath =
          path === undefined
            ? input.repositoryModulePath
            : (() => {
                const sourcePath = relative(
                  provenanceRoot,
                  isAbsolute(path) ? path : resolve(input.sourceRoot, path),
                )
                  .split(sep)
                  .join("/");
                return input.provenancePrefix === undefined
                  ? sourcePath
                  : `${input.provenancePrefix}/${sourcePath}`;
              })();
        const repositoryPath = SourcePathSchema.safeParse(candidatePath).success
          ? candidatePath
          : input.repositoryModulePath;
        const line = Math.max(1, message.location?.line ?? 1);
        const column = Math.max(1, (message.location?.column ?? 0) + 1);
        return diagnostic({
          code: "FD1301",
          message: `cannot bundle Tool behavior: ${message.text ?? "unknown build error"}`,
          span: {
            path: repositoryPath,
            start: { line, column },
            end: { line, column: column + 1 },
          },
          suggestion:
            "Keep Tool behavior deterministic and local; use defineToolBehavior/context.fail from @firedrill-tools/tool-sdk for runtime helpers.",
        });
      }),
    };
  }
}
