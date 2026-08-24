import { resolve } from "node:path";
import { packPublicPackages } from "./public-packages.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputFlag = process.argv.indexOf("--output");
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
if (!output) {
  process.stderr.write("Usage: pnpm pack:artifacts -- --output <empty-directory>\n");
  process.exitCode = 2;
} else {
  const packages = packPublicPackages({ repositoryRoot, outputDirectory: output });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, outputDirectory: resolve(output), packages }, null, 2)}\n`,
  );
}
