import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Diagnostic } from "@firedrill-tools/contracts";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse as parseYaml,
  parseDocument,
  type Document,
  type Node,
} from "yaml";
import type { z } from "zod";
import { compileWorld } from "./compile.js";
import { diagnostic, schemaDiagnostics, sortDiagnostics } from "./diagnostics.js";
import { normalizeManifest } from "./normalize.js";
import { parseSource } from "./parse.js";
import {
  ProjectConfigSchema,
  DrillSourceSchema,
  ScenarioSourceSchema,
  SuiteSourceSchema,
  TargetSourceSchema,
  ToolSourceSchema,
  WorldSourceSchema,
} from "./source-schemas.js";
import type { FormatWorldOptions, FormatWorldResult, ResourceKind } from "./types.js";
import { authoredSourceVersionDiagnostic } from "./versioning.js";

function schemaFor(kind: ResourceKind | "config"): z.ZodType {
  if (kind === "config") return ProjectConfigSchema;
  if (kind === "world") return WorldSourceSchema;
  if (kind === "tool") return ToolSourceSchema;
  if (kind === "scenario") return ScenarioSourceSchema;
  if (kind === "drill") return DrillSourceSchema;
  if (kind === "suite") return SuiteSourceSchema;
  return TargetSourceSchema;
}

function authoredArrayPeer(normalized: unknown, authored: readonly unknown[], index: number): unknown {
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    return authored[index];
  }
  const normalizedRecord = normalized as Record<string, unknown>;
  for (const identity of ["id", "namespace"] as const) {
    const value = normalizedRecord[identity];
    if (typeof value !== "string") continue;
    const matches = authored.filter(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>)[identity] === value,
    );
    if (matches.length === 1) return matches[0];
  }
  return authored[index];
}

function retainAuthoredShape(normalized: unknown, authored: unknown): unknown {
  if (Array.isArray(normalized) && Array.isArray(authored)) {
    return normalized.map((item, index) =>
      retainAuthoredShape(item, authoredArrayPeer(item, authored, index)),
    );
  }
  if (
    typeof normalized === "object" &&
    normalized !== null &&
    !Array.isArray(normalized) &&
    typeof authored === "object" &&
    authored !== null &&
    !Array.isArray(authored)
  ) {
    const source = authored as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(normalized)
        .filter(([key]) => Object.hasOwn(source, key))
        .map(([key, value]) => [key, retainAuthoredShape(value, source[key])]),
    );
  }
  return normalized;
}

function normalizedValue(kind: ResourceKind | "config", parsed: unknown): unknown {
  if (kind !== "tool") return parsed;
  const tool = ToolSourceSchema.parse(parsed);
  return { ...tool, manifest: normalizeManifest(tool.manifest) };
}

function serialize(path: string, value: unknown): string {
  if (extname(path).toLowerCase() === ".json") return `${JSON.stringify(value, null, 2)}\n`;
  throw new TypeError("YAML serialization requires the authored document");
}

function mapKey(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === "string") return node.value;
  return undefined;
}

function copyPresentation(source: Node, target: Node): Node {
  if (source.commentBefore !== undefined) target.commentBefore = source.commentBefore;
  if (source.comment !== undefined) target.comment = source.comment;
  if (source.spaceBefore !== undefined) target.spaceBefore = source.spaceBefore;
  return target;
}

function reconcileYamlNode(
  document: Document,
  node: Node | null,
  desired: unknown,
  authored: unknown,
): Node | null {
  if (isMap(node) && typeof desired === "object" && desired !== null && !Array.isArray(desired)) {
    const desiredRecord = desired as Record<string, unknown>;
    const authoredRecord =
      typeof authored === "object" && authored !== null && !Array.isArray(authored)
        ? (authored as Record<string, unknown>)
        : {};
    const pairs = new Map(
      node.items.flatMap((pair) => {
        const key = mapKey(pair.key);
        return key === undefined ? [] : [[key, pair] as const];
      }),
    );
    node.items = Object.keys(desiredRecord).map((key) => {
      const pair = pairs.get(key);
      if (pair === undefined) {
        throw new TypeError(`formatted YAML is missing authored key ${key}`);
      }
      const current = isNode(pair.value) ? pair.value : null;
      pair.value = reconcileYamlNode(document, current, desiredRecord[key], authoredRecord[key]);
      return pair;
    });
    node.flow = false;
    return node;
  }

  if (isSeq(node) && Array.isArray(desired) && Array.isArray(authored)) {
    const candidates = node.items.map((item, index) => ({ item, value: authored[index], used: false }));
    node.items = desired.map((value, index) => {
      const peer = authoredArrayPeer(value, authored, index);
      const selected = candidates.find((candidate) => !candidate.used && candidate.value === peer);
      if (selected === undefined) {
        throw new TypeError(`formatted YAML cannot match authored sequence item ${index + 1}`);
      }
      selected.used = true;
      const current = isNode(selected.item) ? selected.item : null;
      return reconcileYamlNode(document, current, value, peer);
    });
    node.flow = false;
    return node;
  }

  if (isDeepStrictEqual(desired, authored)) return node;
  const replacement = document.createNode(desired);
  return node === null ? replacement : copyPresentation(node, replacement);
}

function serializeYamlWithComments(source: string, desired: unknown, authored: unknown): string {
  const document = parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError(document.errors[0]?.message ?? "invalid YAML");
  }
  document.contents = reconcileYamlNode(
    document,
    document.contents,
    desired,
    authored,
  ) as typeof document.contents;
  return document.toString({ indent: 2, lineWidth: 0 });
}

function parseSerialized(path: string, value: string): unknown {
  return extname(path).toLowerCase() === ".json" ? JSON.parse(value) : parseYaml(value);
}

function atomicWrite(path: string, contents: string): void {
  const temporaryPath = `${path}.firedrill-format-${process.pid}`;
  writeFileSync(temporaryPath, contents, { flag: "wx" });
  try {
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function formatDocument(input: {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly kind: ResourceKind | "config";
  readonly check: boolean;
}):
  | { readonly status: "success"; readonly changed: boolean }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] } {
  const absolutePath = join(input.repositoryRoot, ...input.path.split("/"));
  const parsed = parseSource(absolutePath, input.path);
  if (parsed.status === "failed") return parsed;
  const versionDiagnostic = authoredSourceVersionDiagnostic(parsed.document);
  if (versionDiagnostic !== undefined) {
    return { status: "failed", diagnostics: [versionDiagnostic] };
  }
  const validated = schemaFor(input.kind).safeParse(parsed.document.value);
  if (!validated.success) {
    return { status: "failed", diagnostics: schemaDiagnostics(parsed.document, validated.error.issues) };
  }
  const normalized = normalizedValue(input.kind, validated.data);
  const authored = parsed.document.value;
  const desired = retainAuthoredShape(normalized, authored);
  const source = readFileSync(absolutePath, "utf8");
  let next: string;
  try {
    next =
      extname(input.path).toLowerCase() === ".json"
        ? serialize(input.path, desired)
        : serializeYamlWithComments(source, desired, authored);
    const roundTrip = schemaFor(input.kind).safeParse(parseSerialized(input.path, next));
    if (!roundTrip.success || !isDeepStrictEqual(normalizedValue(input.kind, roundTrip.data), normalized)) {
      return {
        status: "failed",
        diagnostics: [
          diagnostic({
            code: "FD1701",
            message: "refusing to format source because the formatted document changes its meaning",
            span: parsed.document.spanAt([]),
            suggestion: "Keep the source unchanged and report this formatter case with the affected file.",
          }),
        ],
      };
    }
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        diagnostic({
          code: "FD1701",
          message: `refusing to format source because the formatted document cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
          span: parsed.document.spanAt([]),
          suggestion: "Keep the source unchanged and report this formatter case with the affected file.",
        }),
      ],
    };
  }
  const changed = source !== next;
  if (changed && !input.check) {
    try {
      atomicWrite(absolutePath, next);
    } catch (error) {
      return {
        status: "failed",
        diagnostics: [
          diagnostic({
            code: "FD1701",
            message: `cannot format source: ${error instanceof Error ? error.message : String(error)}`,
            span: parsed.document.spanAt([]),
          }),
        ],
      };
    }
  }
  return { status: "success", changed };
}

export async function formatWorldSources(options: FormatWorldOptions): Promise<FormatWorldResult> {
  const compiled = await compileWorld({ repositoryRoot: options.repositoryRoot, materialize: false });
  if (compiled.status === "failed") return compiled;
  const sources = [
    { kind: "config" as const, path: "firedrill.json" },
    ...compiled.build.sourceProvenance
      .filter((source) => source.origin.kind === "repository")
      .map((source) => ({ kind: source.kind, path: source.sourcePath })),
  ];
  const diagnostics: Diagnostic[] = [];
  const files: Array<{ path: string; changed: boolean }> = [];
  for (const source of sources) {
    const result = formatDocument({
      repositoryRoot: options.repositoryRoot,
      path: source.path,
      kind: source.kind,
      check: options.check ?? false,
    });
    if (result.status === "failed") diagnostics.push(...result.diagnostics);
    else files.push({ path: source.path, changed: result.changed });
  }
  if (diagnostics.length > 0) return { status: "failed", diagnostics: sortDiagnostics(diagnostics) };
  return { status: "success", diagnostics: [], files };
}
