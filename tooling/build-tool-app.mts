import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

// Maintained packs share a small build-time UI kit. Published packs contain only
// static output; they do not need this checkout or an extra frontend server.
const root = resolve(import.meta.dirname, "..");
const pack = resolve(process.cwd());
if (!/^tool-packs\/[a-z0-9-]+$/.test(relative(root, pack).replaceAll("\\", "/")))
  throw new Error("Run the Tool app build from a Tool-pack directory.");
const destination = join(pack, "dist", "ui");
mkdirSync(destination, { recursive: true });
for (const directory of [join(root, "tooling", "tool-app-ui"), join(pack, "app")]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(css|js|html)$/.test(entry.name))
      throw new Error(`Unexpected Tool app source: ${entry.name}`);
    copyFileSync(join(directory, entry.name), join(destination, entry.name));
  }
}
const inspectorRequire = createRequire(join(root, "packages", "inspector", "package.json"));
const fontRoot = resolve(inspectorRequire.resolve("@fontsource-variable/inter/package.json"), "..");
copyFileSync(join(fontRoot, "files", "inter-latin-wght-normal.woff2"), join(destination, "inter.woff2"));
copyFileSync(join(fontRoot, "LICENSE"), join(pack, "dist", "INTER-OFL.txt"));
