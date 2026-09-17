import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly engines?: { readonly node?: string; readonly pnpm?: string };
  readonly packageManager?: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly type?: string; readonly url?: string; readonly directory?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly firedrill?: { readonly layer?: string };
}

interface PublicSurface {
  readonly schemaVersion: number;
  readonly node: string;
  readonly pnpm: string;
  readonly packageManager: string;
  readonly cli: {
    readonly package: string;
    readonly binary: string;
    readonly entrypoint: string;
    readonly helpCommands: readonly (readonly string[])[];
  };
  readonly packages: readonly {
    readonly name: string;
    readonly directory: string;
    readonly layer: string;
    readonly exports: readonly string[];
  }[];
}

const root = resolve(import.meta.dirname, "..");
const expectedRepository = "git+https://github.com/firedrill-tools/firedrill.git";
const expectedHomepage = "https://firedrill.run";
const expectedBugs = "https://github.com/firedrill-tools/firedrill/issues";
const expectedNode = ">=20.19";
const violations: string[] = [];

function manifestAt(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

const rootManifest = manifestAt(join(root, "package.json"));
const publicSurface = JSON.parse(
  readFileSync(join(root, "release", "public-surface.json"), "utf8"),
) as PublicSurface;
const frameworkVersion = rootManifest.version;
if (rootManifest.name !== "firedrill" || rootManifest.private !== true) {
  violations.push("the workspace root must remain the private firedrill package");
}
if (!frameworkVersion || !/^0\.1\.0-rc\.[1-9][0-9]*$/.test(frameworkVersion)) {
  violations.push(
    `workspace version must be a 0.1.0 release candidate; found ${frameworkVersion ?? "missing"}`,
  );
}
if (
  publicSurface.schemaVersion !== 1 ||
  publicSurface.node !== expectedNode ||
  publicSurface.pnpm !== rootManifest.engines?.pnpm ||
  publicSurface.packageManager !== rootManifest.packageManager
) {
  violations.push("release/public-surface.json does not match the root toolchain contract");
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
const declaredSurface = new Map(publicSurface.packages.map((package_) => [package_.name, package_]));
if (declaredSurface.size !== publicSurface.packages.length) {
  violations.push("release/public-surface.json contains duplicate package names");
}
const actualNames = [...publicNames].sort();
const declaredNames = [...declaredSurface.keys()].sort();
if (JSON.stringify(actualNames) !== JSON.stringify(declaredNames)) {
  violations.push("publishable package names differ from release/public-surface.json");
}
for (const { path, manifest } of publicPackages) {
  const label = relative(root, path).split(sep).join("/");
  if (!manifest.name?.startsWith("@firedrill-tools/"))
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

  const declared = manifest.name ? declaredSurface.get(manifest.name) : undefined;
  if (declared !== undefined) {
    const directory = label.replace(/\/package\.json$/, "");
    if (declared.directory !== directory) {
      violations.push(`${label}: package directory differs from the frozen public surface`);
    }
    if (declared.layer !== manifest.firedrill?.layer) {
      violations.push(`${label}: package layer differs from the frozen public surface`);
    }
    const actualExports = Object.keys(manifest.exports ?? {}).sort();
    const expectedExports = [...declared.exports].sort();
    if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
      violations.push(`${label}: export paths differ from the frozen public surface`);
    }
  }

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

const cli = publicPackages.find(({ manifest }) => manifest.name === "@firedrill-tools/cli")?.manifest;
if (
  publicSurface.cli.package !== "@firedrill-tools/cli" ||
  publicSurface.cli.binary !== "firedrill" ||
  cli?.bin?.[publicSurface.cli.binary] !== publicSurface.cli.entrypoint
) {
  violations.push("@firedrill-tools/cli does not match the frozen executable surface");
}
const helpInvocations = publicSurface.cli.helpCommands?.map((arguments_) => arguments_.join(" ")) ?? [];
if (
  helpInvocations.length === 0 ||
  helpInvocations[0] !== "" ||
  new Set(helpInvocations).size !== helpInvocations.length ||
  helpInvocations.some((invocation) => /(^|\s)-/.test(invocation))
) {
  violations.push(
    "release/public-surface.json must declare unique, positional CLI help commands with root first",
  );
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
