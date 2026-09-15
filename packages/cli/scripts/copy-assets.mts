import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolIndexJsonSchema } from "../src/tool-index-schema.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const assets = [
  {
    source: resolve(repositoryRoot, "registry/index.json"),
    destination: resolve(packageRoot, "dist/registry/index.json"),
  },
  { source: resolve(repositoryRoot, "skills/firedrill"), destination: resolve(packageRoot, "dist/skill") },
  {
    source: resolve(repositoryRoot, "templates/minimal"),
    destination: resolve(packageRoot, "dist/templates/minimal"),
  },
] as const;

for (const item of assets) {
  if (!existsSync(item.source)) throw new Error(`required CLI asset is missing: ${item.source}`);
  rmSync(item.destination, { recursive: true, force: true });
  mkdirSync(dirname(item.destination), { recursive: true });
  cpSync(item.source, item.destination, { recursive: true, errorOnExist: true });
}

writeFileSync(
  resolve(packageRoot, "dist/registry/tool-index.schema.json"),
  `${JSON.stringify(toolIndexJsonSchema(), null, 2)}\n`,
);
