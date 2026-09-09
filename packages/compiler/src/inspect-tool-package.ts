import { readFileSync } from "node:fs";
import { type Diagnostic, FIREDRILL_ENGINE_VERSION, NodePackageNameSchema } from "@firedrill/contracts";
import { CanonicalWorldIrSchema } from "@firedrill/world-ir";
import { satisfies, validRange } from "semver";
import { bundleToolUi } from "./bundle-tool-ui.js";
import { diagnostic, schemaDiagnostics } from "./diagnostics.js";
import { normalizeManifest } from "./normalize.js";
import { parseSource } from "./parse.js";
import { type ToolSource, ToolSourceSchema, type WorldSource, WorldSourceSchema } from "./source-schemas.js";
import { resolveInstalledToolModule, resolveInstalledToolPackage } from "./tool-package.js";
import { validateWorldData } from "./validate-world-data.js";
import { authoredSourceVersionDiagnostic } from "./versioning.js";

export type InspectInstalledToolPackageResult =
  | {
      readonly status: "success";
      readonly package: {
        readonly name: string;
        readonly version: string;
        readonly lifecycle: "active" | "deprecated";
      };
      readonly declaration: ToolSource;
      readonly declarationPath: string;
      readonly modulePath: string;
      readonly starter?: Pick<WorldSource, "schemaVersion" | "virtualTimeUs" | "state">;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };

/** Reads selected installed package metadata and source without importing behavior code. */
export function inspectInstalledToolPackage(options: {
  readonly repositoryRoot: string;
  readonly packageName: string;
}): InspectInstalledToolPackageResult {
  const name = NodePackageNameSchema.safeParse(options.packageName);
  if (!name.success) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1402",
          message: "Select an installed npm package name, not a path, URL, or version selector.",
        }),
      ],
    };
  }
  const resolved = resolveInstalledToolPackage(options.repositoryRoot, name.data);
  if (resolved.status === "failed") return resolved;
  const installed = resolved.package;
  if (installed.lifecycle === "revoked") {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1403",
          message: `Tool package ${installed.name}@${installed.version} is revoked`,
          suggestion: "Install a non-revoked package version before selecting it.",
        }),
      ],
    };
  }
  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(installed.declaration.absolutePath, installed.declaration.repositoryPath);
  } catch {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1101",
          message: "The installed Tool declaration could not be parsed safely.",
        }),
      ],
    };
  }
  if (parsed.status === "failed") return parsed;
  const versionDiagnostic = authoredSourceVersionDiagnostic(parsed.document);
  if (versionDiagnostic !== undefined) return { status: "failed", diagnostics: [versionDiagnostic] };
  const source = ToolSourceSchema.safeParse(parsed.document.value);
  if (!source.success) {
    return { status: "failed", diagnostics: schemaDiagnostics(parsed.document, source.error.issues) };
  }
  const manifest = source.data.manifest;
  if (manifest.version !== installed.version) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1402",
          message: `Tool manifest version ${manifest.version} does not match package version ${installed.version}`,
          span: parsed.document.spanAt(["manifest", "version"]),
        }),
      ],
    };
  }
  const range = validRange(manifest.engine);
  if (range === null || !satisfies(FIREDRILL_ENGINE_VERSION, range, { includePrerelease: true })) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1401",
          message: `Tool ${manifest.id} requires engine ${manifest.engine}; current engine is ${FIREDRILL_ENGINE_VERSION}`,
          span: parsed.document.spanAt(["manifest", "engine"]),
        }),
      ],
    };
  }
  const module = resolveInstalledToolModule(installed, source.data.module);
  if (module.status === "failed") return module;
  if (source.data.ui !== undefined) {
    const ui = bundleToolUi({
      packageId: manifest.id,
      declarationPath: installed.declaration.absolutePath,
      declarationLabel: installed.declaration.repositoryPath,
      sourceRoot: installed.root,
      provenanceRoot: installed.root,
      provenancePrefix: `npm/${installed.name}`,
      ui: source.data.ui,
    });
    if (ui.status === "failed") return ui;
  }
  let starter: Pick<WorldSource, "schemaVersion" | "virtualTimeUs" | "state"> | undefined;
  if (installed.starter !== undefined) {
    try {
      const bytes = readFileSync(installed.starter.absolutePath);
      if (bytes.byteLength > 1_048_576) throw new Error("Tool starter exceeds 1 MiB");
      starter = WorldSourceSchema.pick({ schemaVersion: true, virtualTimeUs: true, state: true }).parse(
        JSON.parse(bytes.toString("utf8")),
      );
      const world = CanonicalWorldIrSchema.parse({
        schemaVersion: 1,
        engineVersion: FIREDRILL_ENGINE_VERSION,
        world: { id: "tool-starter", seed: "1" },
        tools: [normalizeManifest(manifest)],
        baseline: { virtualTimeUs: starter.virtualTimeUs, state: starter.state },
      });
      const issues = validateWorldData(world);
      if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
    } catch (error) {
      return {
        status: "failed",
        diagnostics: [
          diagnostic({
            code: "FD1402",
            message: `Invalid package-authored Tool starter: ${error instanceof Error ? error.message : String(error)}`,
            suggestion:
              "The starter must contain schemaVersion: 1, optional virtualTimeUs, and state rows valid for this Tool's declared namespaces and JSON Schemas.",
          }),
        ],
      };
    }
  }
  return {
    status: "success",
    package: { name: installed.name, version: installed.version, lifecycle: installed.lifecycle },
    declaration: source.data,
    declarationPath: installed.declaration.absolutePath,
    modulePath: module.path.absolutePath,
    ...(starter === undefined ? {} : { starter }),
    diagnostics:
      installed.lifecycle === "deprecated"
        ? [
            diagnostic({
              code: "FD1403",
              severity: "warning",
              message: `Tool package ${installed.name}@${installed.version} is deprecated`,
              suggestion: "Plan an upgrade; this installed version remains selectable.",
            }),
          ]
        : [],
  };
}
