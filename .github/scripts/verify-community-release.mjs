#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function fail(message) {
  throw new Error(message);
}

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) fail(`${name} is required`);
  return value;
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

function regularFile(path, label, maximumBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file`);
  if (stat.size <= 0 || stat.size > maximumBytes) fail(`${label} has an invalid size`);
  return stat;
}

function requiredText(value, label, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

try {
  const directory = resolve(option("--artifact"));
  const revision = requiredText(option("--revision"), "revision", /^[0-9a-f]{40}$/);
  const expectedCatalogDigest = option("--catalog-sha256", false);
  if (expectedCatalogDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedCatalogDigest)) {
    fail("--catalog-sha256 must be a lowercase SHA-256 digest");
  }

  const catalogPath = join(directory, "catalog.json");
  regularFile(catalogPath, "community release catalog", 4 * 1024 * 1024);
  const catalogBytes = readFileSync(catalogPath);
  const catalogDigest = digest("sha256", catalogBytes);
  if (expectedCatalogDigest !== undefined && catalogDigest !== expectedCatalogDigest) {
    fail(`catalog digest ${catalogDigest} does not match dispatched digest ${expectedCatalogDigest}`);
  }
  const catalog = JSON.parse(catalogBytes);
  if (catalog.schemaVersion !== 1) fail("community release schema version is unsupported");
  if (
    !/^https:\/\/github\.com\/firedrill-tools\/firedrill-community-tools(?:\.git)?$/.test(
      catalog.sourceRepository,
    )
  ) {
    fail("community release source repository is unexpected");
  }
  if (catalog.sourceRevision !== revision) fail("community release revision does not match the request");
  if (!Array.isArray(catalog.packages) || catalog.packages.length === 0 || catalog.packages.length > 100) {
    fail("community release package list is invalid");
  }

  const expectedFiles = new Set(["catalog.json"]);
  const packageNames = new Set();
  const packageIdentities = new Set();
  const toolIdentities = new Set();
  const archives = new Set();
  let totalArchiveBytes = 0;
  for (const item of catalog.packages) {
    if (!item || typeof item !== "object") fail("community release package record is invalid");
    const name = requiredText(item.name, "package name", /^@firedrill-community\/tool-[a-z0-9-]+$/);
    const version = requiredText(item.version, `${name} version`, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    const tool = requiredText(item.tool, `${name} Tool id`, /^[a-z0-9][a-z0-9-]*$/);
    const lifecycle = requiredText(item.lifecycle, `${name} lifecycle`, /^(active|deprecated|revoked)$/);
    requiredText(item.sourceSubdirectory, `${name} source directory`, /^packages\/[a-z0-9-]+$/);
    requiredText(item.definition, `${name} definition`, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
    requiredText(item.engines?.node, `${name} Node engine`);
    requiredText(item.engines?.firedrill, `${name} Firedrill engine`);
    const packageIdentity = `${name}@${version}`;
    if (packageNames.has(name)) fail(`duplicate package name ${name}`);
    if (packageIdentities.has(packageIdentity)) fail(`duplicate package identity ${packageIdentity}`);
    if (toolIdentities.has(tool)) fail(`duplicate Tool identity ${tool}`);
    packageNames.add(name);
    packageIdentities.add(packageIdentity);
    toolIdentities.add(tool);

    if (lifecycle === "revoked") {
      for (const field of ["archive", "size", "sha256", "sha512"]) {
        if (item[field] !== undefined) fail(`${packageIdentity} revoked tombstone must not carry ${field}`);
      }
      continue;
    }

    const archive = requiredText(item.archive, `${packageIdentity} archive`, /^[a-zA-Z0-9._-]+\.tgz$/);
    if (basename(archive) !== archive) fail(`${packageIdentity} archive path is unsafe`);
    if (archives.has(archive)) fail(`duplicate archive ${archive}`);
    archives.add(archive);
    if (!Number.isSafeInteger(item.size) || item.size <= 0)
      fail(`${packageIdentity} archive size is invalid`);
    requiredText(item.sha256, `${packageIdentity} SHA-256`, /^[0-9a-f]{64}$/);
    requiredText(item.sha512, `${packageIdentity} SHA-512`, /^[0-9a-f]{128}$/);
    const archivePath = join(directory, archive);
    regularFile(archivePath, `${packageIdentity} archive`, 64 * 1024 * 1024);
    totalArchiveBytes += item.size;
    if (totalArchiveBytes > 512 * 1024 * 1024) fail("community release archives exceed the size limit");
    const archiveBytes = readFileSync(archivePath);
    if (archiveBytes.length !== item.size) fail(`${archive} size does not match catalog.json`);
    if (digest("sha256", archiveBytes) !== item.sha256)
      fail(`${archive} SHA-256 does not match catalog.json`);
    if (digest("sha512", archiveBytes) !== item.sha512)
      fail(`${archive} SHA-512 does not match catalog.json`);
    expectedFiles.add(archive);
  }

  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) fail("community release contains a non-file entry");
  const actualFiles = new Set(entries.map((entry) => entry.name));
  if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((file) => !expectedFiles.has(file))) {
    fail("community release files do not exactly match catalog.json");
  }
  process.stdout.write(
    `verified ${catalog.packages.length} community Tool record(s) from ${revision}; catalog sha256 ${catalogDigest}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
