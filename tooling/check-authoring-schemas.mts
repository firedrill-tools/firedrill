import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareStableStrings } from "./stable-order.mts";

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
  const required = [...(schema.required ?? [])].sort(compareStableStrings);
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
const packageMetadata = JSON.parse(
  readFileSync(join(schemaRoot, "installed-tool-package.json"), "utf8"),
) as JsonSchema;
if (
  JSON.stringify([...(packageMetadata.required ?? [])].sort(compareStableStrings)) !==
  JSON.stringify(["firedrill", "name", "version"])
)
  throw new Error(
    "installed-tool-package.json must require the npm name/version and Firedrill metadata envelope",
  );
if (packageMetadata.properties?.firedrill?.properties?.conformance === undefined)
  throw new Error("installed-tool-package.json must describe portable package conformance");
if (!Array.isArray(project.properties?.toolPackages?.default)) {
  throw new Error("project-config.json must advertise the empty toolPackages default");
}

const tool = JSON.parse(readFileSync(join(schemaRoot, "tool-source.json"), "utf8")) as JsonSchema;
const manifestRequired = [...(tool.properties?.manifest?.required ?? [])].sort((left, right) =>
  compareStableStrings(left, right),
);
const expectedManifestRequired = ["capabilities", "engine", "id", "operations", "schemaVersion", "version"];
if (JSON.stringify(manifestRequired) !== JSON.stringify(expectedManifestRequired)) {
  throw new Error(
    `tool-source manifest requires ${manifestRequired.join(", ")}; defaulted authoring fields became mandatory`,
  );
}

process.stdout.write("authored-source JSON Schemas match compiler input defaults\n");
