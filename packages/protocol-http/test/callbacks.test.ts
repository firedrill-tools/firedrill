import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallbackCodec, ToolDefinition } from "@firedrill-run/tool-sdk";
import { defineTool } from "@firedrill-run/tool-sdk";
import { WorldKernel } from "@firedrill-run/world-kernel";
import { SqliteWorldStore } from "@firedrill-run/world-store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallbackDispatcherOptions, CallbackTransport, CallbackTransportContext } from "../src/index.js";
import {
  CallbackDispatcher,
  MAX_CALLBACK_HEADER_BYTES,
  MAX_CALLBACK_HEADERS,
  MAX_CALLBACK_REQUEST_BYTES,
  MAX_CALLBACK_RESPONSE_BYTES,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const directories: string[] = [];
const servers: Server[] = [];

interface ReceivedCallback {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

interface CallbackFixtureOptions {
  readonly packageId?: string;
  readonly encode?: ToolCallbackCodec["encode"];
  readonly timeoutMs?: number;
  readonly idempotencyHeader?: string;
}

function tool(retryDelaysUs: readonly number[] = [], options: CallbackFixtureOptions = {}) {
  return defineTool({
    manifest: {
      schemaVersion: 1,
      id: options.packageId ?? "work-items",
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
          idempotencyHeader: options.idempotencyHeader ?? "Idempotency-Key",
          signature: { kind: "hmac-sha256", header: "X-Firedrill-Signature" },
          retry: { delaysUs: retryDelaysUs },
          timeoutMs: options.timeoutMs ?? 1_000,
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
        encode:
          options.encode ??
          (({ deliveryId, event, payload, attempt }) => ({
            headers: { "x-event-type": event.eventId },
            body: { kind: "json", value: { deliveryId, attempt, ...payload } },
          })),
      },
    },
  });
}

function world(retryDelaysUs: readonly number[] = [], options: CallbackFixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-callback-test-"));
  directories.push(directory);
  const installed = tool(retryDelaysUs, options);
  const filePath = join(directory, "world.sqlite");
  const store = SqliteWorldStore.create({
    filePath,
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
  let callCount = 0;
  const invoke = () =>
    kernel.invoke({
      schemaVersion: 1,
      callId: `call_callback${String(++callCount)}`,
      correlationId: "corr_callback01",
      operation: { packageId: "work-items", operationId: "items.complete" },
      actorBindingId: "actor_callback",
      arguments: { itemId: "item_42" },
    });
  return { installed, store, kernel, invoke, directory, filePath };
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

function approvedTransport(origin: string): CallbackTransport {
  return {
    authorizeOrigin: (input) => input.receiverId === "application" && input.origin === origin,
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

function packageWorld() {
  const fixture = world([1_000]);
  const source = tool([1_000], { packageId: "source-events" });
  const tools = [
    fixture.installed,
    defineTool({ manifest: { ...source.manifest, callbacks: [] }, operations: source.operations }),
    tool([1_000], { packageId: "unrelated-items" }),
  ];
  const enqueue = (callbackPackageId: string, eventPackageId = callbackPackageId) =>
    fixture.store.transact("corr_package_callback", (transaction) => {
      const event = { packageId: eventPackageId, eventId: "item.completed" };
      const payload = { itemId: callbackPackageId };
      const deliveryId = transaction.enqueueCallback({
        callback: { packageId: callbackPackageId, callbackId: "notify-application" },
        receiverId: "application",
        event,
        payload,
        eventSequence: transaction.primarySequence,
        dueUs: transaction.virtualTimeUs,
        actorBindingId: "actor_callback",
        retryDelaysUs: [1_000],
      });
      return { value: deliveryId, primary: { kind: "event", event, phase: "emitted", payload } };
    }).value;
  return { ...fixture, tools, enqueue };
}

function scopedKey(identity: readonly unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
}

function twoReceiverWorld(retryDelaysUs: readonly number[] = [1_000]) {
  const fixture = world(retryDelaysUs, {
    encode: (input) => {
      Reflect.set(input, "receiverId", "forged-receiver");
      return {
        headers: { "x-receiver-id": "forged-receiver" },
        body: { kind: "json", value: { deliveryId: input.deliveryId, receiverId: "forged-receiver" } },
      };
    },
  });
  const contract = fixture.installed.manifest.callbacks[0];
  const codec = fixture.installed.callbacks["notify-application"];
  if (contract === undefined || codec === undefined) throw new Error("fixture callback missing");
  const installed = defineTool({
    manifest: {
      ...fixture.installed.manifest,
      callbacks: [contract, { ...contract, id: "notify-audit", receiverId: "audit-sink" }],
    },
    operations: fixture.installed.operations,
    callbacks: { ...fixture.installed.callbacks, "notify-audit": codec },
  });
  const kernel = new WorldKernel({ store: fixture.store, packageLockHash: HASH_B, tools: [installed] });
  const invoke = () =>
    kernel.invoke({
      schemaVersion: 1,
      callId: "call_receiver_lookup",
      correlationId: "corr_receiver_lookup",
      operation: { packageId: "work-items", operationId: "items.complete" },
      actorBindingId: "actor_callback",
      arguments: { itemId: "item_42" },
    });
  return { ...fixture, installed, kernel, invoke };
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
  it("resolves only each due receiver and keeps unavailable same-origin receivers independent on fresh dispatchers", async () => {
    const fixture = twoReceiverWorld();
    const received: ReceivedCallback[] = [];
    const baseUrl = await receiver((request, response, body) => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(received.length === 1 ? 503 : 204);
      response.end();
    });
    let secret = "test-only-first-key";
    const resolveReceiver = vi.fn<NonNullable<CallbackDispatcherOptions["resolveReceiver"]>>(
      async (context, signal) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.keys(context)).toEqual(["receiverId"]);
        expect(Reflect.set(context, "receiverId", "forged-receiver")).toBe(false);
        signal.throwIfAborted();
        if (context.receiverId === "audit-sink") throw new Error(`unsafe lookup diagnostic: ${secret}`);
        return { baseUrl, secret };
      },
    );
    const wire = vi.fn<CallbackTransport["fetch"]>((input, init, context) => {
      const lookup = resolveReceiver.mock.calls.at(-1);
      expect(context).toBe(lookup?.[0]);
      expect(init?.signal).toBe(lookup?.[1]);
      return globalThis.fetch(input, init);
    });
    const options = {
      store: fixture.store,
      tools: [fixture.installed],
      resolveReceiver,
      idempotencyScope: "lazy-receiver-execution",
      transport: { authorizeOrigin: ({ origin }: { origin: string }) => origin === baseUrl, fetch: wire },
    };
    const first = new CallbackDispatcher(options);
    expect(resolveReceiver).not.toHaveBeenCalled();
    expect(await first.dispatchDue()).toEqual({ outcomes: [] });
    expect(resolveReceiver).not.toHaveBeenCalled();
    expect(fixture.invoke().outcome.status).toBe("ok");
    const queued = fixture.store.listCallbackDeliveries("pending");
    expect((await first.dispatchDue()).outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "failed",
      "retry_scheduled",
    ]);
    expect(resolveReceiver.mock.calls.map(([context]) => context.receiverId).sort()).toEqual([
      "application",
      "audit-sink",
    ]);
    expect(received).toHaveLength(1);
    const failure = fixture.store
      .readEvidence()
      .find((entry) => entry.kind === "callback" && entry.phase === "failed");
    expect(failure).toMatchObject({
      receiverId: "audit-sink",
      error: { code: "framework.CALLBACK_RECEIVER_UNAVAILABLE", retryable: false },
    });
    expect(failure).not.toHaveProperty("request");
    expect(failure).not.toHaveProperty("response");
    expect(
      fixture.store
        .readEvidence()
        .filter((entry) => entry.kind === "callback" && entry.receiverId === "audit-sink")
        .map((entry) => entry.phase),
    ).toEqual(["queued", "failed"]);
    const again = new CallbackDispatcher(options);
    expect(resolveReceiver).toHaveBeenCalledTimes(2);
    expect(await again.dispatchDue()).toEqual({ outcomes: [] });
    expect(resolveReceiver).toHaveBeenCalledTimes(2);
    secret = "test-only-fresh-key";
    fixture.kernel.advanceTime(1_000, { correlationId: "corr_lookup_retry", maxEvents: 0 });
    expect(await again.dispatchDue()).toMatchObject({ outcomes: [{ status: "delivered", attempt: 2 }] });
    expect(resolveReceiver).toHaveBeenCalledTimes(3);
    expect(wire).toHaveBeenCalledTimes(2);
    expect(new Set(resolveReceiver.mock.calls.map(([context]) => context)).size).toBe(3);
    const delivery = queued.find((entry) => entry.receiverId === "application");
    expect(delivery).toBeDefined();
    for (const [index, request] of received.entries()) {
      expect(request.headers["x-receiver-id"]).toBe("forged-receiver");
      expect(request.headers["idempotency-key"]).toBe(scopedKey(["lazy-receiver-execution", delivery?.id]));
      expect(request.headers["x-firedrill-signature"]).toBe(
        `sha256=${createHmac("sha256", index === 0 ? "test-only-first-key" : secret)
          .update(request.body)
          .digest("hex")}`,
      );
    }
    const evidence = JSON.stringify(fixture.store.readEvidence());
    expect(evidence).not.toContain("test-only-first-key");
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("unsafe lookup diagnostic");
    fixture.store.close();
  });

  it("requires exactly one receiver source without invoking a resolver", () => {
    const fixture = world();
    const resolveReceiver = vi.fn(async () => undefined);
    const base = { store: fixture.store, tools: [fixture.installed] };
    for (const invalid of [base, { ...base, receivers: {}, resolveReceiver }]) {
      expect(() => new CallbackDispatcher(invalid)).toThrow(/exactly one/);
    }
    expect(
      () =>
        new CallbackDispatcher({
          ...base,
          resolveReceiver: "invalid",
        } as unknown as CallbackDispatcherOptions),
    ).toThrow(/must be a function/);
    expect(resolveReceiver).not.toHaveBeenCalled();
    fixture.store.close();
  });

  it.each(["missing", "error", "range", "getter"] as const)(
    "records a safe failed-only lookup result for %s",
    async (kind) => {
      const fixture = world([1_000]);
      fixture.invoke();
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      const resolver: NonNullable<CallbackDispatcherOptions["resolveReceiver"]> = async () => {
        if (kind === "missing") return undefined;
        if (kind === "error") throw new Error("test-secret-provider-diagnostic");
        if (kind === "range") throw new RangeError("test-secret-provider-diagnostic");
        return {
          get baseUrl(): string {
            throw new Error("test-secret-provider-diagnostic");
          },
        };
      };
      await new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        resolveReceiver: resolver,
        fetch,
      }).dispatchDue();
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.store.listCallbackDeliveries("failed")).toMatchObject([{ attemptCount: 1 }]);
      const evidence = fixture.store.readEvidence().filter((entry) => entry.kind === "callback");
      expect(evidence.map((entry) => entry.phase)).toEqual(["queued", "failed"]);
      expect(evidence.at(-1)).toMatchObject({
        error: {
          code: `framework.${kind === "missing" ? "CALLBACK_RECEIVER_MISSING" : "CALLBACK_RECEIVER_UNAVAILABLE"}`,
          retryable: false,
        },
      });
      expect(evidence.at(-1)).not.toHaveProperty("request");
      expect(evidence.at(-1)).not.toHaveProperty("response");
      expect(JSON.stringify(evidence)).not.toContain("test-secret-provider-diagnostic");
      fixture.store.close();
    },
  );

  it.each(["cancel", "timeout"] as const)(
    "drains %s during lookup before settling, without claiming a wire attempt",
    async (mode) => {
      const fixture = world([], { timeoutMs: 100 });
      fixture.invoke();
      const before = fixture.store.readEvidence();
      let entered!: () => void;
      let aborted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const interrupted = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = true;
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      const dispatcher = new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        fetch,
        resolveReceiver: async (_context, signal) => {
          entered();
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted();
                resolve();
              },
              { once: true },
            ),
          );
          await cleanup;
          active = false;
          throw new Error("test-secret-late-lookup-error");
        },
      });
      const controller = new AbortController();
      let settled = false;
      const pending = dispatcher.dispatchDue(controller.signal);
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const assertion =
        mode === "cancel"
          ? expect(pending).rejects.toThrow("caller stops lookup")
          : expect(pending).resolves.toMatchObject({ outcomes: [{ status: "failed" }] });
      await started;
      if (mode === "cancel") controller.abort(new Error("caller stops lookup"));
      await interrupted;
      expect(settled).toBe(false);
      expect(active).toBe(true);
      expect(fixture.store.readEvidence()).toEqual(before);
      expect(fixture.store.nextCallbackDelivery(0)).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(() => dispatcher.recoverInFlight()).toThrow(/active dispatch/);
      release();
      await assertion;
      expect(active).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      if (mode === "cancel") {
        expect(fixture.store.readEvidence()).toEqual(before);
        expect(fixture.store.nextCallbackDelivery(0)).toMatchObject({ status: "pending", attemptCount: 0 });
      } else {
        const evidence = fixture.store.readEvidence().filter((entry) => entry.kind === "callback");
        expect(evidence.map((entry) => entry.phase)).toEqual(["queued", "failed"]);
        expect(evidence.at(-1)).toMatchObject({
          error: { code: "framework.CALLBACK_RECEIVER_TIMEOUT", retryable: false },
        });
      }
      expect(JSON.stringify(fixture.store.readEvidence())).not.toContain("test-secret-late-lookup-error");
      fixture.store.close();
    },
  );

  it("uses one deadline signal across lookup and transport cleanup", async () => {
    const fixture = world([], { timeoutMs: 100 });
    fixture.invoke();
    let seenSignal: AbortSignal | undefined;
    let seenContext: CallbackTransportContext | undefined;
    let entered!: () => void;
    let interrupted!: () => void;
    let releaseCleanup!: () => void;
    const transportStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transportAborted = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let transportSettled = false;
    let active = false;
    const baseUrl = "http://127.0.0.1:4319";
    vi.useFakeTimers({ toFake: ["clearTimeout", "performance", "setTimeout"] });
    try {
      const dispatcher = new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        idempotencyScope: "shared-lookup-budget",
        resolveReceiver: async (context, signal) => {
          seenSignal = signal;
          seenContext = context;
          await new Promise((resolve) => setTimeout(resolve, 65));
          return { baseUrl, secret: "test-only-key" };
        },
        transport: {
          ...approvedTransport(baseUrl),
          fetch: async (_input, init, context) => {
            expect(context).toBe(seenContext);
            const signal = init?.signal;
            expect(signal).toBe(seenSignal);
            if (signal === undefined || signal === null) throw new Error("callback signal missing");
            active = true;
            entered();
            try {
              await new Promise<void>((resolve) =>
                signal.addEventListener(
                  "abort",
                  () => {
                    interrupted();
                    resolve();
                  },
                  { once: true },
                ),
              );
              await cleanup;
              throw signal.reason;
            } finally {
              active = false;
              transportSettled = true;
            }
          },
        },
      });
      let settled = false;
      const pending = dispatcher.dispatchDue();
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(65);
      await transportStarted;
      expect(seenSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(34);
      expect(seenSignal?.aborted).toBe(false);
      expect(active).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await transportAborted;
      expect(seenSignal?.aborted).toBe(true);
      expect(active).toBe(true);
      expect(settled).toBe(false);

      releaseCleanup();
      expect(await pending).toMatchObject({ outcomes: [{ status: "failed" }] });
      expect(transportSettled).toBe(true);
      expect(active).toBe(false);
      expect(fixture.store.readEvidence().at(-1)).toMatchObject({
        error: { code: "framework.CALLBACK_TIMEOUT" },
      });
    } finally {
      releaseCleanup();
      vi.useRealTimers();
      fixture.store.close();
    }
  });

  it.each(["cancel", "timeout"] as const)(
    "does not send HTTP after synchronous preparation %s",
    async (mode) => {
      const controller = new AbortController();
      const fixture = world([], {
        timeoutMs: 100,
        encode: () => {
          if (mode === "cancel") controller.abort(new Error("cancel during codec"));
          else {
            const end = performance.now() + 120;
            while (performance.now() < end) {
              /* synchronous codec */
            }
          }
          return { body: { kind: "empty" } };
        },
      });
      fixture.invoke();
      const before = fixture.store.readEvidence();
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      const dispatcher = new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        fetch,
        resolveReceiver: async () => ({ baseUrl: "http://127.0.0.1:4319", secret: "test-only-key" }),
      });
      if (mode === "cancel") {
        await expect(dispatcher.dispatchDue(controller.signal)).rejects.toThrow("cancel during codec");
        expect(fixture.store.readEvidence()).toEqual(before);
      } else {
        await dispatcher.dispatchDue();
        expect(fixture.store.readEvidence().at(-1)).toMatchObject({
          error: { code: "framework.CALLBACK_PREPARATION_TIMEOUT" },
        });
        expect(
          fixture.store
            .readEvidence()
            .filter((entry) => entry.kind === "callback")
            .map((entry) => entry.phase),
        ).toEqual(["queued", "failed"]);
      }
      expect(fetch).not.toHaveBeenCalled();
      fixture.store.close();
    },
  );

  it("publishes drain ownership before a receiver resolver synchronously reenters dispatch", async () => {
    const fixture = world();
    fixture.invoke();
    let joined: ReturnType<CallbackDispatcher["dispatchDue"]> | undefined;
    let lookups = 0;
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      resolveReceiver: async () => {
        lookups += 1;
        if (lookups > 1) throw new Error("receiver lookup reentered before ownership");
        joined = dispatcher.dispatchDue();
        return undefined;
      },
    });
    const result = await dispatcher.dispatchDue();
    expect(await joined).toEqual(result);
    expect(lookups).toBe(1);
    expect(
      fixture.store
        .readEvidence()
        .filter((entry) => entry.kind === "callback")
        .map((entry) => entry.phase),
    ).toEqual(["queued", "failed"]);
    fixture.store.close();
  });
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

  it("preserves the ordinary two-argument test fetch call", async () => {
    const fixture = world();
    let requests = 0;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.writeHead(204);
      response.end();
    });
    fixture.invoke();
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      fetch: (...args: Parameters<typeof globalThis.fetch>) => {
        expect(args).toHaveLength(2);
        return globalThis.fetch(...args);
      },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "delivered" }] });
    expect(requests).toBe(1);
    fixture.store.close();
  });

  it("supplies immutable receiver context for independent same-origin attempts and retries", async () => {
    const fixture = world([1_000], {
      encode: (input) => {
        // Mutating the codec's input or naming a receiver in HTTP data cannot
        // change the independent context derived from the durable delivery.
        Reflect.set(input, "receiverId", "forged-receiver");
        return {
          headers: { "x-receiver-id": "forged-receiver" },
          body: { kind: "json", value: { receiverId: "forged-receiver" } },
        };
      },
    });
    const contract = fixture.installed.manifest.callbacks[0];
    const codec = fixture.installed.callbacks["notify-application"];
    if (contract === undefined || codec === undefined) throw new Error("fixture callback missing");
    const installed = defineTool({
      manifest: {
        ...fixture.installed.manifest,
        callbacks: [contract, { ...contract, id: "notify-secondary", receiverId: "secondary" }],
      },
      operations: fixture.installed.operations,
      callbacks: { ...fixture.installed.callbacks, "notify-secondary": codec },
    });
    const kernel = new WorldKernel({ store: fixture.store, packageLockHash: HASH_B, tools: [installed] });
    kernel.invoke({
      schemaVersion: 1,
      callId: "call_receiver_context",
      correlationId: "corr_receiver_context",
      operation: { packageId: "work-items", operationId: "items.complete" },
      actorBindingId: "actor_callback",
      arguments: { itemId: "item_42" },
    });
    const received: ReceivedCallback[] = [];
    let retry = false;
    const baseUrl = await receiver((request, response, body) => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(retry ? 204 : 503);
      response.end();
    });
    const contexts: CallbackTransportContext[] = [];
    const urls: string[] = [];
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [installed],
      receivers: {
        application: { baseUrl, secret: "callback-secret" },
        secondary: { baseUrl, secret: "callback-secret" },
      },
      idempotencyScope: "receiver-context-execution",
      transport: {
        authorizeOrigin: ({ receiverId, origin }) =>
          ["application", "secondary"].includes(receiverId) && origin === baseUrl,
        fetch: async (input, init, context) => {
          if (context === undefined) throw new Error("receiver context missing");
          expect(Object.isFrozen(context)).toBe(true);
          expect(Reflect.set(context, "receiverId", "forged-receiver")).toBe(false);
          expect(Reflect.set(context, "extra", "forged-value")).toBe(false);
          contexts.push(context);
          urls.push(String(input));
          if (retry && context.receiverId === "application") throw new Error("receiver no longer approved");
          return globalThis.fetch(input, init);
        },
      },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({
      outcomes: [{ status: "retry_scheduled" }, { status: "retry_scheduled" }],
    });
    retry = true;
    kernel.advanceTime(1_000, { correlationId: "corr_receiver_retry", maxEvents: 0 });
    const result = await dispatcher.dispatchDue();
    expect(result.outcomes.map((outcome) => outcome.status).sort()).toEqual(["delivered", "failed"]);
    expect(contexts.map((context) => context.receiverId).sort()).toEqual([
      "application",
      "application",
      "secondary",
      "secondary",
    ]);
    expect(contexts.every((context) => Object.keys(context).join() === "receiverId")).toBe(true);
    expect(new Set(contexts).size).toBe(4);
    expect(urls).toEqual(Array.from({ length: 4 }, () => `${baseUrl}/hooks/items`));
    expect(received).toHaveLength(3);
    for (const request of received) {
      expect(request.headers["x-receiver-id"]).toBe("forged-receiver");
      expect(JSON.parse(request.body.toString("utf8"))).toEqual({ receiverId: "forged-receiver" });
    }
    expect(fixture.store.listCallbackDeliveries("delivered")).toMatchObject([{ receiverId: "secondary" }]);
    expect(fixture.store.listCallbackDeliveries("failed")).toMatchObject([{ receiverId: "application" }]);
    fixture.store.close();
  });

  it("requires explicit approval for an origin outside the local default and preserves bounded signed HTTP", async () => {
    const received: ReceivedCallback[] = [];
    const localUrl = await receiver((request, response, body) => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(204);
      response.end();
    });
    // An IPv4-mapped address reaches this real TCP listener but is outside the default hostname list.
    const baseUrl = new URL(localUrl.replace("127.0.0.1", "[::ffff:127.0.0.1]")).origin;
    const blocked = world();
    blocked.invoke();
    await new CallbackDispatcher({
      store: blocked.store,
      tools: [blocked.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
    }).dispatchDue();
    expect(received).toHaveLength(0);
    expect(blocked.store.readEvidence().at(-1)).toMatchObject({
      error: { code: "framework.CALLBACK_RECEIVER_BLOCKED", retryable: false },
    });
    blocked.store.close();

    const fixture = world();
    fixture.invoke();
    const deliveryId = fixture.store.nextCallbackDelivery(0)?.id;
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      transport: approvedTransport(baseUrl),
      idempotencyScope: "execution-1",
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "delivered" }] });
    const expectedKey = `sha256:${createHash("sha256")
      .update(JSON.stringify(["execution-1", deliveryId]))
      .digest("hex")}`;
    expect(received).toHaveLength(1);
    expect(received[0]?.headers["idempotency-key"]).toBe(expectedKey);
    expect(received[0]?.headers["x-firedrill-signature"]).toBe(
      `sha256=${createHmac("sha256", "callback-secret")
        .update(received[0]?.body ?? Buffer.alloc(0))
        .digest("hex")}`,
    );
    expect(
      fixture.store
        .readEvidence()
        .find((entry) => entry.kind === "callback" && entry.phase === "attempt_started"),
    ).toMatchObject({ idempotencyKey: deliveryId, request: { idempotencyKey: expectedKey } });
    expect(JSON.stringify(fixture.store.readEvidence())).not.toContain(baseUrl);
    expect(JSON.stringify(fixture.store.readEvidence())).not.toContain("callback-secret");
    expect(JSON.stringify(fixture.store.readEvidence())).not.toContain("execution-1");
    fixture.store.close();
  });

  it("reauthorizes each retry without reaching an unapproved receiver", async () => {
    const fixture = world([1_000]);
    let requests = 0;
    let approved = true;
    const decisions: unknown[] = [];
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.writeHead(503);
      response.end();
    });
    fixture.invoke();
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      idempotencyScope: "execution-revocation",
      transport: {
        authorizeOrigin: (input) => {
          decisions.push(input);
          return approved && input.receiverId === "application" && input.origin === baseUrl;
        },
        fetch: globalThis.fetch,
      },
    });
    await dispatcher.dispatchDue();
    approved = false;
    fixture.kernel.advanceTime(1_000, { correlationId: "corr_revoke", maxEvents: 0 });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "failed", attempt: 2 }] });
    expect(requests).toBe(1);
    expect(decisions).toEqual([
      { receiverId: "application", origin: baseUrl },
      { receiverId: "application", origin: baseUrl },
    ]);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      error: { code: "framework.CALLBACK_RECEIVER_BLOCKED", retryable: false },
    });
    fixture.store.close();
  });

  it("keeps scoped keys stable across actual retries and distinct when reset repeats a delivery ID", async () => {
    const fixture = world([1_000]);
    const snapshot = join(fixture.directory, "baseline.sqlite");
    fixture.store.createSnapshot(snapshot, "corr_scope_snapshot");
    const keys: (string | string[] | undefined)[] = [];
    const baseUrl = await receiver((request, response) => {
      keys.push(request.headers["idempotency-key"]);
      response.writeHead(keys.length === 1 ? 503 : 204);
      response.end();
    });
    const dispatcher = (idempotencyScope: string) =>
      new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope,
      });
    fixture.invoke();
    const originalId = fixture.store.nextCallbackDelivery(0)?.id;
    await dispatcher("execution-before-reset").dispatchDue();
    fixture.kernel.advanceTime(1_000, { correlationId: "corr_scope_retry", maxEvents: 0 });
    await dispatcher("execution-before-reset").dispatchDue();
    expect(keys[1]).toBe(keys[0]);
    fixture.store.resetFromSnapshot(snapshot, "corr_scope_reset");
    fixture.invoke();
    expect(fixture.store.nextCallbackDelivery(0)?.id).toBe(originalId);
    await dispatcher("execution-after-reset").dispatchDue();
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
    fixture.store.close();
  });

  it.each(["work-items", "source-events"])(
    "changes keys for a SQLite reset of %s while retaining unrelated retry keys",
    async (resetPackage) => {
      const fixture = packageWorld();
      const affectedId = fixture.enqueue("work-items", "source-events");
      const unrelatedId = fixture.enqueue("unrelated-items");
      const snapshot = join(fixture.directory, "package-baseline.sqlite");
      fixture.store.createSnapshot(snapshot, "corr_package_snapshot");
      const received = new Map<string, unknown[]>();
      const baseUrl = await receiver((request, response, body) => {
        const itemId = (JSON.parse(body.toString("utf8")) as { itemId: string }).itemId;
        const keys = received.get(itemId) ?? [];
        keys.push(request.headers["idempotency-key"]);
        received.set(itemId, keys);
        response.writeHead(
          (itemId === "work-items" && keys.length === 2) ||
            (itemId === "unrelated-items" && keys.length === 1)
            ? 503
            : 204,
        );
        response.end();
      });
      const options = {
        store: fixture.store,
        tools: fixture.tools,
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "unchanged-world-execution",
      };
      await new CallbackDispatcher(options).dispatchDue();
      expect(fixture.store.listCallbackDeliveries("delivered")).toMatchObject([{ id: affectedId }]);
      expect(fixture.store.listCallbackDeliveries("pending")).toMatchObject([{ id: unrelatedId }]);
      fixture.store.resetPackagesFromSnapshot(snapshot, [resetPackage], "corr_package_reset");
      expect(fixture.store.nextCallbackDelivery(0)?.id).toBe(affectedId);
      const dispatcher = new CallbackDispatcher({
        ...options,
        idempotencyScopeByPackage: { [resetPackage]: "reset-package-execution" },
      });
      expect(await dispatcher.dispatchDue()).toMatchObject({
        outcomes: [{ deliveryId: affectedId, status: "retry_scheduled", attempt: 1 }],
      });
      fixture.kernel.advanceTime(1_000, { correlationId: "corr_package_retry", maxEvents: 0 });
      expect(await dispatcher.dispatchDue()).toMatchObject({
        outcomes: expect.arrayContaining([
          { deliveryId: affectedId, status: "delivered", attempt: 2 },
          { deliveryId: unrelatedId, status: "delivered", attempt: 2 },
        ]),
      });
      const originalAffectedKey = scopedKey([options.idempotencyScope, affectedId]);
      const resetAffectedKey = scopedKey([
        options.idempotencyScope,
        affectedId,
        [[resetPackage, "reset-package-execution"]],
      ]);
      expect(resetAffectedKey).not.toBe(originalAffectedKey);
      expect(received.get("work-items")).toEqual([originalAffectedKey, resetAffectedKey, resetAffectedKey]);
      const unrelatedKey = scopedKey([options.idempotencyScope, unrelatedId]);
      expect(received.get("unrelated-items")).toEqual([unrelatedKey, unrelatedKey]);
      fixture.store.close();
    },
  );

  it("copies package scopes and hashes sorted unique owner/event pairs independently of input order", async () => {
    const fixture = packageWorld();
    const crossPackageId = fixture.enqueue("work-items", "source-events");
    const samePackageId = fixture.enqueue("work-items");
    const snapshot = join(fixture.directory, "scope-map-baseline.sqlite");
    fixture.store.createSnapshot(snapshot, "corr_map_snapshot");
    const received: { deliveryId: string; key: unknown }[] = [];
    const baseUrl = await receiver((request, response, body) => {
      const { deliveryId } = JSON.parse(body.toString("utf8")) as { deliveryId: string };
      received.push({ deliveryId, key: request.headers["idempotency-key"] });
      response.writeHead(204);
      response.end();
    });
    for (const reversed of [false, true]) {
      const entries = [
        ["work-items", "callback-owner-scope"],
        ["source-events", "source-event-scope"],
        ["unrelated-items", "unrelated-scope"],
      ];
      const scopes: Record<string, string> = Object.fromEntries(reversed ? entries.reverse() : entries);
      const dispatcher = new CallbackDispatcher({
        store: fixture.store,
        tools: fixture.tools,
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "base-execution",
        idempotencyScopeByPackage: scopes,
      });
      scopes["work-items"] = "changed-after-construction";
      delete scopes["source-events"];
      scopes["unknown-package"] = "added-after-construction";
      await dispatcher.dispatchDue();
      fixture.store.resetFromSnapshot(snapshot, "corr_map_restore");
    }
    const expected = [
      {
        deliveryId: crossPackageId,
        key: scopedKey([
          "base-execution",
          crossPackageId,
          [
            ["source-events", "source-event-scope"],
            ["work-items", "callback-owner-scope"],
          ],
        ]),
      },
      {
        deliveryId: samePackageId,
        key: scopedKey(["base-execution", samePackageId, [["work-items", "callback-owner-scope"]]]),
      },
    ];
    expect(received.slice(0, 2)).toEqual(expect.arrayContaining(expected));
    expect(received.slice(2)).toEqual(received.slice(0, 2));
    fixture.store.close();
  });

  it.each([{}, { "source-events": "unrelated-scope" }])(
    "preserves the existing scoped key when no package override applies: %j",
    async (idempotencyScopeByPackage) => {
      const fixture = packageWorld();
      const deliveryId = fixture.enqueue("work-items");
      const keys: unknown[] = [];
      const baseUrl = await receiver((request, response) => {
        keys.push(request.headers["idempotency-key"]);
        response.writeHead(204);
        response.end();
      });
      await new CallbackDispatcher({
        store: fixture.store,
        tools: fixture.tools,
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        idempotencyScope: "existing-scope",
        idempotencyScopeByPackage,
      }).dispatchDue();
      expect(keys).toEqual([scopedKey(["existing-scope", deliveryId])]);
      fixture.store.close();
    },
  );

  it.each([false, true])(
    "recovers an uncertain SQLite delivery (package-scoped: %s)",
    async (packageScoped) => {
      const fixture = world([1_000]);
      const scopeOptions = packageScoped
        ? { idempotencyScopeByPackage: { "work-items": "recoverable-package-execution" } }
        : {};
      const keys: (string | string[] | undefined)[] = [];
      const baseUrl = await receiver((request, response) => {
        keys.push(request.headers["idempotency-key"]);
        response.writeHead(204);
        response.end();
      });
      fixture.invoke();
      const dispatcher = new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        idempotencyScope: "recoverable-execution",
        ...scopeOptions,
        transport: {
          ...approvedTransport(baseUrl),
          fetch: async (input, init) => {
            const response = await globalThis.fetch(input, init);
            fixture.store.close(); // Crash boundary: receiver accepted, but delivery settlement cannot commit.
            return response;
          },
        },
      });
      await expect(dispatcher.dispatchDue()).rejects.toThrow();
      const reopened = SqliteWorldStore.open(fixture.filePath);
      expect(reopened.listCallbackDeliveries("in_flight")).toHaveLength(1);
      const recovered = new CallbackDispatcher({
        store: reopened,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "recoverable-execution",
        ...scopeOptions,
      });
      expect(recovered.recoverInFlight()).toBe(1);
      new WorldKernel({ store: reopened, packageLockHash: HASH_B, tools: [fixture.installed] }).advanceTime(
        1_000,
        { correlationId: "corr_scope_recover", maxEvents: 0 },
      );
      expect(await recovered.dispatchDue()).toMatchObject({
        outcomes: [{ status: "delivered", attempt: 2 }],
      });
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(reopened.listCallbackDeliveries("in_flight")).toEqual([]);
      expect(
        reopened
          .readEvidence()
          .filter((entry) => entry.kind === "callback")
          .map((entry) => entry.phase),
      ).toEqual(["queued", "attempt_started", "recovered", "attempt_started", "delivered"]);
      reopened.close();
    },
  );

  it("rejects missing or oversized execution scopes and ambiguous transport configuration", () => {
    const fixture = world();
    const options = {
      store: fixture.store,
      tools: [fixture.installed],
      receivers: {},
      transport: approvedTransport("http://127.0.0.1"),
    };
    expect(() => new CallbackDispatcher(options)).toThrow(/requires an idempotency scope/);
    for (const idempotencyScope of ["", " \n ", "x".repeat(1025), "é".repeat(513)]) {
      expect(() => new CallbackDispatcher({ ...options, idempotencyScope })).toThrow(/idempotency scope/);
    }
    expect(
      () => new CallbackDispatcher({ ...options, idempotencyScope: "valid", fetch: globalThis.fetch }),
    ).toThrow(/cannot be supplied together/);
    fixture.store.close();
  });

  it("rejects invalid package scope maps before dispatch and requires a base even for an empty map", () => {
    const fixture = world();
    const options = { store: fixture.store, tools: [fixture.installed], receivers: {} };
    for (const idempotencyScopeByPackage of [{}, { "work-items": "package-scope" }]) {
      expect(() => new CallbackDispatcher({ ...options, idempotencyScopeByPackage })).toThrow(
        /require a base idempotency scope/,
      );
    }
    const invalidMaps: readonly unknown[] = [
      null,
      [],
      new Map([["work-items", "scope"]]),
      "scope",
      { "unknown-package": "scope" },
      { "invalid package": "scope" },
      { "": "scope" },
      { [Symbol("work-items")]: "scope" },
      { "work-items": "" },
      { "work-items": " \n " },
      { "work-items": "x".repeat(1025) },
      { "work-items": "é".repeat(513) },
      { "work-items": 42 },
      { "work-items": null },
      { "work-items": undefined },
    ];
    for (const idempotencyScopeByPackage of invalidMaps) {
      expect(
        () =>
          new CallbackDispatcher({
            ...options,
            idempotencyScope: "valid-base",
            idempotencyScopeByPackage,
          } as CallbackDispatcherOptions),
      ).toThrow(/callback package idempotency scope/);
    }
    expect(
      () =>
        new CallbackDispatcher({
          ...options,
          idempotencyScope: "valid-base",
          idempotencyScopeByPackage: { "work-items": "é".repeat(512) },
        }),
    ).not.toThrow();
    fixture.store.close();
  });

  it.each([
    "http://name:password@127.0.0.1",
    "http://127.0.0.1/path",
    "http://127.0.0.1?token=value",
    "http://127.0.0.1#fragment",
    "file:///tmp/receiver",
  ])("does not let explicit approval bypass origin structure: %s", async (baseUrl) => {
    const fixture = world();
    fixture.invoke();
    let authorized = 0;
    let fetched = 0;
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      idempotencyScope: "structural-negative",
      transport: {
        authorizeOrigin: () => {
          authorized += 1;
          return true;
        },
        fetch: async () => {
          fetched += 1;
          return new Response(null, { status: 204 });
        },
      },
    });
    expect(await dispatcher.dispatchDue()).toMatchObject({ outcomes: [{ status: "failed" }] });
    expect(authorized).toBe(0);
    expect(fetched).toBe(0);
    fixture.store.close();
  });

  it.each([
    "//example.invalid/hook",
    "/\\example.invalid/hook",
    "/x/../hook",
    "/%2e%2e/hook",
    "/hook?query=1",
    "/hook#fragment",
  ])("blocks malformed source paths before origin authorization: %s", async (path) => {
    const fixture = world();
    fixture.invoke();
    let requests = 0;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.end();
    });
    const malformed: ToolDefinition = {
      ...fixture.installed,
      manifest: {
        ...fixture.installed.manifest,
        callbacks: fixture.installed.manifest.callbacks.map((contract) => ({ ...contract, path })),
      },
    };
    expect(
      await new CallbackDispatcher({
        store: fixture.store,
        tools: [malformed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "path-negative",
      }).dispatchDue(),
    ).toMatchObject({ outcomes: [{ status: "failed" }] });
    expect(requests).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      error: { code: "framework.CALLBACK_REQUEST_INVALID", retryable: false },
    });
    fixture.store.close();
  });

  it.each([
    { headers: { "IDEMPOTENCY-KEY": "spoofed" }, body: { kind: "empty" as const } },
    { headers: { "x-firedrill-signature": "spoofed" }, body: { kind: "empty" as const } },
    { headers: { host: "example.invalid" }, body: { kind: "empty" as const } },
    { url: "https://example.invalid", body: { kind: "empty" as const } },
    { receiverId: "forged-receiver", body: { kind: "empty" as const } },
    { context: { receiverId: "forged-receiver" }, body: { kind: "empty" as const } },
  ])("does not let a codec override destination or delivery headers: %j", async (encoded) => {
    const fixture = world([], { encode: () => encoded });
    let requests = 0;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.end();
    });
    fixture.invoke();
    expect(
      await new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "codec-negative",
      }).dispatchDue(),
    ).toMatchObject({ outcomes: [{ status: "failed" }] });
    expect(requests).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      error: { code: "framework.CALLBACK_REQUEST_INVALID", retryable: false },
    });
    fixture.store.close();
  });

  it.each(["host", "content-length", "transfer-encoding"])(
    "rejects forbidden contract delivery header %s",
    async (idempotencyHeader) => {
      const fixture = world([], { idempotencyHeader });
      fixture.invoke();
      let requests = 0;
      const baseUrl = await receiver((_request, response) => {
        requests += 1;
        response.end();
      });
      await new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "header-negative",
      }).dispatchDue();
      expect(requests).toBe(0);
      expect(fixture.store.readEvidence().at(-1)).toMatchObject({
        error: { code: "framework.CALLBACK_REQUEST_INVALID" },
      });
      fixture.store.close();
    },
  );

  it("retains redirect rejection through an explicitly approved actual HTTP transport", async () => {
    const fixture = world();
    let redirected = 0;
    const destination = await receiver((_request, response) => {
      redirected += 1;
      response.end();
    });
    const baseUrl = await receiver((_request, response) => {
      response.writeHead(307, { location: `${destination}/should-not-arrive` });
      response.end();
    });
    fixture.invoke();
    await new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      transport: approvedTransport(baseUrl),
      idempotencyScope: "redirect-negative",
    }).dispatchDue();
    expect(redirected).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      response: { status: 307 },
      error: { code: "framework.CALLBACK_HTTP_REJECTED" },
    });
    fixture.store.close();
  });

  it.each([
    {
      encode: () => ({ body: { kind: "text" as const, value: "x".repeat(MAX_CALLBACK_REQUEST_BYTES + 1) } }),
      code: "CALLBACK_REQUEST_TOO_LARGE",
    },
    {
      encode: () => ({
        headers: { "x-long": "x".repeat(MAX_CALLBACK_HEADER_BYTES) },
        body: { kind: "empty" as const },
      }),
      code: "CALLBACK_REQUEST_INVALID",
    },
    {
      encode: () => ({
        headers: Object.fromEntries(
          Array.from({ length: MAX_CALLBACK_HEADERS + 1 }, (_, index) => [`x-${String(index)}`, "v"]),
        ),
        body: { kind: "empty" as const },
      }),
      code: "CALLBACK_REQUEST_INVALID",
    },
  ])("retains request byte/header bounds with explicit transport: $code", async ({ encode, code }) => {
    const fixture = world([], { encode });
    let requests = 0;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.end();
    });
    fixture.invoke();
    await new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      transport: approvedTransport(baseUrl),
      idempotencyScope: "bounds-negative",
    }).dispatchDue();
    expect(requests).toBe(0);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({ error: { code: `framework.${code}` } });
    fixture.store.close();
  });

  it.each([true, false])(
    "bounds actual HTTP response bytes (declared content length: %s)",
    async (declared) => {
      const fixture = world();
      const baseUrl = await receiver((_request, response) => {
        response.writeHead(200, declared ? { "content-length": MAX_CALLBACK_RESPONSE_BYTES + 1 } : {});
        response.write(Buffer.alloc(MAX_CALLBACK_RESPONSE_BYTES));
        response.end("x");
      });
      fixture.invoke();
      await new CallbackDispatcher({
        store: fixture.store,
        tools: [fixture.installed],
        receivers: { application: { baseUrl, secret: "callback-secret" } },
        transport: approvedTransport(baseUrl),
        idempotencyScope: "response-negative",
      }).dispatchDue();
      expect(fixture.store.listCallbackDeliveries("in_flight")).toEqual([]);
      expect(fixture.store.readEvidence().at(-1)).toMatchObject({
        error: { code: "framework.CALLBACK_RESPONSE_TOO_LARGE", retryable: true },
      });
      fixture.store.close();
    },
  );

  it("times out an actual incomplete HTTP response and settles the delivery", async () => {
    const fixture = world([], { timeoutMs: 100 });
    const baseUrl = await receiver((_request, response) => {
      response.writeHead(200);
      response.write("unfinished");
    });
    fixture.invoke();
    await new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      transport: approvedTransport(baseUrl),
      idempotencyScope: "timeout-negative",
    }).dispatchDue();
    expect(fixture.store.listCallbackDeliveries("in_flight")).toEqual([]);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      error: { code: "framework.CALLBACK_TIMEOUT", retryable: true },
    });
    fixture.store.close();
  });

  it("does not claim work for a pre-aborted dispatch", async () => {
    const fixture = world();
    fixture.invoke();
    const evidenceBefore = fixture.store.readEvidence();
    let requests = 0;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.end();
    });
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      transport: approvedTransport(baseUrl),
      idempotencyScope: "pre-aborted",
    });
    const controller = new AbortController();
    controller.abort(new Error("stop before delivery"));
    await expect(dispatcher.dispatchDue(controller.signal)).rejects.toThrow("stop before delivery");
    expect(requests).toBe(0);
    expect(fixture.store.readEvidence()).toEqual(evidenceBefore);
    expect(fixture.store.nextCallbackDelivery(0)).toMatchObject({ attemptCount: 0, status: "pending" });
    fixture.store.close();
  });

  it("drains actual HTTP abort before rejecting and leaves later work unclaimed for a safe reset", async () => {
    const fixture = world([1_000]);
    const snapshot = join(fixture.directory, "before-abort.sqlite");
    fixture.store.createSnapshot(snapshot, "corr_abort_snapshot");
    fixture.invoke();
    fixture.invoke();
    let observe: () => void = () => undefined;
    const observed = new Promise<void>((resolve) => {
      observe = resolve;
    });
    let requests = 0;
    let requestSignal: AbortSignal | undefined;
    let activeBody: ReadableStream<Uint8Array> | null | undefined;
    const baseUrl = await receiver((_request, response) => {
      requests += 1;
      response.writeHead(200);
      response.write("incomplete");
    });
    const dispatcher = new CallbackDispatcher({
      store: fixture.store,
      tools: [fixture.installed],
      receivers: { application: { baseUrl, secret: "callback-secret" } },
      idempotencyScope: "abort-drain",
      transport: {
        ...approvedTransport(baseUrl),
        fetch: async (input, init) => {
          requestSignal = init?.signal ?? undefined;
          const response = await globalThis.fetch(input, init);
          activeBody = response.body;
          observe();
          return response;
        },
      },
    });
    const controller = new AbortController();
    const dispatch = dispatcher.dispatchDue(controller.signal);
    const joined = dispatcher.dispatchDue();
    const rejected = expect(dispatch).rejects.toThrow("stop and drain");
    const joinedRejected = expect(joined).rejects.toThrow("stop and drain");
    await observed;
    expect(fixture.store.listCallbackDeliveries("in_flight")).toHaveLength(1);
    expect(() => dispatcher.recoverInFlight()).toThrow(/active dispatch/);
    expect(() => fixture.store.resetFromSnapshot(snapshot, "corr_reset_busy")).toThrow(/in flight/);
    controller.abort(new Error("stop and drain"));
    await Promise.all([rejected, joinedRejected]);
    expect(requestSignal?.aborted).toBe(true);
    expect(activeBody?.locked).toBe(false);
    expect(requests).toBe(1);
    expect(fixture.store.listCallbackDeliveries("in_flight")).toEqual([]);
    expect(
      fixture.store
        .listCallbackDeliveries("pending")
        .map((entry) => entry.attemptCount)
        .sort(),
    ).toEqual([0, 1]);
    expect(fixture.store.readEvidence().at(-1)).toMatchObject({
      phase: "retry_scheduled",
      error: { code: "framework.CALLBACK_ABORTED", retryable: true },
    });
    fixture.store.resetFromSnapshot(snapshot, "corr_reset_drained");
    expect(await dispatcher.dispatchDue()).toEqual({ outcomes: [] });
    fixture.store.close();
  });
});
