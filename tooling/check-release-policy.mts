import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly engines?: { readonly node?: string };
  readonly bin?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly type?: string; readonly url?: string; readonly directory?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const root = resolve(import.meta.dirname, "..");
const expectedRepository = "git+https://github.com/firedrill-tools/firedrill.git";
const expectedHomepage = "https://firedrill.tools";
const expectedBugs = "https://github.com/firedrill-tools/firedrill/issues";
const expectedNode = ">=20.19";
const violations: string[] = [];

function manifestAt(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

const rootManifest = manifestAt(join(root, "package.json"));
const frameworkVersion = rootManifest.version;
if (rootManifest.name !== "firedrill" || rootManifest.private !== true) {
  violations.push("the workspace root must remain the private firedrill package");
}
if (!frameworkVersion || !/^0\.1\.0-rc\.[1-9][0-9]*$/.test(frameworkVersion)) {
  violations.push(
    `workspace version must be a 0.1.0 release candidate; found ${frameworkVersion ?? "missing"}`,
  );
}

const engineSource = readFileSync(join(root, "packages", "contracts", "src", "engine.ts"), "utf8");
const declaredFrameworkVersion = engineSource.match(/FIREDRILL_FRAMEWORK_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (declaredFrameworkVersion !== frameworkVersion) {
  violations.push(
    `contracts framework version ${declaredFrameworkVersion ?? "missing"} differs from release train ${frameworkVersion}`,
  );
}

const packageGroups = ["packages", "tool-packs"] as const;
const publicPackages: Array<{ readonly path: string; readonly manifest: PackageManifest }> = [];
for (const group of packageGroups) {
  const groupRoot = join(root, group);
  for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(groupRoot, entry.name, "package.json");
    if (!existsSync(path)) continue;
    const manifest = manifestAt(path);
    if (manifest.private !== true && manifest.publishConfig?.access === "public") {
      publicPackages.push({ path, manifest });
    }
  }
}

const publicNames = new Set(publicPackages.flatMap(({ manifest }) => (manifest.name ? [manifest.name] : [])));
for (const { path, manifest } of publicPackages) {
  const label = relative(root, path);
  if (!manifest.name?.startsWith("@firedrill/"))
    violations.push(`${label}: package name must use @firedrill`);
  if (!manifest.description?.trim()) violations.push(`${label}: description is required`);
  if (manifest.license !== "Apache-2.0") violations.push(`${label}: license must be Apache-2.0`);
  if (manifest.engines?.node !== expectedNode) {
    violations.push(`${label}: Node engine must be ${expectedNode}`);
  }
  if (manifest.repository?.type !== "git" || manifest.repository.url !== expectedRepository) {
    violations.push(`${label}: repository metadata is not canonical`);
  }
  if (!manifest.repository?.directory || !label.startsWith(`${manifest.repository.directory}/`)) {
    violations.push(`${label}: repository.directory does not own the package`);
  }
  if (manifest.homepage !== expectedHomepage)
    violations.push(`${label}: homepage must be ${expectedHomepage}`);
  if (manifest.bugs?.url !== expectedBugs) violations.push(`${label}: bugs URL must be ${expectedBugs}`);

  const isFrameworkPackage = label.startsWith("packages/");
  if (isFrameworkPackage && manifest.version !== frameworkVersion) {
    violations.push(`${label}: framework package version must be ${frameworkVersion}`);
  }
  if (!manifest.version || manifest.version === "0.0.0") {
    violations.push(`${label}: placeholder version is not releasable`);
  }

  for (const dependencies of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      if (publicNames.has(name) && range !== "workspace:*") {
        violations.push(`${label}: internal dependency ${name} must use workspace:* in source`);
      }
    }
  }
}

const cli = publicPackages.find(({ manifest }) => manifest.name === "@firedrill/cli")?.manifest;
if (cli?.bin?.firedrill !== "./dist/bin.js") {
  violations.push("@firedrill/cli must expose the firedrill executable at ./dist/bin.js");
}

for (const group of ["packages"] as const) {
  const sourceRoot = join(root, group);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["dist", "node_modules", "test"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && /["']0\.0\.0["']/.test(readFileSync(path, "utf8"))) {
        violations.push(`${relative(root, path)}: placeholder runtime version is not allowed`);
      }
    }
  };
  visit(sourceRoot);
}

if (violations.length > 0) {
  process.stderr.write(`${violations.sort().join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `release policy passed for ${publicPackages.length} public package(s) at framework ${frameworkVersion}\n`,
);
