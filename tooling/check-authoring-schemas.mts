import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface JsonSchema {
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema & { readonly default?: unknown }>>;
}

const root = resolve(import.meta.dirname, "..");
const schemaRoot = join(root, "packages", "compiler", "dist", "schema");
const expectedRequired: Readonly<Record<string, readonly string[]>> = {
  "drill-source.json": ["assertions", "id", "schemaVersion", "targetId"],
  "project-config.json": ["schemaVersion"],
  "scenario-source.json": ["id", "schemaVersion"],
  "suite-source.json": ["id", "schemaVersion"],
  "target-source.json": ["schemaVersion", "target"],
  "tool-source.json": ["manifest", "module", "schemaVersion"],
  "world-source.json": ["id", "schemaVersion"],
};

for (const [fileName, expected] of Object.entries(expectedRequired)) {
  const schema = JSON.parse(readFileSync(join(schemaRoot, fileName), "utf8")) as JsonSchema;
  const required = [...(schema.required ?? [])].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(required) !== JSON.stringify(expected)) {
    throw new Error(
      `${fileName} requires ${required.join(", ") || "nothing"}; authored input should require ${expected.join(", ")}`,
    );
  }
  if (schema.additionalProperties !== false) {
    throw new Error(`${fileName} must reject unknown top-level authoring fields`);
  }
}

const project = JSON.parse(readFileSync(join(schemaRoot, "project-config.json"), "utf8")) as JsonSchema;
if (!Array.isArray(project.properties?.toolPackages?.default)) {
  throw new Error("project-config.json must advertise the empty toolPackages default");
}

const tool = JSON.parse(readFileSync(join(schemaRoot, "tool-source.json"), "utf8")) as JsonSchema;
const manifestRequired = [...(tool.properties?.manifest?.required ?? [])].sort((left, right) =>
  left.localeCompare(right),
);
const expectedManifestRequired = ["capabilities", "engine", "id", "operations", "schemaVersion", "version"];
if (JSON.stringify(manifestRequired) !== JSON.stringify(expectedManifestRequired)) {
  throw new Error(
    `tool-source manifest requires ${manifestRequired.join(", ")}; defaulted authoring fields became mandatory`,
  );
}

process.stdout.write("authored-source JSON Schemas match compiler input defaults\n");
