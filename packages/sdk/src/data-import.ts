import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  compileWorld,
  ProjectConfigSchema,
  previewScenarioSource,
  type ScenarioSourceSchema,
} from "@firedrill-tools/compiler";
import {
  canonicalJson,
  type DataImportPlanInput,
  DataImportPlanSchema,
  type JsonObject,
  type JsonValue,
} from "@firedrill-tools/contracts";
import { FiredrillProjectError } from "./project-error.js";

const MAX_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8 * MAX_BYTES;
const SECRET_FIELD = /(?:password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface DataImportPreview {
  readonly schemaVersion: 1;
  readonly previewHash: string;
  readonly buildHash: string;
  readonly scenario: ReturnType<typeof ScenarioSourceSchema.parse>;
  readonly source: { readonly kind: "json" | "http"; readonly pages: number; readonly recordsRead: number };
  readonly recordCount: number;
  readonly redactedFields: number;
  readonly warnings: readonly string[];
  readonly runtimeChanged: false;
}

export interface PreviewDataImportOptions {
  readonly root?: string;
  readonly plan: DataImportPlanInput;
  /** Required even for local files: importing existing data is always deliberate. */
  readonly consent: "read-selected-source";
  /** Exact HTTP origin the user reviewed, required for HTTP sources. */
  readonly allowedOrigin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

function fail(message: string): never {
  throw new FiredrillProjectError("framework.DATA_IMPORT_INVALID", message);
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue))
    .digest("hex")}`;
}
function parts(pointer: string): string[] {
  const result =
    pointer === ""
      ? []
      : pointer
          .slice(1)
          .split("/")
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (result.some((part) => FORBIDDEN_KEYS.has(part))) fail("Prototype paths cannot be imported.");
  return result;
}
function at(value: unknown, pointer: string): unknown {
  let current = value;
  for (const key of parts(pointer)) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function replace(value: JsonObject, path: string, replacement: JsonValue): boolean {
  const keys = parts(path);
  if (keys.length === 0) fail("Redaction must select a field, not replace the whole record.");
  let current: JsonValue = value;
  for (const key of keys.slice(0, -1)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
    current = (current as JsonObject)[key] as JsonValue;
  }
  const last = keys.at(-1) as string;
  if (current === null || typeof current !== "object" || !Object.hasOwn(current, last)) return false;
  (current as JsonObject)[last] = structuredClone(replacement);
  return true;
}

function redact(value: JsonValue, explicitSecrets: readonly string[]): { value: JsonValue; count: number } {
  if (typeof value === "string") {
    let output = value;
    for (const secret of explicitSecrets)
      if (secret.length > 0 && output.includes(secret)) output = output.replaceAll(secret, "[REDACTED]");
    return { value: output, count: Number(output !== value) };
  }
  if (value === null || typeof value !== "object") return { value, count: 0 };
  let count = 0;
  if (Array.isArray(value)) {
    const output = value.map((item) => {
      const redacted = redact(item, explicitSecrets);
      count += redacted.count;
      return redacted.value;
    });
    return { value: output, count };
  }
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail("Prototype keys cannot be imported.");
    if (SECRET_FIELD.test(key)) {
      output[key] = "[REDACTED]";
      count++;
    } else {
      const redacted = redact(item, explicitSecrets);
      count += redacted.count;
      output[key] = redacted.value;
    }
  }
  return { value: output, count };
}

/** Real directory walk: never follow a source/destination symlink. */
function contained(root: string, path: string, createParents = false): string {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
    fail("Import files must stay inside the selected project.");
  let current = root;
  for (const [index, part] of rel.split(/[\\/]/).entries()) {
    current = join(current, part);
    const last = index === rel.split(/[\\/]/).length - 1;
    if (!existsSync(current)) {
      // lstat also detects dangling symlinks, which existsSync cannot.
      try {
        lstatSync(current);
        fail("Import paths must not contain symlinks.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (createParents && !last) mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory()))
      fail("Import paths must contain only real project directories and files.");
  }
  return resolved;
}

function readJson(root: string, path: string, maximum: number): unknown {
  if (
    path
      .split(/[\\/]/)
      .some(
        (part) =>
          part === ".git" ||
          part === "node_modules" ||
          part === ".env" ||
          part.startsWith(".env.") ||
          /\.(pem|key)$/i.test(part),
      )
  )
    fail("Credential, Git, and dependency files cannot be imported.");
  const absolute = contained(root, path);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return fail("The selected JSON file is unavailable.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      fail("The selected JSON file exceeds its size limit or is not a file.");
    try {
      return JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      return fail("The selected file is not valid JSON.");
    }
  } finally {
    closeSync(fd);
  }
}

function sourceUrl(value: string, allowedOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("The source URL is invalid.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== allowedOrigin ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  )
    fail(
      "Import requires the exact approved origin, HTTPS (except loopback), and no URL credentials or fragment.",
    );
  if (
    url.hostname === "metadata.google.internal" ||
    /^169\.254\./.test(url.hostname) ||
    /\b(?:metadata|instance-data)\b/.test(url.hostname)
  )
    fail("Cloud metadata services cannot be imported.");
  if ([...url.searchParams.keys()].some((key) => SECRET_FIELD.test(key)))
    fail("Put source credentials in explicitly mapped headers, not the URL.");
  return url;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    fail(`Source returned HTTP ${response.status}; no data was saved.`);
  }
  if (!response.body) fail("Source response has no JSON body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail("Source response exceeds 8 MiB; select a smaller source page.");
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return fail("Source did not return valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Reads only the selected source. Raw provider responses/credentials are never written to disk. */
export async function previewDataImport(options: PreviewDataImportOptions): Promise<DataImportPreview> {
  if (options.consent !== "read-selected-source")
    fail("Approve reading the selected source before importing data.");
  const parsed = DataImportPlanSchema.safeParse(options.plan);
  if (!parsed.success)
    fail(
      `Invalid import plan: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const plan = parsed.data;
  if (Object.keys(plan.fields).some((field) => FORBIDDEN_KEYS.has(field)))
    fail("Prototype fields cannot be imported.");
  for (const pointer of [
    plan.recordsPointer,
    plan.idPointer,
    ...Object.values(plan.fields),
    ...plan.redactions.map((item) => item.path),
  ])
    parts(pointer);
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
  if (compiled.status !== "success")
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "Fix world source before importing data.", {
      diagnostics: compiled.diagnostics,
    });
  if (compiled.build.worldIr.scenarios.some((item) => item.id === plan.id))
    fail("Choose a new scenario id; import never overwrites an existing scenario.");
  const declared = compiled.build.worldIr.tools.find((tool) => tool.id === plan.packageId);
  if (!declared?.state.some((item) => item.namespace === plan.namespace))
    fail("Select a Tool and state namespace declared in this world.");
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  const headers: Record<string, string> = { accept: "application/json" };
  const secrets: string[] = [];
  if (plan.source.kind === "http") {
    for (const [name, environmentName] of Object.entries(plan.source.headersFromEnvironment)) {
      if (
        [
          "host",
          "connection",
          "content-length",
          "transfer-encoding",
          "proxy-authorization",
          "cookie",
        ].includes(name.toLowerCase())
      )
        fail("This source header is not permitted.");
      const value = (options.environment ?? process.env)[environmentName];
      if (!value || /[\r\n]/.test(value))
        fail(`Set ${environmentName} to a valid source credential before importing.`);
      headers[name] = value;
      secrets.push(value, value.replace(/^Bearer\s+/i, ""));
    }
  }
  let url = plan.source.kind === "http" ? sourceUrl(plan.source.url, options.allowedOrigin ?? "") : undefined;
  const visited = new Set<string>();
  const identities = new Set<string>();
  const rows: ReturnType<typeof ScenarioSourceSchema.parse>["state"] = [];
  let pages = 0;
  let recordsRead = 0;
  let redactedFields = 0;
  let totalBytes = 0;
  for (;;) {
    signal.throwIfAborted();
    if (pages >= plan.maxPages)
      fail(
        "Source has more pages than maxPages; narrow the source or raise the explicit limit. No partial import was saved.",
      );
    let body: unknown;
    if (plan.source.kind === "json") body = readJson(root, plan.source.path, MAX_RESPONSE_BYTES);
    else {
      if (url === undefined || visited.has(url.href)) fail("Source pagination repeated a page.");
      visited.add(url.href);
      try {
        body = await responseJson(
          await fetch(url, { method: "GET", headers, redirect: "error", signal }),
          signal,
        );
      } catch (error) {
        if (error instanceof FiredrillProjectError) throw error;
        return fail(
          signal.aborted
            ? "Import cancelled or timed out; no data was saved."
            : "Source request failed; redirects are not followed and no data was saved.",
        );
      }
    }
    pages++;
    totalBytes += Buffer.byteLength(JSON.stringify(body));
    if (totalBytes > 16 * MAX_BYTES) fail("Import exceeds 16 MiB; narrow the source selection.");
    const records = at(body, plan.recordsPointer);
    if (!Array.isArray(records)) fail("recordsPointer must select a JSON array.");
    for (const record of records) {
      recordsRead++;
      if (recordsRead > plan.maxRecords)
        fail(
          "Source exceeds maxRecords; narrow the source or raise the explicit limit. No partial import was saved.",
        );
      const id = at(record, plan.idPointer);
      if (typeof id !== "string" || id.length < 1 || id.length > 512)
        fail("Every imported row needs a string id of 1–512 characters.");
      if (plan.selectIds && !plan.selectIds.includes(id)) continue;
      if (identities.has(id)) fail("Source returned duplicate selected record ids.");
      identities.add(id);
      if (secrets.some((secret) => secret.length > 0 && id.includes(secret)))
        fail("A record id contains a source credential and cannot be imported.");
      const value: JsonObject = {};
      for (const [field, pointer] of Object.entries(plan.fields)) {
        const selected = at(record, pointer);
        if (selected === undefined)
          fail(`Selected field ${field} is missing from a record; review the mapping.`);
        value[field] = structuredClone(selected) as JsonValue;
      }
      for (const redaction of plan.redactions)
        if (replace(value, redaction.path, redaction.replacement)) redactedFields++;
      const sanitized = redact(value, secrets);
      redactedFields += sanitized.count;
      rows.push({
        action: "upsert",
        packageId: plan.packageId,
        namespace: plan.namespace,
        rowId: id,
        value: sanitized.value as JsonObject,
      });
    }
    if (plan.source.kind === "json" || !plan.source.pagination) break;
    const next = at(body, plan.source.pagination.nextPointer);
    if (next === undefined || next === null || next === "") break;
    if (typeof next !== "string") fail("The pagination cursor or next URL must be a string.");
    if (plan.source.pagination.cursorParameter) {
      url = sourceUrl(plan.source.url, options.allowedOrigin ?? "");
      url.searchParams.set(plan.source.pagination.cursorParameter, next);
    } else {
      url = sourceUrl(new URL(next, url).href, options.allowedOrigin ?? "");
    }
  }
  if (rows.length === 0) fail("No selected records were found; adjust the selection before saving.");
  if (plan.selectIds?.some((id) => !identities.has(id)))
    fail("Some selected record ids were not returned; no partial selection was saved.");
  const checked = previewScenarioSource(compiled.build.worldIr, {
    schemaVersion: 1,
    id: plan.id,
    ...(plan.title ? { title: plan.title } : {}),
    state: rows,
  });
  if (checked.status !== "success")
    fail(
      `Imported data does not match the Tool schema: ${checked.issues
        .slice(0, 10)
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  if (Buffer.byteLength(JSON.stringify(checked.source, null, 2)) + 1 > MAX_BYTES)
    fail("Generated scenario exceeds the 1 MiB source limit; select fewer records or fields.");
  const content = {
    schemaVersion: 1 as const,
    buildHash: compiled.build.manifest.buildHash,
    scenario: checked.source,
    source: { kind: plan.source.kind, pages, recordsRead },
    recordCount: rows.length,
    redactedFields,
    warnings: [
      "Imported data can contain personal or confidential information. Review every selected field before saving or sharing.",
      "This creates scenario seed data; it does not update the running world or delete unselected baseline records.",
    ],
    runtimeChanged: false as const,
  };
  return { ...content, previewHash: digest(content) };
}

/** Saves the exact reviewed, sanitized proposal. Never refetches a provider or overwrites source. */
export async function saveDataImport(options: {
  readonly root?: string;
  readonly preview: DataImportPreview;
  readonly expectedPreviewHash: string;
  readonly confirm: "save-reviewed-data";
}) {
  if (options.confirm !== "save-reviewed-data") fail("Confirm saving the reviewed data first.");
  const { previewHash, ...content } = options.preview;
  if (previewHash !== options.expectedPreviewHash || previewHash !== digest(content as unknown as JsonValue))
    fail("The import preview changed; review it again before saving.");
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
  if (compiled.status !== "success")
    throw new FiredrillProjectError(
      "framework.SOURCE_INVALID",
      "Fix repository source before saving imported data.",
      { diagnostics: compiled.diagnostics },
    );
  if (compiled.build.manifest.buildHash !== content.buildHash)
    fail("World source changed after the preview; import and review again.");
  const checked = previewScenarioSource(compiled.build.worldIr, content.scenario);
  if (checked.status !== "success") fail("The reviewed scenario no longer passes source validation.");
  if (compiled.build.worldIr.scenarios.some((item) => item.id === checked.source.id))
    fail("This scenario id already exists; choose a new id.");
  const text = `${JSON.stringify(checked.source, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) fail("Generated scenario exceeds the source-file size limit.");
  const config = ProjectConfigSchema.parse(readJson(root, "firedrill.json", MAX_BYTES));
  const path = contained(
    root,
    join(config.sourceRoot, "scenarios", `${checked.source.id}.scenario.json`),
    true,
  );
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return fail("The scenario destination exists or is not writable; no source was replaced.");
  }
  try {
    writeFileSync(fd, text);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
  return {
    id: checked.source.id,
    path: relative(root, path).split("\\").join("/"),
    previewHash,
    recordCount: content.recordCount,
    runtimeChanged: false as const,
  };
}

/** Used by CLI to retain only the reviewed redacted preview, never raw responses. */
export function storeDataImportPreview(root: string, preview: DataImportPreview): string {
  root = realpathSync(root);
  const path = contained(root, join(".firedrill", "imports", `${preview.previewHash.slice(7)}.json`), true);
  const text = `${JSON.stringify(preview, null, 2)}\n`;
  if (existsSync(path)) {
    if (
      canonicalJson(readJson(root, relative(root, path), 2 * MAX_BYTES) as JsonValue) !==
      canonicalJson(preview as unknown as JsonValue)
    )
      fail("Stored preview does not match its hash.");
    return relative(root, path);
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
  return relative(root, path);
}

export function loadDataImportPreview(root: string, path: string): DataImportPreview {
  const value = readJson(realpathSync(root), path, 2 * MAX_BYTES);
  if (
    typeof value !== "object" ||
    value === null ||
    !("previewHash" in value) ||
    typeof value.previewHash !== "string"
  )
    fail("The selected file is not an import preview.");
  return value as DataImportPreview;
}

/** Read a bounded, project-contained plan without exposing raw syntax errors or secret files. */
export function loadDataImportPlan(root: string, path: string): DataImportPlanInput {
  const parsed = DataImportPlanSchema.safeParse(readJson(realpathSync(root), path, MAX_BYTES));
  if (!parsed.success)
    fail("The selected import plan is invalid. Check firedrill data --help and the import-plan schema.");
  return parsed.data;
}
