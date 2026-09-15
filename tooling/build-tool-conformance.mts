import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

// Maintained Tool packs can ship their exact client-based conformance target as
// one portable Node module, with third-party licenses beside the bundled code.
const workspace = resolve(import.meta.dirname, "..");
const root = resolve(process.cwd());
if (!/^tool-packs\/[a-z0-9-]+$/.test(relative(workspace, root).replaceAll("\\", "/")))
  throw new Error("Run the conformance build from a maintained Tool-pack directory.");
const requested = process.argv[2];
if (requested === undefined) throw new Error("Pass a package-relative conformance target entry point.");
const entry = resolve(root, requested);
const local = relative(root, entry);
if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
  throw new Error("Conformance entry must stay inside its package.");
const destination = join(root, "dist", "conformance");
mkdirSync(destination, { recursive: true });
const output = join(destination, "agent.mjs");
const result = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  metafile: true,
  legalComments: "inline",
  sourcemap: false,
});
const packages = new Map<string, string>();
for (const path of Object.keys(result.metafile.inputs)) {
  let directory = dirname(resolve(root, path));
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const metadata = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        version: string;
        license?: string;
      };
      if (directory !== root) {
        const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "license.txt"]
          .map((name) => join(directory, name))
          .find(existsSync);
        if (licenseFile === undefined)
          throw new Error(
            `Bundled dependency ${metadata.name} has no license file; review redistribution before bundling.`,
          );
        const notices = ["NOTICE", "NOTICE.txt", "NOTICE.md"]
          .map((name) => join(directory, name))
          .filter(existsSync)
          .map((path) => readFileSync(path, "utf8").trim());
        packages.set(
          `${metadata.name}@${metadata.version}`,
          `${metadata.name}@${metadata.version}\nLicense: ${metadata.license ?? "see text below"}\n\n${readFileSync(licenseFile, "utf8").trim()}\n${notices.length === 0 ? "" : `\n${notices.join("\n\n")}\n`}`,
        );
      }
      break;
    }
    if (dirname(directory) === directory)
      throw new Error(`Cannot identify package owner of conformance input ${path}`);
    directory = dirname(directory);
  }
}
writeFileSync(
  join(destination, "THIRD-PARTY-NOTICES.txt"),
  `Third-party code bundled for the optional Tool conformance target.\n\n${[...packages.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, notice]) => notice)
    .join("\n---\n\n")}`,
);
writeFileSync(
  join(destination, "dependencies.json"),
  `${JSON.stringify({ schemaVersion: 1, packages: [...packages.keys()].sort() }, null, 2)}\n`,
);
