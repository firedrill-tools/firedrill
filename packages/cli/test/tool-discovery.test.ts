import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readyTools } from "../src/tool-catalog.js";
import {
  discoverTools,
  resolveDiscoveredTool,
  TOOL_INDEX_MAX_BYTES,
  TOOL_INDEX_TIMEOUT_MS,
  ToolIndexSchema,
} from "../src/tool-discovery.js";
import { toolIndexJsonSchema } from "../src/tool-index-schema.js";
import { createTool } from "../src/tool-setup.js";

const directories: string[] = [];
const servers: Server[] = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-discovery-"));
  directories.push(root);
  return root;
}

function entry(name = "@independent/tool-records") {
  return {
    packageName: name,
    packageVersion: "1.2.3",
    title: "Synthetic records",
    description: "Independent stateful records with explicit limits.",
    lifecycle: "active",
    keywords: ["records"],
    tool: {
      id: "records",
      operations: [{ id: "records.get", fidelity: "stateful" }],
      compatibility: [{ limitations: ["Only the declared operations are supported."] }],
    },
  };
}

function indexFile(root: string, packages: unknown[] = [entry()]): string {
  const path = join(root, "tool-index.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, packages }));
  return path;
}

async function server(response: (response: ServerResponse) => void): Promise<string> {
  const instance = createServer((_request, outgoing) => response(outgoing));
  servers.push(instance);
  await new Promise<void>((resolveListen) => instance.listen(0, "127.0.0.1", resolveListen));
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}/index.json`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const instance of servers.splice(0)) {
    instance.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      instance.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent Tool discovery", () => {
  it("reads the bundled catalog without a network request and retains readyTools behavior", async () => {
    const root = directory();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted"));
    const result = await discoverTools({ root });
    const bundled = readyTools(root);
    expect(result.source.kind).toBe("bundled");
    expect(result.total).toBe(bundled.length);
    expect(result.tools.map((tool) => tool.packageName)).toEqual(bundled.map((tool) => tool.packageName));
    expect(
      result.tools.every(
        (tool) => tool.metadataOrigin === (tool.installed ? "installed-declaration" : "publisher"),
      ),
    ).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it("reads a private local index relative to the project without installing or importing behavior", async () => {
    const root = directory();
    indexFile(root);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted"));
    const result = await discoverTools({ root, index: "tool-index.json" });
    expect(result.source).toEqual({ kind: "file", location: join(root, "tool-index.json") });
    expect(result.tools[0]).toMatchObject({
      packageName: "@independent/tool-records",
      installSource: "@independent/tool-records@1.2.3",
      source: { kind: "npm" },
      metadataOrigin: "publisher",
      installed: false,
      title: "Synthetic records",
      limitations: ["Only the declared operations are supported."],
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("supports independent Git repositories with full pins and package subdirectories", async () => {
    const root = directory();
    const commit = "a".repeat(40);
    indexFile(root, [
      {
        ...entry(),
        source: { kind: "git", url: "https://example.test/tools.git", commit, subdirectory: "tools/records" },
      },
    ]);
    const result = await discoverTools({ root, index: "tool-index.json" });
    expect(result.tools[0]?.installSource).toBe(
      `git+https://example.test/tools.git#${commit}::tools/records`,
    );
  });

  it("searches title, package, operation, description and keywords with stable pagination", async () => {
    const root = directory();
    indexFile(root, [
      { ...entry("record-a"), title: "Matching One" },
      { ...entry("record-b"), title: "Matching Two" },
      { ...entry("record-c"), title: "Matching Three" },
      { ...entry("old"), title: "Matching Four", lifecycle: "deprecated" },
      { ...entry("revoked"), title: "Matching Five", lifecycle: "revoked" },
    ]);
    const result = await discoverTools({
      root,
      index: "tool-index.json",
      query: "matching",
      offset: 1,
      limit: 1,
    });
    expect(result).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(result.tools.map((tool) => tool.packageName)).toEqual(["record-b"]);
    expect((await discoverTools({ root, index: "tool-index.json", query: "records.get" })).total).toBe(3);
    expect((await discoverTools({ root, index: "tool-index.json", offset: 20 })).tools).toEqual([]);
  });

  it("resolves exact selections beyond the first page with a single index request", async () => {
    const entries = Array.from({ length: 31 }, (_, index) => ({
      ...entry(`@independent/tool-${index}`),
      tool: { ...entry().tool, id: `records-${index}` },
    }));
    let requests = 0;
    const url = await server((response) => {
      requests += 1;
      response.end(JSON.stringify({ schemaVersion: 1, packages: entries }));
    });
    const selected = await resolveDiscoveredTool({ root: directory(), index: url, selector: "records-30" });
    expect(selected?.packageName).toBe("@independent/tool-30");
    expect(requests).toBe(1);
  });

  it("rejects ambiguous versions and resolves exact npm or pinned Git selections", async () => {
    const root = directory();
    const commit = "b".repeat(40);
    const source = { kind: "git", url: "https://example.test/tools.git", commit };
    indexFile(root, [entry(), { ...entry(), packageVersion: "2.0.0", source }]);
    await expect(
      resolveDiscoveredTool({ root, index: "tool-index.json", selector: "records" }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_AMBIGUOUS" });
    await expect(
      resolveDiscoveredTool({ root, index: "tool-index.json", selector: "@independent/tool-records" }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_AMBIGUOUS" });
    expect(
      (
        await resolveDiscoveredTool({
          root,
          index: "tool-index.json",
          selector: "@independent/tool-records@1.2.3",
        })
      )?.version,
    ).toBe("1.2.3");
    expect(
      (
        await resolveDiscoveredTool({
          root,
          index: "tool-index.json",
          selector: "@independent/tool-records@2.0.0",
        })
      )?.installSource,
    ).toBe(`git+https://example.test/tools.git#${commit}`);
    expect(
      (
        await resolveDiscoveredTool({
          root,
          index: "tool-index.json",
          selector: `git+https://example.test/tools.git#${commit}`,
        })
      )?.version,
    ).toBe("2.0.0");
    expect(
      await resolveDiscoveredTool({ root, index: "tool-index.json", selector: "not-in-index" }),
    ).toBeUndefined();
  });

  it("does not silently reinterpret an unavailable index entry as another package", async () => {
    const root = directory();
    indexFile(root, [{ ...entry(), lifecycle: "revoked" }]);
    await expect(
      resolveDiscoveredTool({ root, index: "tool-index.json", selector: "@independent/tool-records@1.2.3" }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_ENTRY_UNAVAILABLE" });
  });

  it("labels locally inspected declarations separately from publisher claims without executing a module", async () => {
    const root = directory();
    createTool({ root, id: "records" });
    const packageRoot = join(root, "node_modules/@independent/tool-records");
    mkdirSync(packageRoot, { recursive: true });
    const original = join(root, "firedrill/tools/records/records.tool.json");
    const declaration = JSON.parse(readFileSync(original, "utf8"));
    declaration.manifest.version = "1.2.3";
    writeFileSync(join(packageRoot, "tool.json"), JSON.stringify(declaration));
    copyFileSync(join(dirname(original), "behavior.mjs"), join(packageRoot, "behavior.mjs"));
    writeFileSync(
      join(packageRoot, "behavior.mjs"),
      'throw new Error("Behavior must not run during discovery");',
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@independent/tool-records",
        version: "1.2.3",
        type: "module",
        exports: { "./package.json": "./package.json" },
        firedrill: { layer: "tool-pack", tool: "tool.json", lifecycle: "active" },
      }),
    );
    indexFile(root);
    const result = await discoverTools({ root, index: "tool-index.json" });
    expect(result.tools[0]).toMatchObject({ installed: true, metadataOrigin: "installed-declaration" });
    expect(result.tools[0]?.operations.map((operation) => operation.id)).toEqual(["get", "set"]);
    expect(result.tools[0]?.limitations).toEqual([]);
  });

  it("loads only the explicitly requested loopback index", async () => {
    const url = await server((response) =>
      response.end(JSON.stringify({ schemaVersion: 1, packages: [entry()] })),
    );
    const result = await discoverTools({ root: directory(), index: url });
    expect(result.source).toEqual({ kind: "loopback", location: url });
    expect(result.tools).toHaveLength(1);
  });

  it.each([
    "https://user:password@example.test/index.json",
    "https://example.test/index.json?token=private",
    "https://example.test/index.json#fragment",
    "http://example.test/index.json",
    "ftp://example.test/index.json",
  ])("rejects unsafe index locations without sending a request: %s", async (index) => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted"));
    await expect(discoverTools({ root: directory(), index })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_URL_INVALID",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("never follows a redirect or sends credentials", async () => {
    let requests = 0;
    const url = await server((response) => {
      requests += 1;
      response.writeHead(302, { location: "https://example.test/do-not-follow" });
      response.end();
    });
    await expect(discoverTools({ root: directory(), index: url })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_REDIRECT",
    });
    expect(requests).toBe(1);
  });

  it.each([0, 2, "1"])("rejects schemaVersion %s", async (schemaVersion) => {
    const root = directory();
    writeFileSync(join(root, "index.json"), JSON.stringify({ schemaVersion, packages: [entry()] }));
    await expect(discoverTools({ root, index: "index.json" })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_INVALID",
    });
  });

  it.each([
    { packageVersion: "^1.2.3" },
    { packageName: "https://example.test/package.tgz" },
    { title: "Hidden\u001b[31mcolor" },
    { source: { kind: "git", url: "https://example.test/tools.git", commit: "main" } },
    { source: { kind: "git", url: "https://user:secret@example.test/tools.git", commit: "a".repeat(40) } },
    {
      source: {
        kind: "git",
        url: "https://example.test/tools.git",
        commit: "a".repeat(40),
        subdirectory: "../outside",
      },
    },
  ])("rejects ambiguous or unsafe metadata: %j", async (override) => {
    const root = directory();
    indexFile(root, [{ ...entry(), ...override }]);
    await expect(discoverTools({ root, index: "tool-index.json" })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_INVALID",
    });
  });

  it("rejects duplicate versions and operation IDs instead of hiding conflicts", () => {
    expect(ToolIndexSchema.safeParse({ schemaVersion: 1, packages: [entry(), entry()] }).success).toBe(false);
    const duplicate = entry();
    duplicate.tool.operations.push({ id: "records.get", fidelity: "stateful" });
    expect(ToolIndexSchema.safeParse({ schemaVersion: 1, packages: [duplicate] }).success).toBe(false);
  });

  it("limits local input and streamed HTTP bodies even without a content length", async () => {
    const root = directory();
    writeFileSync(join(root, "large.json"), " ".repeat(TOOL_INDEX_MAX_BYTES + 1));
    await expect(discoverTools({ root, index: "large.json" })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_TOO_LARGE",
    });
    const url = await server((response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write(" ".repeat(TOOL_INDEX_MAX_BYTES));
      response.end(" ");
    });
    await expect(discoverTools({ root, index: url })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_TOO_LARGE",
    });
  });

  it("rejects non-JSON responses, directories, and unavailable files with stable codes", async () => {
    const root = directory();
    const url = await server((response) => response.end("<html>not an index</html>"));
    await expect(discoverTools({ root, index: url })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_INVALID",
    });
    await expect(discoverTools({ root, index: root })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_READ_FAILED",
    });
    await expect(discoverTools({ root, index: "missing.json" })).rejects.toMatchObject({
      code: "framework.TOOL_INDEX_READ_FAILED",
    });
  });

  it("cancels an in-flight request and rejects pre-cancelled requests before fetching", async () => {
    const controller = new AbortController();
    const url = await server(() => controller.abort());
    await expect(
      discoverTools({ root: directory(), index: url, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_CANCELLED" });
    const network = vi.spyOn(globalThis, "fetch");
    await expect(
      discoverTools({ root: directory(), index: url, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_CANCELLED" });
    expect(network).not.toHaveBeenCalled();
  });

  it("times out a stalled request without depending on the test runner timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const assertion = expect(
      discoverTools({ root: directory(), index: "https://example.test/index.json" }),
    ).rejects.toMatchObject({ code: "framework.TOOL_INDEX_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(TOOL_INDEX_TIMEOUT_MS + 1);
    await assertion;
  });

  it.each([{ offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: 0.5 }, { query: "x".repeat(501) }])(
    "rejects invalid pagination and query limits: %j",
    async (options) => {
      await expect(discoverTools({ root: directory(), ...options })).rejects.toMatchObject({
        code: "framework.TOOL_DISCOVERY_OPTIONS_INVALID",
      });
    },
  );

  it("generates the public Draft 2020-12 input schema from the same validators", () => {
    const schema = toolIndexJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://firedrill.run/schema/v1/tool-index.json");
    const bundled = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../registry/index.json"), "utf8"),
    );
    expect(ToolIndexSchema.safeParse(bundled).success).toBe(true);
  });
});
