import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { BoundWorldClient, WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpWorldBinding } from "../src/index.js";

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
      ).toEqual(["tool_error", "tool_error", "ok", "ok", "ok", "ok"]);
    } finally {
      await binding.close();
      fixture.store.close();
    }
  });
});
