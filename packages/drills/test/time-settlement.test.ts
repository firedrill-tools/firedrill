import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallbackDispatcher } from "@firedrill-tools/protocol-http";
import { defineTool } from "@firedrill-tools/tool-sdk";
import { WorldKernel } from "@firedrill-tools/world-kernel";
import { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrillCallbackSettlement, VirtualTimeSettlementOptions } from "../src/index.js";
import { settleVirtualTime } from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}` as const;
const directories: string[] = [];
const stores: SqliteWorldStore[] = [];
const servers: Server[] = [];

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
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-settlement-test-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function world(times = [10, 12, 20], failCycle = false) {
  const gauge = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "tide-gauge",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["event.emit"],
      operations: [
        {
          id: "readings.publish",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "behavioral",
        },
      ],
      events: [{ id: "reading.available", payloadSchema: { type: "object" } }],
      callbacks: [
        {
          id: "publish-reading",
          eventId: "reading.available",
          receiverId: "observatory",
          method: "POST",
          path: "/measurements",
          idempotencyHeader: "Idempotency-Key",
          retry: { delaysUs: [5] },
          timeoutMs: 1_000,
        },
      ],
    },
    operations: {
      "readings.publish": (input, context) => {
        context.events.emit("reading.available", input);
        return input;
      },
    },
    callbacks: {
      "publish-reading": {
        encode: ({ attempt, payload }) => ({ body: { kind: "json", value: { attempt, ...payload } } }),
      },
    },
  });
  const ventilation = defineTool({
    manifest: {
      schemaVersion: 1,
      id: "ventilation",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.write"],
      state: [{ namespace: "cycles", schema: { type: "object" } }],
      operations: [
        {
          id: "cycles.inspect",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "behavioral",
        },
      ],
      events: [{ id: "cycle.completed", payloadSchema: { type: "object" } }],
      subscriptions: [
        { id: "record-cycle", event: { packageId: "ventilation", eventId: "cycle.completed" } },
      ],
    },
    operations: {
      "cycles.inspect": (input, context) => {
        context.state.put("cycles", String(input.cycle), { inspected: true });
        return { inspected: true };
      },
    },
    subscriptions: {
      "record-cycle": (payload, context) => {
        context.state.put("cycles", String(payload.cycle), { inspected: false });
        if (failCycle) throw new Error("cycle inspection failed");
      },
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "firedrill-settlement-test-"));
  directories.push(directory);
  const store = SqliteWorldStore.create({
    filePath: join(directory, "world.sqlite"),
    worldInstanceId: "world_settlement01",
    buildHash: HASH,
    packageLockHash: HASH,
    seed: "12",
    virtualTimeUs: 0,
    correlationId: "corr_settlement_create",
    actors: [{ bindingId: "actor_operator", actorId: "operator", grants: [] }],
    scheduledEvents: times.map((dueUs, index) => ({
      event:
        index === 0
          ? { packageId: "tide-gauge", eventId: "reading.available" }
          : { packageId: "ventilation", eventId: "cycle.completed" },
      payload: index === 0 ? { metres: 1.8 } : { cycle: index },
      dueUs,
      actorBindingId: "actor_operator",
    })),
  });
  stores.push(store);
  const tools = [gauge, ventilation];
  const kernel = new WorldKernel({ store, tools, packageLockHash: HASH });
  return { store, kernel, tools };
}

async function callbacks(fixture: ReturnType<typeof world>, retry = true) {
  const received: Array<{ timeUs: number; key: string | undefined }> = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received.push({
        timeUs: fixture.store.metadata().virtualTimeUs,
        key: request.headers["idempotency-key"] as string | undefined,
      });
      response.writeHead(retry && received.length === 1 ? 503 : 204);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("receiver failed to bind");
  const dispatcher = new CallbackDispatcher({
    ...fixture,
    receivers: { observatory: { baseUrl: `http://127.0.0.1:${String(address.port)}` } },
  });
  const settlement: DrillCallbackSettlement = {
    flush: async () => {
      await dispatcher.dispatchDue();
    },
    nextDueUs: () => dispatcher.nextDueUs(),
  };
  return { settlement, received };
}

function options(
  fixture: ReturnType<typeof world>,
  settlement: DrillCallbackSettlement = { flush: async () => undefined, nextDueUs: () => null },
): VirtualTimeSettlementOptions {
  return {
    store: fixture.store,
    kernel: fixture.kernel,
    callbacks: settlement,
    targetUs: 30,
    maxEvents: 3,
    correlationId: ({ step }) => `corr_settlement_${String(step)}`,
  };
}

describe("callback-aware virtual-time settlement", () => {
  it("yields long event batches so external cancellation can retain a committed prefix", async () => {
    const fixture = world(Array.from({ length: 100 }, () => 0));
    const controller = new AbortController();
    const cancellation = setImmediate(() => controller.abort("external stop"));
    try {
      const result = await settleVirtualTime({
        ...options(fixture, { flush: async () => undefined, nextDueUs: () => null }),
        targetUs: 0,
        maxEvents: 100,
        signal: controller.signal,
      });
      expect(result).toMatchObject({ status: "aborted", reason: "external stop", reachedUs: 0 });
      expect(result.scheduledEventsProcessed).toBeGreaterThan(0);
      expect(result.scheduledEventsProcessed).toBeLessThan(100);
      expect(fixture.store.listScheduledEvents("pending")).toHaveLength(
        100 - result.scheduledEventsProcessed,
      );
    } finally {
      clearImmediate(cancellation);
    }
  });

  it("keeps one budget and deterministic evidence across event-loop yields", async () => {
    const run = async (maximum: number) => {
      const fixture = world(Array.from({ length: 100 }, () => 20));
      const result = await settleVirtualTime({
        ...options(fixture, { flush: async () => undefined, nextDueUs: () => null }),
        maxEvents: maximum,
      });
      return {
        result,
        pending: fixture.store.listScheduledEvents("pending").length,
        hash: fixture.store.evidenceHash(),
      };
    };
    expect(await run(100)).toEqual(await run(100));
    expect((await run(100)).result).toMatchObject({
      status: "completed",
      reachedUs: 30,
      scheduledEventsProcessed: 100,
    });
    expect(await run(65)).toMatchObject({
      result: { status: "failed", reachedUs: 20, scheduledEventsProcessed: 65, eventBudgetExhausted: true },
      pending: 35,
    });
  });
  it("rejects malformed limits before flushing and honors a zero remaining budget at the current time", async () => {
    const fixture = world([0]);
    const flush = vi.fn(async () => undefined);
    const inputs = options(fixture, { flush, nextDueUs: () => null });
    const initialHash = fixture.store.evidenceHash();
    await expect(settleVirtualTime({ ...inputs, maxEvents: -1 })).rejects.toThrow("maxEvents");
    await expect(settleVirtualTime({ ...inputs, targetUs: Number.NaN })).rejects.toThrow();
    expect(flush).not.toHaveBeenCalled();
    expect(fixture.store.evidenceHash()).toBe(initialHash);
    expect(await settleVirtualTime({ ...inputs, maxEvents: 0, targetUs: 0 })).toMatchObject({
      status: "failed",
      reachedUs: 0,
      scheduledEventsProcessed: 0,
      eventBudgetExhausted: true,
      failure: { error: { code: "world.EVENT_BUDGET_EXCEEDED" } },
    });
    expect(fixture.store.nextScheduledEvent(0)).not.toBeNull();
    expect(fixture.store.evidenceHash()).toBe(initialHash);
  });

  it("rejects an asynchronous observer instead of silently ignoring its stop decision", async () => {
    const fixture = world();
    expect(
      await settleVirtualTime({ ...options(fixture), afterScheduledEvent: async () => false }),
    ).toMatchObject({ status: "failed", reason: "observer", reachedUs: 10, scheduledEventsProcessed: 1 });
    expect(fixture.store.nextScheduledEvent(30)?.dueUs).toBe(12);
  });

  it("interleaves unrelated world events with actual callback delivery and virtual retries", async () => {
    const fixture = world();
    const receiver = await callbacks(fixture);
    const checkpoints: Array<{ processed: number; timeUs: number }> = [];
    const result = await settleVirtualTime({
      ...options(fixture, receiver.settlement),
      afterScheduledEvent: (checkpoint) => {
        checkpoints.push({ processed: checkpoint.processed, timeUs: checkpoint.virtualTimeUs });
      },
    });
    expect(result).toEqual({
      status: "completed",
      requestedUs: 30,
      reachedUs: 30,
      scheduledEventsProcessed: 3,
      eventBudgetExhausted: false,
    });
    expect(checkpoints).toEqual([
      { processed: 1, timeUs: 10 },
      { processed: 2, timeUs: 12 },
      { processed: 3, timeUs: 20 },
    ]);
    expect(receiver.received.map((entry) => entry.timeUs)).toEqual([10, 15]);
    expect(receiver.received[0]?.key).toBe(receiver.received[1]?.key);
    expect(fixture.store.readState("ventilation", "cycles", "2")).toMatchObject({
      value: { inspected: false },
    });
    expect(fixture.store.listCallbackDeliveries("delivered")).toHaveLength(1);
  });

  it("does not replenish the remaining event budget across callback retry deadlines", async () => {
    const fixture = world();
    const receiver = await callbacks(fixture);
    const result = await settleVirtualTime({ ...options(fixture, receiver.settlement), maxEvents: 2 });
    expect(result).toMatchObject({
      status: "failed",
      reason: "scheduled_event",
      reachedUs: 15,
      scheduledEventsProcessed: 2,
      eventBudgetExhausted: true,
      failure: { error: { code: "world.EVENT_BUDGET_EXCEEDED" } },
    });
    expect(receiver.received.map((entry) => entry.timeUs)).toEqual([10, 15]);
    expect(fixture.store.nextScheduledEvent(30)?.dueUs).toBe(20);
    expect(fixture.store.readState("ventilation", "cycles", "2")).toBeNull();
  });

  it("settles every event and callback already due when the requested time equals the clock", async () => {
    const fixture = world([0, 0, 0]);
    const receiver = await callbacks(fixture, false);
    const result = await settleVirtualTime({ ...options(fixture, receiver.settlement), targetUs: 0 });
    expect(result).toMatchObject({ status: "completed", reachedUs: 0, scheduledEventsProcessed: 3 });
    expect(receiver.received.map((entry) => entry.timeUs)).toEqual([0]);
    expect(fixture.store.nextScheduledEvent(0)).toBeNull();
  });

  it("honors an event observer stop before further events or the final clock advance", async () => {
    const fixture = world();
    const receiver = await callbacks(fixture);
    const result = await settleVirtualTime({
      ...options(fixture, receiver.settlement),
      afterScheduledEvent: ({ processed }) => processed < 2,
    });
    expect(result).toMatchObject({ status: "stopped", reachedUs: 12, scheduledEventsProcessed: 2 });
    expect(receiver.received.map((entry) => entry.timeUs)).toEqual([10]);
    expect(fixture.store.nextScheduledEvent(30)?.dueUs).toBe(20);
  });

  it("retains committed progress and the original kernel envelope on a scheduled-event failure", async () => {
    const fixture = world(undefined, true);
    const receiver = await callbacks(fixture);
    const result = await settleVirtualTime(options(fixture, receiver.settlement));
    expect(result).toMatchObject({
      status: "failed",
      reason: "scheduled_event",
      reachedUs: 12,
      scheduledEventsProcessed: 2,
      eventBudgetExhausted: false,
      failure: { error: { source: "world", code: "world.SUBSCRIPTION_FAILED" } },
    });
    expect(fixture.store.readState("ventilation", "cycles", "1")).toBeNull();
  });

  it("returns committed counts when an event observer or a later callback flush throws", async () => {
    const fixture = world();
    const error = new Error("checkpoint observer failed");
    const first = await settleVirtualTime({
      ...options(fixture),
      afterScheduledEvent: () => {
        throw error;
      },
    });
    expect(first).toMatchObject({
      status: "failed",
      reason: "observer",
      error,
      reachedUs: 10,
      scheduledEventsProcessed: 1,
    });
    const laterFixture = world();
    const next = await settleVirtualTime({
      ...options(laterFixture, {
        flush: async () => {
          if (laterFixture.store.metadata().virtualTimeUs >= 10) throw error;
        },
        nextDueUs: () => laterFixture.store.nextCallbackDelivery()?.dueUs ?? null,
      }),
      maxEvents: 2,
    });
    expect(next).toMatchObject({
      status: "failed",
      reason: "callback",
      error,
      reachedUs: 10,
      scheduledEventsProcessed: 1,
    });
  });

  it("aborts before mutation, and after an awaited flush without advancing further", async () => {
    const fixture = world();
    const controller = new AbortController();
    controller.abort("stop before work");
    const flush = vi.fn(async () => undefined);
    const initialHash = fixture.store.evidenceHash();
    const first = await settleVirtualTime({
      ...options(fixture, { flush, nextDueUs: () => null }),
      signal: controller.signal,
    });
    expect(first).toMatchObject({
      status: "aborted",
      reason: "stop before work",
      reachedUs: 0,
      scheduledEventsProcessed: 0,
    });
    expect(flush).not.toHaveBeenCalled();
    expect(fixture.store.evidenceHash()).toBe(initialHash);

    const later = new AbortController();
    const second = await settleVirtualTime({
      ...options(fixture, {
        flush: async (signal) => {
          expect(signal).toBe(later.signal);
          await Promise.resolve();
          later.abort("stop after flush");
        },
        nextDueUs: () => null,
      }),
      signal: later.signal,
    });
    expect(second).toMatchObject({
      status: "aborted",
      reason: "stop after flush",
      reachedUs: 0,
      scheduledEventsProcessed: 0,
    });
    expect(fixture.store.evidenceHash()).toBe(initialHash);
  });

  it("retains the last committed event when cancellation arrives at its checkpoint", async () => {
    const fixture = world();
    const controller = new AbortController();
    const result = await settleVirtualTime({
      ...options(fixture),
      signal: controller.signal,
      afterScheduledEvent: () => {
        controller.abort("stop at checkpoint");
      },
    });
    expect(result).toMatchObject({ status: "aborted", reachedUs: 10, scheduledEventsProcessed: 1 });
    expect(fixture.store.nextScheduledEvent(30)?.dueUs).toBe(12);
  });

  it("fails without spinning when flush leaves due callbacks or a kernel makes no progress", async () => {
    const fixture = world([]);
    const flush = vi.fn(async () => undefined);
    const undrained = await settleVirtualTime(options(fixture, { flush, nextDueUs: () => 0 }));
    expect(undrained).toMatchObject({ status: "failed", reason: "no_progress", reachedUs: 0 });
    expect(flush).toHaveBeenCalledTimes(1);
    const advance = vi.spyOn(fixture.kernel, "advanceTime").mockReturnValue({
      requestedUs: 30,
      reachedUs: 0,
      scheduledEventsProcessed: 0,
      failures: [],
      evidence: [],
      stoppedEarly: true,
    });
    const stalled = await settleVirtualTime(options(fixture));
    expect(stalled).toMatchObject({ status: "failed", reason: "no_progress", reachedUs: 0 });
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
