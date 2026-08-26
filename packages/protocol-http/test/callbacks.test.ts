import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@firedrill/tool-sdk";
import { WorldKernel } from "@firedrill/world-kernel";
import { SqliteWorldStore } from "@firedrill/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CallbackDispatcher } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const directories: string[] = [];
const servers: Server[] = [];

interface ReceivedCallback {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

function tool(retryDelaysUs: readonly number[] = []) {
  return defineTool({
    manifest: {
      schemaVersion: 1,
      id: "work-items",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["event.emit"],
      operations: [
        {
          id: "items.complete",
          inputSchema: {
            type: "object",
            required: ["itemId"],
            properties: { itemId: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["completed"],
            properties: { completed: { const: true } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "behavioral",
        },
      ],
      events: [
        {
          id: "item.completed",
          payloadSchema: {
            type: "object",
            required: ["itemId"],
            properties: { itemId: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      callbacks: [
        {
          id: "notify-application",
          eventId: "item.completed",
          receiverId: "application",
          method: "POST",
          path: "/hooks/items",
          idempotencyHeader: "Idempotency-Key",
          signature: { kind: "hmac-sha256", header: "X-Firedrill-Signature" },
          retry: { delaysUs: retryDelaysUs },
          timeoutMs: 1_000,
        },
      ],
    },
    operations: {
      "items.complete": (input, context) => {
        context.events.emit("item.completed", { itemId: String(input.itemId) });
        return { completed: true };
      },
    },
    callbacks: {
      "notify-application": {
        encode: ({ deliveryId, event, payload, attempt }) => ({
          headers: { "x-event-type": event.eventId },
          body: { kind: "json", value: { deliveryId, attempt, ...payload } },
        }),
      },
    },
  });
}

function world(retryDelaysUs: readonly number[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-callback-test-"));
  directories.push(directory);
  const installed = tool(retryDelaysUs);
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_callback01",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "9",
    virtualTimeUs: 0,
    correlationId: "corr_create_cb",
    actors: [
      {
        bindingId: "actor_callback",
        actorId: "operator",
        grants: [{ packageId: "work-items", operationId: "items.complete" }],
      },
    ],
  });
  const kernel = new WorldKernel({ store, packageLockHash: HASH_B, tools: [installed] });
  const invoke = () =>
    kernel.invoke({
      schemaVersion: 1,
      callId: "call_callback01",
      correlationId: "corr_callback01",
      operation: { packageId: "work-items", operationId: "items.complete" },
      actorBindingId: "actor_callback",
      arguments: { itemId: "item_42" },
    });
  return { installed, store, kernel, invoke };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function receiver(
  handle: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void readBody(request)
      .then((body) => handle(request, response, body))
      .catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("receiver has no TCP address");
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-callback-test-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe("outbound callback delivery", () => {
  it("delivers a Tool-encoded event with stable idempotency, HMAC, and causal evidence", async () => {
    const fixture = world();
    const received: ReceivedCallback[] = [];
    const baseUrl = await receiver(async (request, response, body) => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(204);
      response.end();
    });
    const operation = fixture.invoke();
    expect(operation.outcome.status).toBe("ok");
    const queued = fixture.store.nextCallbackDelivery(0);
    expect(queued).toMatchObject({
      callback: { packageId: "work-items", callbackId: "notify-application" },
      receiverId: "application",
      event: { packageId: "work-items", eventId: "item.completed" },
      status: "pending",
    });

    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "delivered", attempt: 1 }] });
    expect(received).toHaveLength(1);
    const callback = received[0];
    expect(callback?.path).toBe("/hooks/items");
    expect(callback?.headers["x-event-type"]).toBe("item.completed");
    expect(callback?.headers["idempotency-key"]).toBe(queued?.id);
    expect(callback?.headers["x-firedrill-signature"]).toBe(
      `sha256=${createHmac("sha256", "callback-secret")
        .update(callback?.body ?? Buffer.alloc(0))
        .digest("hex")}`,
    );
    expect(JSON.parse(callback?.body.toString("utf8") ?? "{}")).toMatchObject({
      deliveryId: queued?.id,
      attempt: 1,
      itemId: "item_42",
    });
    expect(
      fixture.store
        .readEvidence()
        .filter((entry) => entry.kind === "callback")
        .map((entry) => entry.phase),
    ).toEqual(["queued", "attempt_started", "delivered"]);
    fixture.store.close();
  });

  it("retries on virtual time with the same delivery id and then succeeds", async () => {
    const fixture = world([1_000]);
    const received: ReceivedCallback[] = [];
    const baseUrl = await receiver(async (request, response, body) => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(received.length === 1 ? 503 : 204);
      response.end(received.length === 1 ? "try later" : undefined);
    });
    fixture.invoke();
    const deliveryId = fixture.store.nextCallbackDelivery(0)?.id;
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({
      outcomes: [{ deliveryId, status: "retry_scheduled", attempt: 1 }],
    });
    expect(dispatcher.nextDueUs()).toBe(1_000);
    fixture.kernel.advanceTime(1_000, { correlationId: "corr_clock_cb", maxEvents: 0 });
    expect(await dispatcher.dispatchDue()).toMatchObject({
      outcomes: [{ deliveryId, status: "delivered", attempt: 2 }],
    });
    expect(received.map((request) => request.headers["idempotency-key"])).toEqual([deliveryId, deliveryId]);
    expect(received.map((request) => JSON.parse(request.body.toString("utf8")).attempt)).toEqual([1, 2]);
    expect(fixture.store.listCallbackDeliveries("delivered")).toMatchObject([
      { id: deliveryId, attemptCount: 2 },
    ]);
    fixture.store.close();
  });

  it("blocks non-loopback receivers before network access and records an honest failure", async () => {
    const fixture = world();
    fixture.invoke();
    let fetchCalls = 0;
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl: "https://example.invalid", secret: "callback-secret" } },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "failed", attempt: 1 }] });
    expect(fetchCalls).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      kind: "callback",
      phase: "failed",
      error: { code: "framework.CALLBACK_RECEIVER_BLOCKED", retryable: false },
    });
    fixture.store.close();
  });

  it("does not follow receiver redirects", async () => {
    const fixture = world();
    let redirected = 0;
    const baseUrl = await receiver(async (request, response) => {
      if (request.url === "/redirected") {
        redirected += 1;
        response.writeHead(204);
      } else {
        response.writeHead(302, { location: "/redirected" });
      }
      response.end();
    });
    fixture.invoke();
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "failed" }] });
    expect(redirected).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      kind: "callback",
      phase: "failed",
      response: { status: 302 },
      error: { code: "framework.CALLBACK_HTTP_REJECTED" },
    });
    fixture.store.close();
  });
});
