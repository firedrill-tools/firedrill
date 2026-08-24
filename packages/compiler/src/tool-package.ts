import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  NodePackageNameSchema,
  SemverSchema,
  SourcePathSchema,
  type Diagnostic,
  type NodePackageName,
  type SourceSpan,
} from "@firedrill/contracts";
import { z } from "zod";
import { diagnostic } from "./diagnostics.js";
import type { ResolvedRepositoryPath } from "./repository.js";

const MAX_PACKAGE_MANIFEST_BYTES = 1_048_576;

const InstalledToolPackageManifestSchema = z
  .object({
    name: NodePackageNameSchema,
    version: SemverSchema,
    firedrill: z
      .object({
        layer: z.literal("tool-pack"),
        tool: SourcePathSchema,
        lifecycle: z.enum(["active", "deprecated", "revoked"]),
      })
      .passthrough(),
  })
  .passthrough();

export interface InstalledToolPackage {
  readonly name: NodePackageName;
  readonly version: string;
  readonly lifecycle: "active" | "deprecated" | "revoked";
  readonly root: string;
  readonly declaration: ResolvedRepositoryPath;
}

type ToolPackageResolution =
  | { readonly status: "success"; readonly package: InstalledToolPackage }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };

type ToolPackagePathResolution =
  | { readonly status: "success"; readonly path: ResolvedRepositoryPath }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };

function contained(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function packageLabel(packageName: string, packageRoot: string, absolutePath: string): string {
  const path = relative(packageRoot, absolutePath).split(sep).join("/");
  return `npm/${packageName}/${path}`;
}

function failure(input: {
  readonly message: string;
  readonly span?: SourceSpan;
  readonly path?: string;
  readonly suggestion?: string;
}): { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  return {
    status: "failed",
    diagnostics: [
      diagnostic({
        code: "FD1402",
        message: input.message,
        ...(input.span === undefined
          ? input.path === undefined
            ? {}
            : {
                span: {
                  path: input.path,
                  start: { line: 1, column: 1 },
                  end: { line: 1, column: 2 },
                },
              }
          : { span: input.span }),
        ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
      }),
    ],
  };
}

function resolveInsidePackage(input: {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly baseDirectory: string;
  readonly path: string;
  readonly purpose: string;
}): ToolPackagePathResolution {
  const absolutePath = resolve(input.baseDirectory, input.path);
  const unresolvedLabel = packageLabel(input.packageName, input.packageRoot, absolutePath);
  if (!contained(input.packageRoot, absolutePath)) {
    return failure({
      message: `${input.purpose} escapes npm package ${input.packageName}`,
      path: unresolvedLabel,
      suggestion: "Keep every Tool declaration and behavior dependency inside its installed package.",
    });
  }
  try {
    const realPath = realpathSync(absolutePath);
    if (!contained(input.packageRoot, realPath)) {
      return failure({
        message: `${input.purpose} resolves through a symlink outside npm package ${input.packageName}`,
        path: unresolvedLabel,
        suggestion: "Ship the Tool source inside the package instead of following an external symlink.",
      });
    }
    if (!lstatSync(realPath).isFile()) throw new TypeError("path is not a file");
    return {
      status: "success",
      path: {
        absolutePath: realPath,
        repositoryPath: packageLabel(input.packageName, input.packageRoot, realPath),
      },
    };
  } catch (error) {
    return failure({
      message: `cannot read ${input.purpose}: ${error instanceof Error ? error.message : String(error)}`,
      path: unresolvedLabel,
      suggestion: `Reinstall ${input.packageName} or correct its firedrill.tool path.`,
    });
  }
}

/** Resolves one explicitly selected npm Tool package without importing its executable module. */
export function resolveInstalledToolPackage(
  repositoryRoot: string,
  requestedName: NodePackageName,
  span?: SourceSpan,
): ToolPackageResolution {
  let manifestPath: string;
  try {
    const resolver = createRequire(join(repositoryRoot, "package.json"));
    manifestPath = resolver.resolve(`${requestedName}/package.json`);
  } catch (error) {
    return failure({
      message: `cannot resolve Tool package ${requestedName}: ${error instanceof Error ? error.message : String(error)}`,
      ...(span === undefined ? {} : { span }),
      suggestion: `Install ${requestedName} in this project. A Tool pack must export ./package.json and declare firedrill.tool.`,
    });
  }

  let bytes: Buffer;
  let packageRoot: string;
  try {
    const realManifestPath = realpathSync(manifestPath);
    packageRoot = realpathSync(dirname(realManifestPath));
    bytes = readFileSync(realManifestPath);
    if (bytes.byteLength > MAX_PACKAGE_MANIFEST_BYTES) {
      throw new TypeError(`package.json exceeds ${MAX_PACKAGE_MANIFEST_BYTES} bytes`);
    }
  } catch (error) {
    return failure({
      message: `cannot read Tool package ${requestedName}: ${error instanceof Error ? error.message : String(error)}`,
      ...(span === undefined ? {} : { span }),
      suggestion: `Reinstall ${requestedName} and run validation again.`,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return failure({
      message: `Tool package ${requestedName} has invalid package.json: ${error instanceof Error ? error.message : String(error)}`,
      ...(span === undefined ? {} : { span }),
      suggestion: "Repair or reinstall the selected package.",
    });
  }
  const parsed = InstalledToolPackageManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return failure({
      message: `Tool package ${requestedName} has invalid Firedrill metadata: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      ...(span === undefined ? {} : { span }),
      suggestion:
        "The package must declare name, version, firedrill.layer=tool-pack, firedrill.tool, and firedrill.lifecycle in package.json.",
    });
  }
  if (parsed.data.name !== requestedName) {
    return failure({
      message: `Tool package resolved as ${parsed.data.name}, not ${requestedName}`,
      ...(span === undefined ? {} : { span }),
      suggestion: "Correct the selected package name or reinstall its dependency.",
    });
  }

  const declaration = resolveInsidePackage({
    packageName: requestedName,
    packageRoot,
    baseDirectory: packageRoot,
    path: parsed.data.firedrill.tool,
    purpose: "Tool declaration",
  });
  if (declaration.status === "failed") return declaration;
  return {
    status: "success",
    package: {
      name: parsed.data.name,
      version: parsed.data.version,
      lifecycle: parsed.data.firedrill.lifecycle,
      root: packageRoot,
      declaration: declaration.path,
    },
  };
}

export function resolveInstalledToolModule(
  package_: InstalledToolPackage,
  modulePath: string,
): ToolPackagePathResolution {
  return resolveInsidePackage({
    packageName: package_.name,
    packageRoot: package_.root,
    baseDirectory: dirname(package_.declaration.absolutePath),
    path: modulePath,
    purpose: "Tool behavior module",
  });
}
