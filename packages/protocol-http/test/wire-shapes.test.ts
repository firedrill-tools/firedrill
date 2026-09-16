import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpWireRequest } from "../src/index.js";
import {
  httpWireCredential,
  invokeHttpWireRoute,
  matchWireRoute,
  registerWireRoutes,
  startHttpWorldBinding,
  wireMethodsForPath,
} from "../src/index.js";

const BUILD_HASH = `sha256:${"c".repeat(64)}` as const;
const LOCK_HASH = `sha256:${"d".repeat(64)}` as const;
const directories: string[] = [];

function artifactWorld() {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-http-shapes-"));
  directories.push(directory);
  const tool = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "artifact-store",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "artifacts", schema: { type: "object" } }],
      operations: [
        {
          id: "artifacts.put",
          inputSchema: {
            type: "object",
            required: ["key", "content"],
            properties: { key: { type: "string" }, content: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["key", "bytes"],
            properties: { key: { type: "string" }, bytes: { type: "integer" } },
            additionalProperties: false,
          },
          declaredErrors: ["EMPTY_CONTENT"],
          idempotency: "required",
          fidelity: "stateful",
        },
        {
          id: "artifacts.get",
          inputSchema: {
            type: "object",
            required: ["key"],
            properties: { key: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["key", "content"],
            properties: { key: { type: "string" }, content: { type: "string" } },
            additionalProperties: false,
          },
          declaredErrors: ["NOT_FOUND"],
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      http: [
        {
          id: "put-artifact",
          operationId: "artifacts.put",
          method: "PUT",
          path: "/v3/artifacts/{artifactKey}",
          auth: { kind: "basic", token: "username" },
          requestBody: "form",
          response: {
            successStatus: 201,
            errors: [{ code: "EMPTY_CONTENT", status: 422 }],
          },
        },
        {
          id: "get-artifact",
          operationId: "artifacts.get",
          method: "GET",
          path: "/v3/artifacts/{artifactKey}",
          auth: { kind: "basic", token: "username" },
          requestBody: "none",
          response: {
            successStatus: 200,
            errors: [{ code: "NOT_FOUND", status: 404 }],
          },
        },
        {
          id: "json-probe",
          operationId: "artifacts.get",
          method: "POST",
          path: "/v3/json-probe",
          auth: { kind: "basic", token: "username" },
          requestBody: "json",
          response: {
            successStatus: 200,
            errors: [{ code: "NOT_FOUND", status: 404 }],
          },
        },
      ],
    },
    operations: {
      "artifacts.put": (input, context) => {
        const key = String(input.key);
        const content = String(input.content);
        if (content.length === 0) {
          context.fail({ code: "EMPTY_CONTENT", message: "artifact content cannot be empty" });
        }
        context.state.put("artifacts", key, { content });
        return { key, bytes: Buffer.byteLength(content) };
      },
      "artifacts.get": (input, context) => {
        const key = String(input.key);
        const artifact = context.state.get("artifacts", key);
        if (artifact === null) {
          return context.fail({ code: "NOT_FOUND", message: `artifact ${key} does not exist` });
        }
        const content = artifact.content;
        if (typeof content !== "string") {
          return context.fail({ code: "NOT_FOUND", message: `artifact ${key} does not exist` });
        }
        return { key, content };
      },
    },
    http: {
      "put-artifact": {
        decode: (request) => {
          if (request.headers.authorization !== undefined) {
            throw new TypeError("the Basic credential must not be exposed to the codec");
          }
          const content = request.body.kind === "form" ? request.body.value.content?.[0] : undefined;
          const idempotencyKey = request.headers["idempotency-key"]?.[0];
          return {
            arguments: { key: request.path.artifactKey ?? "", content: content ?? "" },
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          };
        },
        encode: ({ outcome }) => ({
          ...(outcome.status === "ok" &&
          typeof outcome.value === "object" &&
          outcome.value !== null &&
          !Array.isArray(outcome.value)
            ? { headers: { location: `/v3/artifacts/${String(outcome.value.key)}` } }
            : {}),
          body:
            outcome.status === "ok"
              ? { kind: "json", value: outcome.value ?? null }
              : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
        }),
      },
      "get-artifact": {
        decode: (request) => ({ arguments: { key: request.path.artifactKey ?? "" } }),
        encode: ({ outcome }) => {
          if (
            outcome.status === "ok" &&
            typeof outcome.value === "object" &&
            outcome.value !== null &&
            !Array.isArray(outcome.value) &&
            typeof outcome.value.content === "string"
          ) {
            return {
              headers:
                outcome.value.key === "unsafe-header"
                  ? { connection: "upgrade" }
                  : { "content-disposition": "attachment" },
              body: {
                kind: "bytes",
                value: new TextEncoder().encode(outcome.value.content),
                contentType: "application/octet-stream",
              },
            };
          }
          return {
            body: { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
          };
        },
      },
      "json-probe": {
        decode: (request) => {
          if (request.body.kind !== "json") throw new TypeError("expected a JSON body");
          return { arguments: { key: "readme" } };
        },
        encode: ({ outcome }) => ({
          body:
            outcome.status === "ok"
              ? { kind: "json", value: outcome.value ?? null }
              : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
        }),
      },
    },
  });
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_shapes001",
    buildHash: BUILD_HASH,
    packageLockHash: LOCK_HASH,
    seed: "19",
    virtualTimeUs: 0,
    correlationId: "corr_shapes001",
    actors: [
      {
        bindingId: "actor_shapes001",
        actorId: "operator",
        grants: [
          { packageId: "artifact-store", operationId: "artifacts.put" },
          { packageId: "artifact-store", operationId: "artifacts.get" },
        ],
      },
    ],
  });
  const kernel = new WorldKernel({ store, packageLockHash: LOCK_HASH, tools: [tool] });
  const client = new BoundWorldClient({
    kernel,
    actorBindingId: "actor_shapes001",
    namespace: "run_shapes001",
  });
  return { client, store, tool };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-http-shapes-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe("synthetic HTTP route shapes", () => {
  it("maps form input and byte output without owning Tool state", async () => {
    const fixture = artifactWorld();
    const binding = await startHttpWorldBinding({
      client: fixture.client,
      tools: [fixture.tool],
      token: "artifact-world-token-00001",
    });
    const authorization = `Basic ${Buffer.from(`${binding.token}:unused`, "utf8").toString("base64")}`;
    try {
      const unauthorized = await fetch(`${binding.baseUrl}/v3/artifacts/readme`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");
      expect(fixture.client.callsIssued()).toBe(0);

      const wrongContentType = await fetch(`${binding.baseUrl}/v3/artifacts/readme`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "text/plain",
          "idempotency-key": "wrong-content-type",
        },
        body: "content=ignored",
      });
      expect(wrongContentType.status).toBe(415);
      expect(await wrongContentType.json()).toMatchObject({
        code: "framework.HTTP_CONTENT_TYPE_UNSUPPORTED",
      });
      expect(fixture.client.callsIssued()).toBe(0);

      const oversized = await fetch(`${binding.baseUrl}/v3/artifacts/readme`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": "oversized-content",
        },
        body: `content=${"a".repeat(1024 * 1024)}`,
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ code: "framework.HTTP_BODY_TOO_LARGE" });
      expect(fixture.client.callsIssued()).toBe(0);

      const missing = await fetch(`${binding.baseUrl}/v3/artifacts/missing`, {
        headers: { authorization },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "artifact missing does not exist" });

      const empty = await fetch(`${binding.baseUrl}/v3/artifacts/readme`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": "empty-readme",
        },
        body: new URLSearchParams({ content: "" }),
      });
      expect(empty.status).toBe(422);
      expect(fixture.store.readState("artifact-store", "artifacts", "readme")).toBeNull();

      const stored = await fetch(`${binding.baseUrl}/v3/artifacts/readme`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": "store-readme",
        },
        body: new URLSearchParams({ content: "agent-ready" }),
      });
      expect(stored.status).toBe(201);
      expect(stored.headers.get("location")).toBe("/v3/artifacts/readme");
      expect(await stored.json()).toEqual({ key: "readme", bytes: 11 });

      const downloaded = await fetch(`${binding.baseUrl}/v3/artifacts/readme`, {
        headers: { authorization },
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
      expect(downloaded.headers.get("content-disposition")).toBe("attachment");
      expect(await downloaded.text()).toBe("agent-ready");
      expect(fixture.store.readState("artifact-store", "artifacts", "readme")?.value).toEqual({
        content: "agent-ready",
      });

      const deeplyNestedJson = `{"ignored":${"[".repeat(3000)}1${"]".repeat(3000)}}`;
      const deepJsonResponse = await fetch(`${binding.baseUrl}/v3/json-probe`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: deeplyNestedJson,
      });
      expect(deepJsonResponse.status).toBe(200);
      expect(await deepJsonResponse.json()).toEqual({ key: "readme", content: "agent-ready" });

      const nonFiniteJsonNumber = await fetch(`${binding.baseUrl}/v3/json-probe`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: "1e400",
      });
      expect(nonFiniteJsonNumber.status).toBe(400);
      expect(await nonFiniteJsonNumber.json()).toMatchObject({
        code: "framework.HTTP_BODY_INVALID",
      });

      const unsafeStored = await fetch(`${binding.baseUrl}/v3/artifacts/unsafe-header`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": "store-unsafe-header",
        },
        body: new URLSearchParams({ content: "still-stored" }),
      });
      expect(unsafeStored.status).toBe(201);

      const unsafeDownloaded = await fetch(`${binding.baseUrl}/v3/artifacts/unsafe-header`, {
        headers: { authorization },
      });
      expect(unsafeDownloaded.status).toBe(500);
      expect(await unsafeDownloaded.json()).toMatchObject({
        code: "framework.HTTP_RESPONSE_MAPPING_FAILED",
      });
      expect(fixture.store.readState("artifact-store", "artifacts", "unsafe-header")?.value).toEqual({
        content: "still-stored",
      });
      expect(
        fixture.store
          .readEvidence()
          .filter((entry) => entry.kind === "operation")
          .map((entry) => entry.outcome.status),
      ).toEqual(["tool_error", "tool_error", "ok", "ok", "ok", "ok", "ok"]);
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });
});

describe("transport-neutral HTTP codec dispatch", () => {
  function putRequest(key = "readme"): HttpWireRequest {
    return {
      method: "PUT",
      url: new URL(`https://synthetic.invalid/v3/artifacts/${key}`),
      headers: [
        ["Authorization", `Basic ${Buffer.from("synthetic-api-token:unused").toString("base64")}`],
        ["Content-Type", "application/x-www-form-urlencoded"],
        ["Idempotency-Key", `put-${key}`],
      ],
      body: new TextEncoder().encode("content=adapter-ready"),
    };
  }

  it("awaits an aborted invocation and skips encoding without pretending the commit rolled back", async () => {
    const fixture = artifactWorld();
    const codec = fixture.tool.http["put-artifact"];
    if (codec === undefined) throw new Error("missing fixture codec");
    const encode = vi.fn(codec.encode);
    const tool = defineTool({
      ...fixture.tool,
      http: { ...fixture.tool.http, "put-artifact": { ...codec, encode } },
    });
    const request = putRequest();
    const match = matchWireRoute(registerWireRoutes([tool]), request.method, request.url.pathname);
    if (match === undefined) throw new Error("missing fixture match");
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reason = new Error("caller cancelled");
    const pending = invokeHttpWireRoute({
      match,
      request,
      signal: controller.signal,
      authorize: () => true,
      invoke: async (...args) => {
        const result = fixture.client.invoke(...args);
        entered();
        await drained;
        return result;
      },
    });
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entry;
      controller.abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await expect(pending).rejects.toBe(reason);
      await observed;
      expect(encode).not.toHaveBeenCalled();
      expect(fixture.store.readState("artifact-store", "artifacts", "readme")?.value).toEqual({
        content: "adapter-ready",
      });
    } finally {
      release();
      await observed;
      fixture.store.close();
    }
  });

  it("uses host-owned invocation for real state, idempotency, declared errors and byte responses", async () => {
    const fixture = artifactWorld();
    const routes = registerWireRoutes([fixture.tool]);
    const invoke = vi.fn(async (...args: Parameters<typeof fixture.client.invoke>) =>
      fixture.client.invoke(...args),
    );
    const authorize = vi.fn(() => true);
    const dispatch = (request: HttpWireRequest) => {
      const match = matchWireRoute(routes, request.method, request.url.pathname);
      if (match === undefined) throw new Error("test request must match a declared route");
      expect(httpWireCredential(request, match.route.contract.auth)).toBe("synthetic-api-token");
      return invokeHttpWireRoute({ match, request, authorize, invoke });
    };
    try {
      const request = putRequest();
      const first = await dispatch(request);
      expect(first.status).toBe(201);
      expect(first.headers.location).toBe("/v3/artifacts/readme");
      expect(JSON.parse(new TextDecoder().decode(first.body))).toEqual({ key: "readme", bytes: 13 });
      const replay = await dispatch(request);
      expect(replay.status).toBe(first.status);
      expect(replay.headers).toEqual(first.headers);
      expect(JSON.parse(new TextDecoder().decode(replay.body))).toEqual(
        JSON.parse(new TextDecoder().decode(first.body)),
      );
      expect(invoke).toHaveBeenCalledWith(
        { packageId: "artifact-store", operationId: "artifacts.put" },
        { key: "readme", content: "adapter-ready" },
        { idempotencyKey: "put-readme" },
      );
      expect(fixture.store.readState("artifact-store", "artifacts", "readme")?.value).toEqual({
        content: "adapter-ready",
      });
      expect(fixture.store.readEvidence().filter((entry) => entry.kind === "state_change")).toHaveLength(1);

      const read = {
        ...request,
        method: "GET",
        body: new Uint8Array(),
        headers: request.headers.slice(0, 1),
      };
      const downloaded = await dispatch(read);
      expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
      expect(new TextDecoder().decode(downloaded.body)).toBe("adapter-ready");
      const missing = await dispatch({
        ...read,
        url: new URL("https://synthetic.invalid/v3/artifacts/missing"),
      });
      expect(missing.status).toBe(404);
      expect(JSON.parse(new TextDecoder().decode(missing.body))).toEqual({
        error: "artifact missing does not exist",
      });
      expect(authorize).toHaveBeenCalledTimes(4);
    } finally {
      fixture.store.close();
    }
  });

  it("denies before codecs and invocation, including an authored unauthenticated route", async () => {
    const fixture = artifactWorld();
    const contract = fixture.tool.manifest.http[0];
    const codec = fixture.tool.http["put-artifact"];
    if (contract === undefined || codec === undefined) throw new Error("missing fixture route");
    const decode = vi.fn(codec.decode);
    const uncredentialedTool = defineTool({
      ...fixture.tool,
      manifest: {
        ...fixture.tool.manifest,
        http: fixture.tool.manifest.http.map((route) => ({ ...route, auth: { kind: "none" as const } })),
      },
      http: { ...fixture.tool.http, "put-artifact": { ...codec, decode } },
    });
    const invoke = vi.fn();
    const request = putRequest();
    const match = matchWireRoute(
      registerWireRoutes([uncredentialedTool]),
      request.method,
      request.url.pathname,
    );
    if (match === undefined) throw new Error("missing fixture match");
    try {
      expect(httpWireCredential(request, match.route.contract.auth)).toBeUndefined();
      await expect(
        invokeHttpWireRoute({ match, request, authorize: () => false, invoke }),
      ).rejects.toMatchObject({
        code: "framework.HTTP_UNAUTHORIZED",
        status: 401,
      });
      expect(decode).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(fixture.client.callsIssued()).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  it("pins declared operation and received data across awaited authorization", async () => {
    const fixture = artifactWorld();
    const request = putRequest();
    const match = matchWireRoute(registerWireRoutes([fixture.tool]), request.method, request.url.pathname);
    if (match === undefined) throw new Error("missing fixture match");
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = invokeHttpWireRoute({
      match,
      request,
      authorize: async ({ operation, contract }) => {
        expect(Object.isFrozen(operation)).toBe(true);
        expect(Object.isFrozen(contract)).toBe(true);
        expect(Object.isFrozen(contract.auth)).toBe(true);
        expect(Object.isFrozen(contract.response.errors)).toBe(true);
        expect(() => {
          operation.operationId = "artifacts.get";
        }).toThrow();
        expect(() => {
          contract.operationId = "artifacts.get";
        }).toThrow();
        await wait;
        return true;
      },
      invoke: (operation, arguments_, options) => fixture.client.invoke(operation, arguments_, options),
    });
    request.url.pathname = "/v3/artifacts/changed";
    request.body.fill(0);
    release();
    try {
      expect((await result).status).toBe(201);
      expect(fixture.store.readState("artifact-store", "artifacts", "readme")?.value).toEqual({
        content: "adapter-ready",
      });
      expect(fixture.store.readState("artifact-store", "artifacts", "changed")).toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  it("rejects mismatched routing, oversized input and foreign invocation output", async () => {
    const fixture = artifactWorld();
    const request = putRequest();
    const routes = registerWireRoutes([fixture.tool]);
    const match = matchWireRoute(routes, request.method, request.url.pathname);
    if (match === undefined) throw new Error("missing fixture match");
    const invoke = vi.fn((...args: Parameters<typeof fixture.client.invoke>) =>
      fixture.client.invoke(...args),
    );
    try {
      expect(wireMethodsForPath(routes, request.url.pathname)).toEqual(["GET", "PUT"]);
      expect(matchWireRoute(routes, "POST", request.url.pathname)).toBeUndefined();
      expect(matchWireRoute(routes, "PUT", "/v3/artifacts/a%2Fb")).toBeUndefined();
      await expect(
        invokeHttpWireRoute({
          match,
          request: { ...request, method: "POST" },
          authorize: () => true,
          invoke,
        }),
      ).rejects.toMatchObject({ code: "framework.HTTP_ROUTE_MISMATCH" });
      await expect(
        invokeHttpWireRoute({
          match,
          request: { ...request, body: new Uint8Array(1024 * 1024 + 1) },
          authorize: () => true,
          invoke,
        }),
      ).rejects.toMatchObject({ code: "framework.HTTP_BODY_TOO_LARGE" });
      expect(invoke).not.toHaveBeenCalled();
      await expect(
        invokeHttpWireRoute({
          match,
          request,
          authorize: () => true,
          invoke: (...args) => {
            const result = fixture.client.invoke(...args);
            return {
              ...result,
              invocation: {
                ...result.invocation,
                operation: { packageId: "other-package", operationId: "other-operation" },
              },
            };
          },
        }),
      ).rejects.toThrow("different operation");
    } finally {
      fixture.store.close();
    }
  });

  it("extracts only the authored credential carrier without treating it as host authority", () => {
    const request = {
      url: new URL("https://synthetic.invalid/route?token=query-value&token=second"),
      headers: [
        ["Authorization", "token authored-token"],
        ["X-Api-Key", "header-token"],
      ] as const,
    };
    expect(httpWireCredential(request, { kind: "bearer", schemes: ["Bearer", "token"] })).toBe(
      "authored-token",
    );
    expect(httpWireCredential(request, { kind: "header", name: "X-Api-Key" })).toBe("header-token");
    expect(httpWireCredential(request, { kind: "query", name: "token" })).toBeUndefined();
    expect(
      httpWireCredential(
        { ...request, headers: [...request.headers, ["x-api-key", "duplicate"]] },
        { kind: "header", name: "X-Api-Key" },
      ),
    ).toBeUndefined();
    expect(httpWireCredential(request, { kind: "none" })).toBeUndefined();
    expect(
      httpWireCredential(
        {
          ...request,
          headers: [["Authorization", `Basic ${Buffer.from("user:password-token").toString("base64")}`]],
        },
        { kind: "basic", token: "password", username: "user" },
      ),
    ).toBe("password-token");
  });
});
