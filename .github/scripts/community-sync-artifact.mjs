import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowedFiles = ["registry/README.md", "registry/index.json"];
const maximumFileBytes = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

function option(name) {
  return optionalOption(name) ?? fail(`${name} requires a value`);
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function exactRevision(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("revision must be an exact 40-character Git commit");
  return value;
}

function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`sync artifact file is not regular: ${path}`);
  if (stat.size > maximumFileBytes) fail(`sync artifact file is too large: ${path}`);
  return stat;
}

function readIndex(path, revision) {
  const index = JSON.parse(readFileSync(path, "utf8"));
  if (index?.sourceRevision !== revision) fail("registry sourceRevision does not match the sync revision");
}

function prepare(root, artifact, revision) {
  if (existsSync(artifact)) fail(`artifact destination already exists: ${artifact}`);
  const files = allowedFiles.map((relativePath) => {
    const source = join(root, relativePath);
    const stat = regularFile(source);
    const contents = readFileSync(source);
    const destination = join(artifact, "payload", relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return { path: relativePath, bytes: stat.size, sha256: digest(contents) };
  });
  readIndex(join(root, "registry", "index.json"), revision);
  writeFileSync(
    join(artifact, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceRevision: revision, files }, null, 2)}\n`,
  );
}

function verifiedManifest(artifact, revision) {
  const manifestPath = join(artifact, "manifest.json");
  regularFile(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest.sourceRevision !== revision) {
    fail("sync artifact manifest does not match the requested revision");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== allowedFiles.length) {
    fail("sync artifact manifest has an invalid file list");
  }
  const byPath = new Map(manifest.files.map((file) => [file?.path, file]));
  if (byPath.size !== allowedFiles.length || allowedFiles.some((path) => !byPath.has(path))) {
    fail("sync artifact manifest contains an unexpected path");
  }
  for (const relativePath of allowedFiles) {
    const record = byPath.get(relativePath);
    if (
      typeof record?.bytes !== "number" ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(record?.sha256 ?? "")
    ) {
      fail(`sync artifact manifest entry is invalid: ${relativePath}`);
    }
    const payload = join(artifact, "payload", relativePath);
    const stat = regularFile(payload);
    const contents = readFileSync(payload);
    if (stat.size !== record.bytes || digest(contents) !== record.sha256) {
      fail(`sync artifact payload does not match its manifest: ${relativePath}`);
    }
  }
  readIndex(join(artifact, "payload", "registry", "index.json"), revision);
}

function apply(root, artifact, revision) {
  verifiedManifest(artifact, revision);
  for (const relativePath of allowedFiles) {
    const destination = join(root, relativePath);
    const temporary = `${destination}.community-sync-${process.pid}`;
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(temporary, { force: true });
    copyFileSync(join(artifact, "payload", relativePath), temporary);
    renameSync(temporary, destination);
  }
}

const mode = process.argv[2];
const root = resolve(optionalOption("--root") ?? defaultRoot);
const artifact = resolve(option("--artifact"));
const revision = exactRevision(option("--revision"));

if (mode === "prepare") prepare(root, artifact, revision);
else if (mode === "apply") apply(root, artifact, revision);
else fail("expected prepare or apply");
