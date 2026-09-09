import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startToolUiBinding } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const WORLD_ID = "world_toolui001";
const ACTOR_ID = "stock-clerk";
const HTML = '<!doctype html><title>Stockroom</title><script type="module" src="./main.js"></script>';
const SCRIPT = 'import { getContext, invoke } from "/_firedrill/client.js"; void getContext; void invoke;';
const directories: string[] = [];
const stores: SqliteWorldStore[] = [];
const listeners: Awaited<ReturnType<typeof startToolUiBinding>>[] = [];

function asset(path: string, content: string | Uint8Array, mediaType: string) {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return {
    path,
    mediaType,
    artifactHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes,
  };
}

function world() {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-tool-ui-test-"));
  directories.push(directory);
  const tool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "stockroom",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "stock", schema: { type: "object" } }],
      operations: [
        {
          id: "stock.receive",
          description: "Receive units of a stock item",
          inputSchema: {
            type: "object",
            required: ["sku", "units"],
            properties: { sku: { type: "string" }, units: { type: "integer", minimum: 1 } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["units"],
            properties: { units: { type: "integer" } },
            additionalProperties: false,
          },
          idempotency: "required",
          fidelity: "stateful",
        },
        {
          id: "stock.clear",
          description: "Clear the stock count using a separately granted operation",
          inputSchema: {
            type: "object",
            required: ["sku"],
            properties: { sku: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: { type: "object" },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
    operations: {
      "stock.receive": (input, context) => {
        const sku = String(input.sku);
        const units = Number(context.state.get("stock", sku)?.units ?? 0) + Number(input.units);
        context.state.put("stock", sku, { units });
        return { units };
      },
      "stock.clear": (input, context) => {
        context.state.put("stock", String(input.sku), { units: 0 });
        return {};
      },
    },
  });
  const otherTool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "dispatch",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.write"],
      state: [{ namespace: "jobs", schema: { type: "object" } }],
      operations: [
        {
          id: "jobs.submit",
          description: "Submit a dispatch job",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "required",
          fidelity: "stateful",
        },
      ],
    },
    operations: {
      "jobs.submit": (_input, context) => {
        context.state.put("jobs", "first", { status: "submitted" });
        return { status: "submitted" };
      },
    },
  });
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: WORLD_ID,
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "19",
    virtualTimeUs: 0,
    correlationId: "corr_toolui001",
    actors: [
      {
        bindingId: "actor_toolui001",
        actorId: ACTOR_ID,
        grants: [
          { packageId: "stockroom", operationId: "stock.receive" },
          { packageId: "dispatch", operationId: "jobs.submit" },
        ],
      },
    ],
  });
  stores.push(store);
  const kernel = new WorldKernel({ store, packageLockHash: HASH_B, tools: [tool, otherTool] });
  const client = new BoundWorldClient({
    kernel,
    actorBindingId: "actor_toolui001",
    namespace: "run_toolui001",
  });
  return { tool, otherTool, store, client };
}

function ui(packageId = "stockroom") {
  return {
    packageId,
    entry: "app/index.html",
    assets: [
      asset("app/index.html", HTML, "text/html; charset=utf-8"),
      asset("app/main.js", SCRIPT, "text/javascript; charset=utf-8"),
      asset("app/styles.css", "body { color: black; }", "text/css; charset=utf-8"),
    ],
  };
}

async function start(
  fixture: ReturnType<typeof world>,
  overrides: Partial<Parameters<typeof startToolUiBinding>[0]> = {},
) {
  const listener = await startToolUiBinding({
    client: fixture.client,
    tool: fixture.tool,
    ui: ui(),
    worldInstanceId: WORLD_ID,
    actorId: ACTOR_ID,
    ...overrides,
  });
  listeners.push(listener);
  const url = new URL(listener.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const headers = { authorization: `Bearer ${token}`, origin: url.origin };
  return { listener, url, token, headers };
}

function invoke(
  binding: Awaited<ReturnType<typeof start>>,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
) {
  return fetch(`${binding.url.origin}/_firedrill/invoke`, {
    method: "POST",
    headers: { ...binding.headers, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function rawRequest(
  url: URL,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  try {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  } finally {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
      if (directory.startsWith(join(tmpdir(), "firedrill-tool-ui-test-"))) {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  }
});

describe("Tool UI loopback binding", () => {
  it("serves the verified entry and self-hosted assets without revealing credentials", async () => {
    const fixture = world();
    const loadedUi = ui();
    const binding = await start(fixture, { ui: loadedUi });
    expect(binding.listener.kind).toBe("tool-ui");
    expect(binding.listener.packageId).toBe("stockroom");
    expect(binding.listener.title.length).toBeGreaterThan(0);
    expect(binding.url.hostname).toBe("127.0.0.1");
    expect(binding.url.pathname).toBe("/app/index.html");
    expect(binding.url.search).toBe("");

    // Mutation of caller-owned buffers must not change an already admitted build.
    loadedUi.assets[0]?.bytes.fill(120);
    const page = await fetch(binding.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(HTML);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("set-cookie")).toBeNull();
    const policy = page.headers.get("content-security-policy");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");

    const script = await fetch(`${binding.url.origin}/app/main.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(SCRIPT);
    const module = await fetch(`${binding.url.origin}/_firedrill/client.js`);
    expect(module.status).toBe(200);
    const source = await module.text();
    expect(source).toContain("getContext");
    expect(source).toContain("invoke");
    expect(source).not.toContain(binding.token);
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("returns only this app's context and live revision behind its scoped bearer", async () => {
    const fixture = world();
    let revision = { generation: 0, evidenceSequence: 1 };
    const binding = await start(fixture, { getRevision: () => revision });
    const endpoint = `${binding.url.origin}/_firedrill/context`;
    const anonymous = await fetch(endpoint);
    expect(anonymous.status).toBe(401);
    const cookieOnly = await fetch(endpoint, { headers: { cookie: `token=${binding.token}` } });
    expect(cookieOnly.status).toBe(401);
    const queryOnly = await fetch(`${endpoint}?token=${binding.token}`);
    expect(queryOnly.status).toBeGreaterThanOrEqual(400);

    const response = await fetch(endpoint, { headers: binding.headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      worldInstanceId: WORLD_ID,
      actorId: ACTOR_ID,
      packageId: "stockroom",
      title: binding.listener.title,
      revision,
    });
    revision = { generation: 1, evidenceSequence: 4 };
    const updated = await fetch(endpoint, { headers: binding.headers });
    expect(await updated.json()).toMatchObject({ revision });
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("uses the bound actor and canonical idempotency against the same SQLite world", async () => {
    const fixture = world();
    const binding = await start(fixture);
    const request = {
      operationId: "stock.receive",
      arguments: { sku: "filter", units: 7 },
      idempotencyKey: "receive-filter-7",
    };
    const response = await invoke(binding, request);
    expect(response.status).toBe(200);
    const first: unknown = await response.json();
    expect(first).toMatchObject({
      schemaVersion: 1,
      callId: expect.stringMatching(/^call_/),
      correlationId: expect.stringMatching(/^corr_/),
      outcome: { status: "ok", value: { units: 7 } },
    });
    const replay = await invoke(binding, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: { status: "ok", value: { units: 7 } } });
    expect(fixture.store.readState("stockroom", "stock", "filter")?.value).toEqual({ units: 7 });

    const denied = await invoke(binding, {
      operationId: "stock.clear",
      arguments: { sku: "filter" },
      idempotencyKey: "clear-filter",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      schemaVersion: 1,
      callId: expect.stringMatching(/^call_/),
      outcome: { status: "denied" },
    });
    expect(fixture.store.readState("stockroom", "stock", "filter")?.value).toEqual({ units: 7 });
    expect(fixture.store.readEvidence().filter((entry) => entry.kind === "operation")).toHaveLength(3);

    const invalid = await invoke(binding, {
      operationId: "stock.receive",
      arguments: { sku: "filter", units: -2 },
      idempotencyKey: "invalid-receive",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ schemaVersion: 1, outcome: { status: "invalid" } });
    expect(fixture.store.readState("stockroom", "stock", "filter")?.value).toEqual({ units: 7 });
  });

  it("isolates two apps by origin and token even when the actor may call both Tools", async () => {
    const fixture = world();
    const first = await start(fixture);
    const second = await start(fixture, { tool: fixture.otherTool, ui: ui("dispatch") });
    expect(first.url.origin).not.toBe(second.url.origin);
    expect(first.token).not.toBe(second.token);
    const secondEndpoint = `${second.url.origin}/_firedrill/context`;
    const wrongToken = await fetch(secondEndpoint, {
      headers: { authorization: first.headers.authorization, origin: second.url.origin },
    });
    expect(wrongToken.status).toBe(401);
    const wrongOrigin = await fetch(secondEndpoint, {
      headers: { authorization: second.headers.authorization, origin: first.url.origin },
    });
    expect(wrongOrigin.status).toBe(421);
    expect(wrongOrigin.headers.get("access-control-allow-origin")).toBeNull();
    const undeclared = await invoke(first, {
      operationId: "jobs.submit",
      arguments: {},
      idempotencyKey: "cross-package-job",
    });
    expect(undeclared.status).toBe(404);
    expect(fixture.client.callsIssued()).toBe(0);

    for (const override of [{ packageId: "dispatch" }, { actorId: "administrator" }]) {
      const spoofed = await invoke(first, {
        operationId: "stock.receive",
        arguments: { sku: "filter", units: 7 },
        idempotencyKey: "spoofed-call",
        ...override,
      });
      expect(spoofed.status).toBe(400);
    }
    expect(fixture.client.callsIssued()).toBe(0);
    expect(fixture.store.readState("dispatch", "jobs", "first")).toBeNull();
    const allowed = await invoke(second, {
      operationId: "jobs.submit",
      arguments: {},
      idempotencyKey: "dispatch-own-job",
    });
    expect(allowed.status).toBe(200);
    expect(fixture.store.readState("dispatch", "jobs", "first")?.value).toEqual({ status: "submitted" });
  });

  it("rejects alternate loopback authorities, foreign origins, and cross-site browser requests", async () => {
    const fixture = world();
    const binding = await start(fixture);
    for (const host of [
      "attacker.example",
      `localhost:${binding.url.port}`,
      "127.0.0.1:1",
      `${binding.url.host}.attacker.example`,
    ]) {
      const response = await rawRequest(binding.url, "/app/index.html", { host });
      expect(response.status, host).toBe(421);
      expect(response.body).not.toContain(HTML);
    }
    for (const origin of [
      "https://attacker.example",
      "http://127.0.0.1:1",
      "null",
      `${binding.url.origin}/`,
    ]) {
      const response = await fetch(`${binding.url.origin}/_firedrill/context`, {
        headers: { ...binding.headers, origin },
      });
      expect(response.status, origin).toBe(421);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const site of ["cross-site", "same-site"]) {
      const response = await fetch(`${binding.url.origin}/_firedrill/context`, {
        headers: { ...binding.headers, "sec-fetch-site": site },
      });
      expect(response.status, site).toBe(421);
    }
    const sameOrigin = await fetch(`${binding.url.origin}/_firedrill/context`, {
      headers: { ...binding.headers, "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
    const preflight = await fetch(`${binding.url.origin}/_firedrill/invoke`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(421);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("does not mount generic operations, world state, or inspector control routes", async () => {
    const fixture = world();
    const binding = await start(fixture);
    for (const path of [
      "/v1/tools",
      "/v1/operations/dispatch/jobs.submit",
      "/_firedrill/reset",
      "/_firedrill/state",
      "/api/environment",
      "/api/environment/reset",
      "/world.sqlite",
      "/.env",
    ]) {
      const response = await fetch(`${binding.url.origin}${path}`, { headers: binding.headers });
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain(WORLD_ID);
    }
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("permits an app link's document navigation without granting cross-origin API access", async () => {
    const fixture = world();
    const binding = await start(fixture);
    const navigationHeaders = {
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    // fetch owns Sec-Fetch-Mode, so use HTTP directly to model a document navigation.
    const page = await rawRequest(binding.url, binding.url.pathname, navigationHeaders);
    expect(page.status).toBe(200);
    expect(page.body).toBe(HTML);
    const metadata = await rawRequest(binding.url, "/_firedrill/context", {
      ...navigationHeaders,
      authorization: binding.headers.authorization,
    });
    expect(metadata.status).toBeGreaterThanOrEqual(400);
    const script = await rawRequest(binding.url, "/app/main.js", navigationHeaders);
    expect(script.status).toBeGreaterThanOrEqual(400);
    const explicitForeignOrigin = await rawRequest(binding.url, binding.url.pathname, {
      ...navigationHeaders,
      origin: "http://127.0.0.1:1",
    });
    expect(explicitForeignOrigin.status).toBeGreaterThanOrEqual(400);
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("rejects ambiguous request paths before looking up immutable assets", async () => {
    const fixture = world();
    const binding = await start(fixture);
    for (const path of [
      "/app/../app/index.html",
      "/app/%2e%2e/app/index.html",
      "/app%2findex.html",
      "/app%5cindex.html",
      "/app//index.html",
      "/app/index.html%00",
      "/app\\index.html",
      "/%252e%252e/world.sqlite",
    ]) {
      const response = await rawRequest(binding.url, path, binding.headers);
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(response.body, path).not.toContain(HTML);
    }
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("requires a bearer and a bounded strict JSON operation envelope", async () => {
    const fixture = world();
    const binding = await start(fixture);
    const endpoint = `${binding.url.origin}/_firedrill/invoke`;
    const valid = {
      operationId: "stock.receive",
      arguments: { sku: "filter", units: 7 },
      idempotencyKey: "seven",
    };
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: binding.url.origin },
      body: JSON.stringify(valid),
    });
    expect(unauthorized.status).toBe(401);
    for (const body of [
      null,
      [],
      {},
      { ...valid, arguments: [] },
      { ...valid, idempotencyKey: 42 },
      { ...valid, extra: true },
    ]) {
      const response = await invoke(binding, body);
      expect(response.status).toBe(400);
    }
    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const wrongType = await fetch(endpoint, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "text/plain" },
      body: JSON.stringify(valid),
    });
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    const oversized = await invoke(binding, { ...valid, arguments: { padding: "x".repeat(1024 * 1024) } });
    expect(oversized.status).toBe(413);
    const wrongMethod = await fetch(endpoint, { headers: binding.headers });
    expect(wrongMethod.status).toBe(405);
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("rejects invalid asset identity, hashes, media, paths, and entry points before listening", async () => {
    const fixture = world();
    const validAsset = asset("app/index.html", HTML, "text/html; charset=utf-8");
    const invalidUis = [
      { ...ui(), packageId: "dispatch" },
      { ...ui(), entry: "missing.html" },
      { ...ui(), entry: "app/main.js" },
      { ...ui(), assets: [] },
      { ...ui(), assets: [validAsset, validAsset] },
      { ...ui(), assets: [{ ...validAsset, artifactHash: HASH_A }] },
      { ...ui(), assets: [{ ...validAsset, artifactHash: "not-a-hash" }] },
      { ...ui(), assets: [{ ...validAsset, mediaType: "application/octet-stream" }] },
      { ...ui(), assets: [{ ...validAsset, mediaType: "text/javascript; charset=utf-8" }] },
      ...[
        "../index.html",
        "/index.html",
        "app\\index.html",
        "_firedrill/client.js",
        "app/.env",
        "app/index.html%00",
      ].map((path) => ({
        ...ui(),
        assets: [...ui().assets, asset(path, "bad", "text/html; charset=utf-8")],
      })),
    ];
    for (const invalid of invalidUis) {
      await expect(start(fixture, { ui: invalid })).rejects.toThrow();
    }
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("rejects an oversized chunked body without waiting for the sender to finish it", async () => {
    const fixture = world();
    const binding = await start(fixture);
    const request = httpRequest({
      hostname: binding.url.hostname,
      port: binding.url.port,
      path: "/_firedrill/invoke",
      method: "POST",
      headers: {
        ...binding.headers,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    });
    const responded = new Promise<number>((resolve, reject) => {
      request.once("response", (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    try {
      // Deliberately do not call end(): the limit must apply to streaming bodies too.
      request.write(Buffer.alloc(1024 * 1024 + 1, 120));
      expect(await responded).toBe(413);
      expect(fixture.client.callsIssued()).toBe(0);
    } finally {
      request.destroy();
    }
  });

  it("enforces per-asset, total-byte, and file-count safety bounds before listening", async () => {
    const fixture = world();
    const tooLarge = asset("large.js", Buffer.alloc(4 * 1024 * 1024 + 1), "text/javascript; charset=utf-8");
    await expect(start(fixture, { ui: { ...ui(), assets: [...ui().assets, tooLarge] } })).rejects.toThrow();
    const manyAssets = Array.from({ length: 256 }, (_, index) =>
      asset(`asset-${index}.js`, "", "text/javascript; charset=utf-8"),
    );
    await expect(
      start(fixture, { ui: { ...ui(), assets: [...ui().assets, ...manyAssets] } }),
    ).rejects.toThrow();
    const largeAssets = Array.from({ length: 4 }, (_, index) =>
      asset(`large-${index}.js`, Buffer.alloc(4 * 1024 * 1024), "text/javascript; charset=utf-8"),
    );
    await expect(
      start(fixture, { ui: { ...ui(), assets: [...ui().assets, ...largeAssets] } }),
    ).rejects.toThrow();
    expect(fixture.client.callsIssued()).toBe(0);
  });

  it("closes stalled requests without allowing their unfinished operation to run", async () => {
    const fixture = world();
    const binding = await start(fixture);
    const request = httpRequest({
      hostname: binding.url.hostname,
      port: binding.url.port,
      path: "/_firedrill/invoke",
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json", "content-length": "1000" },
    });
    request.on("error", () => undefined);
    request.on("response", (response) => response.resume());
    const closed = new Promise<void>((resolve) => request.once("close", resolve));
    const connected = new Promise<void>((resolve, reject) => {
      request.once("socket", (socket) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    });
    request.write('{"operationId":"stock.receive",');
    await connected;
    try {
      await binding.listener.close();
      await closed;
      await binding.listener.close();
      await expect(
        fetch(`${binding.url.origin}/_firedrill/context`, { headers: binding.headers }),
      ).rejects.toThrow();
      expect(fixture.client.callsIssued()).toBe(0);
      expect(fixture.store.readState("stockroom", "stock", "filter")).toBeNull();
    } finally {
      request.destroy();
    }
  });
});
