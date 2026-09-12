import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { bundledToolIndex, catalogMatches, inspectCatalogEntry, type ReadyTool } from "./tool-catalog.js";
import { type ToolIndex, ToolIndexSchema, type ToolIndexSource } from "./tool-index-schema.js";

export type { ToolIndex, ToolIndexEntry, ToolIndexSource } from "./tool-index-schema.js";
export { ToolIndexEntrySchema, ToolIndexSchema, ToolIndexSourceSchema } from "./tool-index-schema.js";

export const TOOL_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const TOOL_INDEX_TIMEOUT_MS = 10_000;

export class ToolDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolDiscoveryError";
  }
}

export interface ToolDiscoverySource {
  readonly kind: "bundled" | "file" | "https" | "loopback";
  readonly location: string;
}

export interface DiscoveredTool extends ReadyTool {
  readonly title: string;
  readonly source: ToolIndexSource;
  readonly installSource: string;
  /** Origin of operation/limitation metadata; titles and descriptions remain index claims. */
  readonly metadataOrigin: "publisher" | "installed-declaration";
  readonly indexSource: ToolDiscoverySource;
}

export interface DiscoverToolsOptions {
  readonly root: string;
  readonly query?: string;
  /** Explicit local path or HTTPS URL. Omission reads only the bundled index. */
  readonly index?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ResolveDiscoveredToolOptions {
  readonly root: string;
  readonly selector: string;
  readonly index?: string;
  readonly signal?: AbortSignal;
}

export interface ToolDiscoveryResult {
  readonly schemaVersion: 1;
  readonly source: ToolDiscoverySource;
  readonly tools: readonly DiscoveredTool[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ToolDiscoveryError("framework.TOOL_INDEX_CANCELLED", "Tool discovery was cancelled.");
  }
}

function parseIndex(body: string): ToolIndex {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new ToolDiscoveryError("framework.TOOL_INDEX_INVALID", "The Tool index must be a JSON document.");
  }
  const result = ToolIndexSchema.safeParse(document);
  if (!result.success) {
    const paths = result.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "root");
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_INVALID",
      `The Tool index does not match schema version 1. Check: ${paths.join(", ")}.`,
    );
  }
  return result.data;
}

function tooLarge(): ToolDiscoveryError {
  return new ToolDiscoveryError(
    "framework.TOOL_INDEX_TOO_LARGE",
    "The Tool index exceeds the 2 MiB limit. Use a smaller index.",
  );
}

async function localIndex(path: string, signal: AbortSignal | undefined): Promise<ToolIndex> {
  checkCancelled(signal);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new ToolDiscoveryError(
        "framework.TOOL_INDEX_READ_FAILED",
        "The Tool index must be a regular file.",
      );
    }
    if (stat.size > TOOL_INDEX_MAX_BYTES) throw tooLarge();
    // Bounded read remains bounded if the file grows after fstat.
    const buffer = Buffer.alloc(TOOL_INDEX_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      checkCancelled(signal);
      const read = await file.read(buffer, length, buffer.byteLength - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > TOOL_INDEX_MAX_BYTES) throw tooLarge();
    return parseIndex(buffer.subarray(0, length).toString("utf8"));
  } catch (error) {
    if (error instanceof ToolDiscoveryError) throw error;
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_READ_FAILED",
      "Cannot read the Tool index. Check the explicit file path and its permissions.",
    );
  } finally {
    await file?.close();
  }
}

function indexUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolDiscoveryError("framework.TOOL_INDEX_URL_INVALID", "The Tool index URL is invalid.");
  }
  const isLoopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_URL_INVALID",
      "Use an HTTPS index URL without credentials, query, or fragment; local HTTP must use a loopback host. For a private authenticated index, download it yourself and use its local path.",
    );
  }
  return url;
}

async function remoteIndex(url: URL, signal: AbortSignal | undefined): Promise<ToolIndex> {
  checkCancelled(signal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOOL_INDEX_TIMEOUT_MS);
  timer.unref();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ToolDiscoveryError(
        "framework.TOOL_INDEX_REDIRECT",
        "The Tool index redirected. Review the destination and pass its URL explicitly.",
      );
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ToolDiscoveryError(
        "framework.TOOL_INDEX_READ_FAILED",
        `The Tool index returned HTTP ${response.status}. Check its availability or use a downloaded local index.`,
      );
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > TOOL_INDEX_MAX_BYTES) {
      await response.body.cancel();
      throw tooLarge();
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > TOOL_INDEX_MAX_BYTES) throw tooLarge();
      chunks.push(part.value);
    }
    checkCancelled(signal);
    return parseIndex(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch (error) {
    checkCancelled(signal);
    if (timedOut) {
      throw new ToolDiscoveryError(
        "framework.TOOL_INDEX_TIMEOUT",
        "The Tool index did not finish loading within 10 seconds. Retry or use a downloaded local index.",
      );
    }
    if (error instanceof ToolDiscoveryError) throw error;
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_READ_FAILED",
      "Cannot fetch the Tool index. Check the URL and network, or use a downloaded local index.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

function installSource(packageName: string, version: string, source: ToolIndexSource): string {
  if (source.kind === "npm") return `${packageName}@${version}`;
  const subdirectory = source.subdirectory === undefined ? "" : `::${source.subdirectory}`;
  return `git+${source.url}#${source.commit}${subdirectory}`;
}

function checkIndexOption(index: string | undefined): void {
  if (index !== undefined && (index.length === 0 || index.length > 4096)) {
    throw new ToolDiscoveryError(
      "framework.TOOL_DISCOVERY_OPTIONS_INVALID",
      "Use a nonempty index path or URL up to 4,096 characters.",
    );
  }
}

async function loadIndex(options: Pick<DiscoverToolsOptions, "root" | "index" | "signal">): Promise<{
  readonly index: ToolIndex;
  readonly source: ToolDiscoverySource;
}> {
  checkIndexOption(options.index);
  checkCancelled(options.signal);
  if (options.index === undefined) {
    try {
      const bundled = bundledToolIndex();
      return { index: bundled.index, source: { kind: "bundled", location: bundled.path } };
    } catch {
      throw new ToolDiscoveryError(
        "framework.TOOL_INDEX_INVALID",
        "The bundled Tool index is missing or invalid. Reinstall the CLI or provide a reviewed external index.",
      );
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(options.index)) {
    const url = indexUrl(options.index);
    const index = await remoteIndex(url, options.signal);
    return { index, source: { kind: url.protocol === "https:" ? "https" : "loopback", location: url.href } };
  }
  const path = resolve(options.root, options.index);
  return { index: await localIndex(path, options.signal), source: { kind: "file", location: path } };
}

function discoveredTool(
  root: string,
  entry: ToolIndex["packages"][number],
  source: ToolDiscoverySource,
): DiscoveredTool {
  const tool = inspectCatalogEntry(root, entry);
  const packageSource = entry.source ?? { kind: "npm" as const };
  return {
    ...tool,
    title: entry.title ?? entry.tool.id,
    source: packageSource,
    installSource: installSource(entry.packageName, entry.packageVersion, packageSource),
    metadataOrigin: tool.installed ? "installed-declaration" : "publisher",
    indexSource: source,
  };
}

/** Resolve one exact selection across the complete bounded index, not just a visible search page. */
export async function resolveDiscoveredTool(
  options: ResolveDiscoveredToolOptions,
): Promise<DiscoveredTool | undefined> {
  if (options.selector.length === 0 || options.selector.length > 4096) {
    throw new ToolDiscoveryError(
      "framework.TOOL_DISCOVERY_OPTIONS_INVALID",
      "Use a nonempty Tool ID, package name, exact package version, or installSource up to 4,096 characters.",
    );
  }
  const { index, source } = await loadIndex(options);
  checkCancelled(options.signal);
  const matches = index.packages.filter((entry) =>
    [
      entry.tool.id,
      entry.packageName,
      `${entry.packageName}@${entry.packageVersion}`,
      installSource(entry.packageName, entry.packageVersion, entry.source ?? { kind: "npm" }),
    ].includes(options.selector),
  );
  const active = matches.filter((entry) => entry.lifecycle === "active");
  if (active.length > 1) {
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_AMBIGUOUS",
      `The index contains multiple matching Tools or versions. Choose an exact package version: ${active
        .slice(0, 5)
        .map((entry) => `${entry.packageName}@${entry.packageVersion}`)
        .join(", ")}.`,
    );
  }
  const selected = active[0];
  if (selected === undefined && matches.length > 0) {
    throw new ToolDiscoveryError(
      "framework.TOOL_INDEX_ENTRY_UNAVAILABLE",
      "The matching index entry is deprecated or revoked. Choose an active package version from the index.",
    );
  }
  return selected === undefined ? undefined : discoveredTool(options.root, selected, source);
}

/** Read metadata only. No installation, executable imports, telemetry, or credentials are sent. */
export async function discoverTools(options: DiscoverToolsOptions): Promise<ToolDiscoveryResult> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 25;
  const query = options.query ?? "";
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    query.length > 500
  ) {
    throw new ToolDiscoveryError(
      "framework.TOOL_DISCOVERY_OPTIONS_INVALID",
      "Use a nonnegative offset, a limit from 1 to 100, a query up to 500 characters, and a nonempty index path or URL.",
    );
  }
  const { index, source } = await loadIndex(options);
  checkCancelled(options.signal);
  const matching = index.packages.filter(
    (entry) => entry.lifecycle === "active" && catalogMatches(entry, query),
  );
  // Stable index ordering plus explicit pagination; unrelated package declarations are not inspected.
  const tools = matching
    .slice(offset, offset + limit)
    .map((entry) => discoveredTool(options.root, entry, source));
  return { schemaVersion: 1, source, tools, total: matching.length, offset, limit };
}
