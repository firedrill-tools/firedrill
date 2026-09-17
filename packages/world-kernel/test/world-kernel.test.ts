import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonObject,
  OperationInvocation,
  OperationRef,
  ResolvedToolOverride,
} from "@firedrill-tools/contracts";
import type { ToolDefinition, ToolOperationHandler } from "@firedrill-tools/tool-sdk";
import { defineTool } from "@firedrill-tools/tool-sdk";
import { SqliteWorldStore } from "@firedrill-tools/world-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BoundWorldClient, WorldKernel } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-kernel-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function inventoryTool(): ToolDefinition {
  return defineTool({
    manifest: {
      schemaVersion: 1,
      id: "inventory",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: [
        "state.read",
        "state.write",
        "clock.read",
        "clock.schedule",
        "random.draw",
        "event.emit",
      ],
      state: [
        {
          namespace: "items",
          schema: {
            type: "object",
            required: ["sku", "available"],
            properties: {
              sku: { type: "string" },
              available: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "stock.reserve",
          inputSchema: {
            type: "object",
            required: ["sku", "quantity"],
            properties: {
              sku: { type: "string", minLength: 1 },
              quantity: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["reservationId", "remaining"],
            properties: {
              reservationId: { type: "string" },
              remaining: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
          declaredErrors: ["OUT_OF_STOCK", "TIMEOUT", "UNAVAILABLE"],
          idempotency: "required",
          fidelity: "behavioral",
        },
        {
          id: "stock.get",
          inputSchema: {
            type: "object",
            required: ["sku"],
            properties: { sku: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["sku", "available"],
            properties: { sku: { type: "string" }, available: { type: "integer", minimum: 0 } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
        {
          id: "stock.crash",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "contract",
        },
      ],
      events: [
        {
          id: "reservation.created",
          payloadSchema: {
            type: "object",
            required: ["sku", "reservationId"],
            properties: { sku: { type: "string" }, reservationId: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          id: "reservation.expired",
          payloadSchema: {
            type: "object",
            required: ["sku"],
            properties: { sku: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      faults: [
        {
          id: "a-unavailable",
          appliesTo: ["stock.reserve"],
          timing: "before",
          error: { code: "UNAVAILABLE", message: "inventory is unavailable", retryable: true },
        },
        {
          id: "z-response-timeout",
          appliesTo: ["stock.reserve"],
          timing: "after_commit",
          error: { code: "TIMEOUT", message: "the response timed out", retryable: true },
        },
      ],
    },
    operations: {
      "stock.reserve": (input, context) => {
        const sku = String(input.sku);
        const quantity = Number(input.quantity);
        const item = context.state.get("items", sku);
        const available = Number(item?.available ?? 0);
        if (available < quantity) {
          context.fail({
            code: "OUT_OF_STOCK",
            message: `${sku} has insufficient stock`,
            details: { available, requested: quantity },
          });
        }
        const reservationId = `reservation_${context.random.nextInteger(1_000, 10_000)}`;
        context.state.put("items", sku, { sku, available: available - quantity });
        context.events.emit("reservation.created", { sku, reservationId });
        context.events.scheduleAt("reservation.expired", { sku }, context.clock.nowUs() + 100);
        return { reservationId, remaining: available - quantity };
      },
      "stock.get": (input, context) => {
        const sku = String(input.sku);
        return context.state.get("items", sku) ?? { sku, available: 0 };
      },
      "stock.crash": (_input, context) => {
        context.state.put("items", "sku-1", { sku: "sku-1", available: 0 });
        throw new Error("fixture crash after write");
      },
    },
  });
}

function activityTool(): ToolDefinition {
  return defineTool({
    manifest: {
      schemaVersion: 1,
      id: "activity-log",
      version: "1.0.0",
      engine: ">=0.1.0",
      capabilities: ["state.read", "state.write"],
      state: [{ namespace: "entries", schema: { type: "object" } }],
      operations: [
        {
          id: "entries.list",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: {
            type: "object",
            required: ["entries"],
            properties: { entries: { type: "array", items: { type: "object" } } },
            additionalProperties: false,
          },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
      subscriptions: [
        {
          id: "record-created-reservation",
          event: { packageId: "inventory", eventId: "reservation.created" },
        },
        {
          id: "record-expired-reservation",
          event: { packageId: "inventory", eventId: "reservation.expired" },
        },
      ],
    },
    operations: {
      "entries.list": (_input, context) => ({
        entries: context.state.scan("entries").map((record) => record.value),
      }),
    },
    subscriptions: {
      "record-created-reservation": (payload, context) => {
        context.state.put("entries", `created-${String(payload.reservationId)}`, {
          kind: "created",
          sku: payload.sku ?? null,
        });
      },
      "record-expired-reservation": (payload, context) => {
        context.state.put("entries", `expired-${String(payload.sku)}`, {
          kind: "expired",
          sku: payload.sku ?? null,
        });
      },
    },
  });
}

function createKernel(options: {
  readonly tools?: readonly ToolDefinition[];
  readonly toolOverrides?: readonly ResolvedToolOverride[];
  readonly grants?: readonly OperationRef[];
  readonly activeFaults?: readonly { packageId: string; faultId: string }[];
  readonly state?: readonly { packageId: string; namespace: string; rowId: string; value: JsonObject }[];
  readonly fileName?: string;
  readonly maxToolCalls?: number;
  readonly onToolCallBudgetExceeded?: () => void;
}) {
  const directory = temporaryDirectory();
  const filePath = join(directory, options.fileName ?? "world.sqlite");
  const store = SqliteWorldStore.create({
    filePath,
    worldInstanceId: "world_kernel01",
    buildHash: HASH_A,
    packageLockHash: HASH_B,
    seed: "42",
    virtualTimeUs: 1_000,
    correlationId: "corr_create01",
    actors: [
      {
        bindingId: "actor_primary",
        actorId: "operator",
        grants: options.grants ?? [
          { packageId: "inventory", operationId: "stock.reserve" },
          { packageId: "inventory", operationId: "stock.get" },
          { packageId: "inventory", operationId: "stock.crash" },
          { packageId: "activity-log", operationId: "entries.list" },
        ],
      },
    ],
    state: options.state ?? [
      { packageId: "inventory", namespace: "items", rowId: "sku-1", value: { sku: "sku-1", available: 5 } },
    ],
    ...(options.activeFaults === undefined ? {} : { activeFaults: options.activeFaults }),
  });
  return {
    directory,
    filePath,
    store,
    kernel: new WorldKernel({
      store,
      packageLockHash: HASH_B,
      tools: options.tools ?? [inventoryTool(), activityTool()],
      ...(options.toolOverrides === undefined ? {} : { toolOverrides: options.toolOverrides }),
      ...(options.maxToolCalls === undefined ? {} : { budgets: { maxToolCalls: options.maxToolCalls } }),
      ...(options.onToolCallBudgetExceeded === undefined
        ? {}
        : { onToolCallBudgetExceeded: options.onToolCallBudgetExceeded }),
    }),
  };
}

function invocation(overrides: Partial<OperationInvocation> = {}): OperationInvocation {
  return {
    schemaVersion: 1,
    callId: "call_reserve1",
    correlationId: "corr_reserve1",
    operation: { packageId: "inventory", operationId: "stock.reserve" },
    actorBindingId: "actor_primary",
    arguments: { sku: "sku-1", quantity: 2 },
    idempotencyKey: "reserve-request-1",
    ...overrides,
  };
}

describe("package-driven world execution", () => {
  it("records and reports calls rejected by the world-wide Tool-call budget", () => {
    let exceeded = 0;
    const { kernel, store } = createKernel({
      maxToolCalls: 1,
      onToolCallBudgetExceeded: () => {
        exceeded += 1;
      },
    });
    try {
      const first = kernel.invoke(
        invocation({
          operation: { packageId: "inventory", operationId: "stock.get" },
          arguments: { sku: "sku-1" },
          idempotencyKey: undefined,
        }),
      );
      const rejected = kernel.invoke(
        invocation({
          callId: "call_budget02",
          correlationId: "corr_budget02",
          operation: { packageId: "inventory", operationId: "stock.get" },
          arguments: { sku: "sku-1" },
          idempotencyKey: undefined,
        }),
      );
      expect(first.outcome.status).toBe("ok");
      expect(rejected.outcome).toMatchObject({
        status: "tool_error",
        error: {
          code: "world.TOOL_CALL_BUDGET_EXCEEDED",
          details: { attempted: 2, limit: 1 },
        },
      });
      expect(kernel.usage()).toEqual({
        toolCalls: 2,
        maxToolCalls: 1,
        toolCallBudgetExceeded: true,
      });
      expect(exceeded).toBe(1);
      expect(store.readEvidence().filter((entry) => entry.kind === "operation")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("keeps the world-wide Tool-call budget across kernel restarts", () => {
    let exceeded = 0;
    const { kernel, store } = createKernel({ maxToolCalls: 1 });
    try {
      const first = kernel.invoke(
        invocation({
          operation: { packageId: "inventory", operationId: "stock.get" },
          arguments: { sku: "sku-1" },
          idempotencyKey: undefined,
        }),
      );
      expect(first.outcome.status).toBe("ok");

      const restarted = new WorldKernel({
        store,
        packageLockHash: HASH_B,
        tools: [inventoryTool(), activityTool()],
        budgets: { maxToolCalls: 1 },
        onToolCallBudgetExceeded: () => {
          exceeded += 1;
        },
      });
      expect(restarted.usage()).toEqual({
        toolCalls: 1,
        maxToolCalls: 1,
        toolCallBudgetExceeded: false,
      });

      const rejected = restarted.invoke(
        invocation({
          callId: "call_after_restart",
          correlationId: "corr_after_restart",
          operation: { packageId: "inventory", operationId: "stock.get" },
          arguments: { sku: "sku-1" },
          idempotencyKey: undefined,
        }),
      );
      expect(rejected.outcome).toMatchObject({
        status: "tool_error",
        error: {
          code: "world.TOOL_CALL_BUDGET_EXCEEDED",
          details: { attempted: 2, limit: 1 },
        },
      });
      expect(exceeded).toBe(1);
    } finally {
      store.close();
    }
  });

  it("refuses a Tool set whose resolved lock does not match the world", () => {
    const { store } = createKernel({});
    expect(
      () =>
        new WorldKernel({
          store,
          packageLockHash: HASH_A,
          tools: [inventoryTool(), activityTool()],
        }),
    ).toThrow(/does not match world package lock/);
    store.close();
  });

  it("enforces declared JSON Schema formats rather than silently dropping them", () => {
    const directory = defineTool({
      manifest: {
        schemaVersion: 1,
        id: "directory",
        version: "1.0.0",
        engine: ">=0.1.0",
        capabilities: [],
        operations: [
          {
            id: "contacts.lookup",
            inputSchema: {
              type: "object",
              required: ["email"],
              properties: { email: { type: "string", format: "email" } },
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              required: ["found"],
              properties: { found: { type: "boolean" } },
              additionalProperties: false,
            },
            idempotency: "none",
            fidelity: "contract",
          },
        ],
      },
      operations: { "contacts.lookup": () => ({ found: false }) },
    });
    const { kernel, store } = createKernel({
      tools: [directory],
      grants: [{ packageId: "directory", operationId: "contacts.lookup" }],
      state: [],
    });
    const result = kernel.invoke(
      invocation({
        callId: "call_format01",
        correlationId: "corr_format01",
        operation: { packageId: "directory", operationId: "contacts.lookup" },
        arguments: { email: "not-an-email" },
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "invalid",
      error: { code: "framework.INVALID_OPERATION_INPUT" },
    });
    expect(result.evidence).toHaveLength(1);
    store.close();
  });

  it("rejects state that violates its package-owned namespace schema and rolls the write back", () => {
    const typedStore = defineTool({
      manifest: {
        schemaVersion: 1,
        id: "typed-store",
        version: "1.0.0",
        engine: ">=0.1.0",
        capabilities: ["state.write"],
        state: [
          {
            namespace: "records",
            schema: {
              type: "object",
              required: ["status"],
              properties: { status: { type: "string", enum: ["ready", "blocked"] } },
              additionalProperties: false,
            },
          },
        ],
        operations: [
          {
            id: "records.break",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "stateful",
          },
        ],
      },
      operations: {
        "records.break": (_input, context) => {
          context.state.put("records", "record-1", { status: "invented" });
          return {};
        },
      },
    });
    const { kernel, store } = createKernel({
      tools: [typedStore],
      grants: [{ packageId: "typed-store", operationId: "records.break" }],
      state: [],
    });
    const result = kernel.invoke(
      invocation({
        callId: "call_state001",
        correlationId: "corr_state001",
        operation: { packageId: "typed-store", operationId: "records.break" },
        arguments: {},
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "tool_error",
      error: { code: "world.INVALID_STATE_VALUE" },
    });
    expect(store.readState("typed-store", "records", "record-1")).toBeNull();
    expect(result.evidence).toHaveLength(1);
    store.close();
  });

  it("denies behavior that uses a capability absent from its locked manifest", () => {
    const underDeclared = defineTool({
      manifest: {
        schemaVersion: 1,
        id: "sealed-records",
        version: "1.0.0",
        engine: ">=0.1.0",
        capabilities: [],
        state: [{ namespace: "records", schema: { type: "object" } }],
        operations: [
          {
            id: "records.read",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object" },
            idempotency: "none",
            fidelity: "stateful",
          },
        ],
      },
      operations: {
        "records.read": (_input, context) => context.state.get("records", "one") ?? {},
      },
    });
    const { kernel, store } = createKernel({
      tools: [underDeclared],
      grants: [{ packageId: "sealed-records", operationId: "records.read" }],
      state: [],
    });
    const result = kernel.invoke(
      invocation({
        callId: "call_capability1",
        correlationId: "corr_capability1",
        operation: { packageId: "sealed-records", operationId: "records.read" },
        arguments: {},
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "tool_error",
      error: { code: "world.CAPABILITY_NOT_DECLARED" },
    });
    expect(result.evidence).toHaveLength(1);
    store.close();
  });

  it("executes stateful behavior, realistic responses, and immediate cross-Tool consequences", () => {
    const { kernel, store } = createKernel({});
    const result = kernel.invoke(invocation());
    expect(result.outcome).toMatchObject({ status: "ok", value: { remaining: 3 } });
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    expect(store.scanState("activity-log", "entries")).toHaveLength(1);
    expect(store.nextScheduledEvent()).toMatchObject({
      event: { packageId: "inventory", eventId: "reservation.expired" },
      actorBindingId: "actor_primary",
      dueUs: 1_100,
    });
    expect(result.evidence.map((entry) => entry.kind)).toEqual([
      "operation",
      "random",
      "state_change",
      "event",
      "event",
      "state_change",
      "event",
    ]);
    store.close();
  });

  it("replays an idempotent response without duplicating its effects", () => {
    const { kernel, store } = createKernel({});
    const first = kernel.invoke(invocation());
    const replay = kernel.invoke(invocation({ callId: "call_reserve2", correlationId: "corr_reserve2" }));
    expect(replay.outcome).toEqual(first.outcome);
    expect(replay.evidence).toHaveLength(1);
    expect(replay.evidence[0]).toMatchObject({ kind: "operation", idempotency: "replayed" });
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    expect(store.scanState("activity-log", "entries")).toHaveLength(1);

    const conflict = kernel.invoke(
      invocation({
        callId: "call_reserve3",
        correlationId: "corr_reserve3",
        arguments: { sku: "sku-1", quantity: 1 },
      }),
    );
    expect(conflict.outcome).toMatchObject({
      status: "invalid",
      error: { code: "world.IDEMPOTENCY_CONFLICT" },
    });
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    store.close();
  });

  it("settles a delayed event under virtual time with the original actor binding", () => {
    const { kernel, store } = createKernel({});
    kernel.invoke(invocation());
    const before = kernel.advanceTime(1_099, { correlationId: "corr_clock01" });
    expect(before).toMatchObject({ reachedUs: 1_099, scheduledEventsProcessed: 0, failures: [] });
    expect(store.scanState("activity-log", "entries")).toHaveLength(1);

    const atDeadline = kernel.advanceTime(1_100, { correlationId: "corr_clock02" });
    expect(atDeadline).toMatchObject({ reachedUs: 1_100, scheduledEventsProcessed: 1, failures: [] });
    expect(store.scanState("activity-log", "entries")).toHaveLength(2);
    expect(store.listScheduledEvents()[0]?.status).toBe("fired");
    expect(atDeadline.evidence.map((entry) => entry.kind)).toEqual([
      "clock",
      "event",
      "state_change",
      "event",
    ]);
    store.close();
  });

  it("can checkpoint and stop after one scheduled event without losing pending work", () => {
    const { kernel, store } = createKernel({});
    kernel.invoke(invocation({ arguments: { sku: "sku-1", quantity: 1 } }));
    kernel.invoke(
      invocation({
        callId: "call_reserve2",
        correlationId: "corr_reserve2",
        arguments: { sku: "sku-1", quantity: 1 },
        idempotencyKey: "reserve-request-2",
      }),
    );

    const checkpoints: number[] = [];
    const stopped = kernel.advanceTime(1_100, {
      correlationId: "corr_clock01",
      afterScheduledEvent: ({ processed }) => {
        checkpoints.push(processed);
        return false;
      },
    });
    expect(stopped).toMatchObject({
      reachedUs: 1_100,
      scheduledEventsProcessed: 1,
      failures: [],
      stoppedEarly: true,
    });
    expect(checkpoints).toEqual([1]);
    expect(store.listScheduledEvents("pending")).toHaveLength(1);

    const exhausted = kernel.advanceTime(1_100, { correlationId: "corr_clock02", maxEvents: 0 });
    expect(exhausted).toMatchObject({
      scheduledEventsProcessed: 0,
      failures: [{ error: { code: "world.EVENT_BUDGET_EXCEEDED" } }],
    });
    expect(store.listScheduledEvents("pending")).toHaveLength(1);

    const completed = kernel.advanceTime(1_100, { correlationId: "corr_clock03", maxEvents: 1 });
    expect(completed).toMatchObject({ scheduledEventsProcessed: 1, failures: [], stoppedEarly: false });
    expect(store.listScheduledEvents("pending")).toHaveLength(0);
    store.close();
  });

  it("keeps a committed effect exactly once when an injected response timeout invites a retry", () => {
    const { kernel, store } = createKernel({
      activeFaults: [{ packageId: "inventory", faultId: "z-response-timeout" }],
    });
    const first = kernel.invoke(invocation());
    expect(first.outcome).toMatchObject({ status: "tool_error", error: { code: "tool.TIMEOUT" } });
    expect(first.evidence.some((entry) => entry.kind === "fault")).toBe(true);
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    const retry = kernel.invoke(invocation({ callId: "call_retry01", correlationId: "corr_retry01" }));
    expect(retry.outcome).toEqual(first.outcome);
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    store.close();
  });

  it("resolves multiple active faults deterministically before behavior", () => {
    const { kernel, store } = createKernel({
      activeFaults: [
        { packageId: "inventory", faultId: "z-response-timeout" },
        { packageId: "inventory", faultId: "a-unavailable" },
      ],
    });
    const result = kernel.invoke(invocation());
    expect(result.outcome).toMatchObject({ status: "tool_error", error: { code: "tool.UNAVAILABLE" } });
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(5);
    expect(store.scanState("activity-log", "entries")).toHaveLength(0);
    store.close();
  });
});

describe("failure and boundary evidence", () => {
  it("rejects undeclared faults and rolls back control state with its evidence", () => {
    const { kernel, store } = createKernel({});
    const before = store.evidenceHash();
    try {
      expect(() =>
        kernel.setFault({ packageId: "absent", faultId: "a-unavailable", active: true }, "corr_unknownfault"),
      ).toThrow("unknown Tool");
      expect(() =>
        kernel.setFault({ packageId: "inventory", faultId: "absent", active: true }, "corr_unknownfault"),
      ).toThrow("does not declare");
      expect(store.evidenceHash()).toBe(before);
      expect(() =>
        store.transact("corr_rollbackfault", (transaction) => {
          transaction.setFaultActive("inventory", "a-unavailable", true);
          throw new Error("abort fault control");
        }),
      ).toThrow("abort fault control");
      expect(store.listActiveFaults()).toEqual([]);
      expect(store.evidenceHash()).toBe(before);
      const client = new BoundWorldClient({
        kernel,
        actorBindingId: "actor_primary",
        namespace: "fault-control-boundary",
      });
      expect("setFault" in client).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not erase a committed idempotency receipt when disabling an after-commit fault", () => {
    const { kernel, store } = createKernel({});
    try {
      kernel.setFault(
        { packageId: "inventory", faultId: "z-response-timeout", active: true },
        "corr_enabletimeout",
      );
      const first = kernel.invoke(invocation());
      kernel.setFault(
        { packageId: "inventory", faultId: "z-response-timeout", active: false },
        "corr_disabletimeout",
      );
      const retry = kernel.invoke(
        invocation({ callId: "call_afterdisable", correlationId: "corr_afterdisable" }),
      );
      expect(first.outcome).toMatchObject({ status: "tool_error", error: { code: "tool.TIMEOUT" } });
      expect(retry.outcome).toEqual(first.outcome);
      expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    } finally {
      store.close();
    }
  });

  it("records structured provider errors without changing state", () => {
    const { kernel, store } = createKernel({
      state: [
        { packageId: "inventory", namespace: "items", rowId: "sku-1", value: { sku: "sku-1", available: 1 } },
      ],
    });
    const result = kernel.invoke(invocation());
    expect(result.outcome).toMatchObject({ status: "tool_error", error: { code: "tool.OUT_OF_STOCK" } });
    expect(result.evidence).toHaveLength(1);
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(1);
    store.close();
  });

  it("rolls back a handler crash but durably records the failed attempt", () => {
    const { kernel, store } = createKernel({});
    const result = kernel.invoke(
      invocation({
        callId: "call_crash01",
        correlationId: "corr_crash01",
        operation: { packageId: "inventory", operationId: "stock.crash" },
        arguments: {},
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "tool_error",
      error: { code: "world.TOOL_HANDLER_CRASH" },
    });
    expect(result.evidence).toHaveLength(1);
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(5);
    store.close();
  });

  it("durably distinguishes invalid, denied, and unsupported attempts", () => {
    const { kernel, store } = createKernel({ grants: [] });
    const invalid = kernel.invoke(invocation({ arguments: { sku: "sku-1", quantity: 0 } }));
    expect(invalid.outcome).toMatchObject({
      status: "invalid",
      error: { code: "framework.INVALID_OPERATION_INPUT" },
    });
    const denied = kernel.invoke(invocation({ callId: "call_denied1", correlationId: "corr_denied1" }));
    expect(denied.outcome).toMatchObject({ status: "denied", error: { code: "world.OPERATION_DENIED" } });
    const unsupported = kernel.invoke(
      invocation({
        callId: "call_unknown1",
        correlationId: "corr_unknown1",
        operation: { packageId: "uninstalled", operationId: "do.work" },
      }),
    );
    expect(unsupported.outcome).toMatchObject({
      status: "unsupported",
      error: { code: "world.OPERATION_UNSUPPORTED" },
    });
    expect(
      store
        .readEvidence()
        .slice(-3)
        .map((entry) => entry.kind),
    ).toEqual(["operation", "operation", "operation"]);
    store.close();
  });

  it("rejects asynchronous behavior rather than committing outside the transaction", () => {
    const asynchronous = inventoryTool();
    const asyncHandler = (() => Promise.resolve({})) as unknown as ToolOperationHandler;
    const tool = defineTool({
      manifest: asynchronous.manifest,
      operations: { ...asynchronous.operations, "stock.crash": asyncHandler },
      subscriptions: asynchronous.subscriptions,
    });
    const { kernel, store } = createKernel({ tools: [tool, activityTool()] });
    const result = kernel.invoke(
      invocation({
        callId: "call_async001",
        correlationId: "corr_async001",
        operation: { packageId: "inventory", operationId: "stock.crash" },
        arguments: {},
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "tool_error",
      error: { code: "world.ASYNC_TOOL_HANDLER" },
    });
    expect(result.evidence).toHaveLength(1);
    store.close();
  });
});

describe("restart behavior", () => {
  it("reuses the same package-driven semantics after reopening the one-file world", () => {
    const { kernel, store, filePath } = createKernel({});
    kernel.invoke(invocation());
    store.close();
    const reopened = SqliteWorldStore.open(filePath);
    const restartedKernel = new WorldKernel({
      store: reopened,
      packageLockHash: HASH_B,
      tools: [inventoryTool(), activityTool()],
    });
    const result = restartedKernel.invoke(
      invocation({
        callId: "call_get0001",
        correlationId: "corr_get0001",
        operation: { packageId: "inventory", operationId: "stock.get" },
        arguments: { sku: "sku-1" },
        idempotencyKey: undefined,
      }),
    );
    expect(result.outcome).toEqual({ status: "ok", value: { sku: "sku-1", available: 3 } });
    expect(reopened.readEvidence().some((entry) => entry.kind === "operation")).toBe(true);
    reopened.close();
  });
});

describe("bound world client", () => {
  it("binds one actor and derives deterministic, ordered invocation identifiers", () => {
    const first = createKernel({});
    const second = createKernel({ fileName: "other.sqlite" });
    try {
      const firstClient = new BoundWorldClient({
        kernel: first.kernel,
        actorBindingId: "actor_primary",
        namespace: "run_repeatable01",
      });
      const secondClient = new BoundWorldClient({
        kernel: second.kernel,
        actorBindingId: "actor_primary",
        namespace: "run_repeatable01",
      });
      const firstCall = firstClient.invoke(
        { packageId: "inventory", operationId: "stock.get" },
        { sku: "sku-1" },
      );
      const nextCall = firstClient.invoke(
        { packageId: "inventory", operationId: "stock.get" },
        { sku: "sku-1" },
      );
      const repeated = secondClient.invoke(
        { packageId: "inventory", operationId: "stock.get" },
        { sku: "sku-1" },
      );

      expect(firstCall.invocation.callId).toBe(repeated.invocation.callId);
      expect(firstCall.invocation.correlationId).toBe(repeated.invocation.correlationId);
      expect(nextCall.invocation.callId).not.toBe(firstCall.invocation.callId);
      expect(firstCall.invocation.actorBindingId).toBe("actor_primary");
      expect(firstClient.callsIssued()).toBe(2);
    } finally {
      first.store.close();
      second.store.close();
    }
  });
});

describe("scenario Tool overrides", () => {
  const operation = { packageId: "inventory", operationId: "stock.reserve" };
  const scope = { kind: "baseline" } as const;
  const returned = { reservationId: "synthetic", remaining: 30 };
  const returnRule: ResolvedToolOverride = {
    id: "return-reservation",
    operation,
    scope,
    outcome: { kind: "return", value: returned },
  };

  it("returns schema-checked data without effects or faults, and replays without consuming again", () => {
    const rules = [{ ...returnRule, times: 1 }];
    const { kernel, store } = createKernel({
      toolOverrides: rules,
      activeFaults: [{ packageId: "inventory", faultId: "a-unavailable" }],
    });
    try {
      const first = kernel.invoke(invocation());
      expect(first.outcome).toEqual({ status: "ok", value: returned });
      expect(first.evidence).toHaveLength(1);
      expect(first.evidence[0]).toMatchObject({
        toolOverride: { id: returnRule.id, scope, outcome: "return", matchIndex: 1 },
      });
      expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(5);
      expect(store.listScheduledEvents()).toEqual([]);
      expect(store.metadata().randomDraws).toBe(0);
      const replay = kernel.invoke(invocation({ callId: "call_replayed" }));
      expect(replay.outcome).toEqual(first.outcome);
      expect(replay.evidence[0]).toMatchObject({
        idempotency: "replayed",
        replayedFromSequence: first.evidence[0]?.sequence,
      });
      expect(replay.evidence[0]).not.toHaveProperty("toolOverride");
      const next = new WorldKernel({
        store,
        packageLockHash: HASH_B,
        tools: [inventoryTool(), activityTool()],
        toolOverrides: rules,
      });
      expect(next.invoke(invocation({ idempotencyKey: "another-request" })).outcome).toMatchObject({
        status: "tool_error",
        error: { code: "tool.UNAVAILABLE" },
      });
    } finally {
      store.close();
    }
  });

  it("consumes a one-shot error, then allows the same unrecorded request to succeed", () => {
    const { kernel, store } = createKernel({
      toolOverrides: [
        {
          id: "first-unavailable",
          operation,
          scope,
          times: 1,
          outcome: { kind: "error", code: "UNAVAILABLE", message: "temporary interruption", retryable: true },
        },
      ],
    });
    try {
      const first = kernel.invoke(invocation());
      expect(first.outcome).toMatchObject({
        status: "tool_error",
        error: { code: "tool.UNAVAILABLE", retryable: true },
      });
      expect(first.evidence).toHaveLength(1);
      expect(first.evidence[0]).toMatchObject({
        idempotency: "not_recorded",
        toolOverride: { outcome: "error", matchIndex: 1 },
      });
      expect(kernel.invoke(invocation()).outcome.status).toBe("ok");
      expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(3);
    } finally {
      store.close();
    }
  });

  it("does not consume rules on denied, invalid, or conflicting calls", () => {
    const { kernel, store } = createKernel({ toolOverrides: [{ ...returnRule, times: 2 }] });
    try {
      expect(kernel.invoke(invocation({ actorBindingId: "actor_absent" })).outcome.status).toBe("denied");
      expect(kernel.invoke(invocation({ arguments: { sku: "sku-1", quantity: 0 } })).outcome.status).toBe(
        "invalid",
      );
      expect(kernel.invoke(invocation({ idempotencyKey: undefined })).outcome.status).toBe("invalid");
      const first = kernel.invoke(invocation());
      expect(first.evidence[0]).toMatchObject({ toolOverride: { matchIndex: 1 } });
      expect(kernel.invoke(invocation({ arguments: { sku: "sku-1", quantity: 3 } })).outcome.status).toBe(
        "invalid",
      );
      const second = kernel.invoke(invocation({ idempotencyKey: "second-valid" }));
      expect(second.evidence[0]).toMatchObject({ toolOverride: { matchIndex: 2 } });
    } finally {
      store.close();
    }
    const denied = createKernel({ toolOverrides: [{ ...returnRule, times: 1 }], grants: [] });
    try {
      expect(denied.kernel.invoke(invocation()).outcome.status).toBe("denied");
      expect(denied.store.readEvidence().filter((entry) => entry.kind === "operation")).not.toContainEqual(
        expect.objectContaining({ toolOverride: expect.anything() }),
      );
    } finally {
      denied.store.close();
    }
  });

  it.each(["a-unavailable", "z-response-timeout"])(
    "an original override retains %s and shields lower rules",
    (faultId) => {
      const { kernel, store } = createKernel({
        activeFaults: [{ packageId: "inventory", faultId }],
        toolOverrides: [
          returnRule,
          {
            id: "keep-behavior",
            operation,
            scope: { kind: "scenario", scenarioId: "faulted" },
            outcome: { kind: "original" },
            times: 1,
          },
        ],
      });
      try {
        const result = kernel.invoke(invocation());
        expect(result.outcome.status).toBe("tool_error");
        expect(result.evidence[0]).toMatchObject({
          toolOverride: { id: "keep-behavior", outcome: "original", matchIndex: 1 },
        });
        expect(result.evidence.some((entry) => entry.kind === "fault" && entry.faultId === faultId)).toBe(
          true,
        );
        expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(
          faultId === "a-unavailable" ? 5 : 3,
        );
        expect(kernel.invoke(invocation({ idempotencyKey: "next-request" })).outcome).toEqual({
          status: "ok",
          value: returned,
        });
      } finally {
        store.close();
      }
    },
  );

  it("retains original-rule provenance and consumption when a handler rolls back", () => {
    const crashing = inventoryTool();
    const tools = [
      defineTool({
        manifest: crashing.manifest,
        operations: {
          ...crashing.operations,
          "stock.reserve": (_input, context) => {
            context.state.put("items", "sku-1", { sku: "sku-1", available: 0 });
            context.random.nextU64();
            context.events.emit("reservation.created", { sku: "sku-1", reservationId: "rolled-back" });
            context.events.scheduleAt("reservation.expired", { sku: "sku-1" }, 2_000);
            throw new Error("fail after effects");
          },
        },
      }),
      activityTool(),
    ];
    const rules: ResolvedToolOverride[] = [
      returnRule,
      { id: "crash-once", operation, scope, outcome: { kind: "original" }, times: 1 },
    ];
    const { kernel, store, filePath } = createKernel({ tools, toolOverrides: rules });
    const failed = kernel.invoke(invocation());
    expect(failed.outcome).toMatchObject({
      status: "tool_error",
      error: { code: "world.TOOL_HANDLER_CRASH" },
    });
    expect(failed.evidence).toHaveLength(1);
    expect(failed.evidence[0]).toMatchObject({ toolOverride: { id: "crash-once", matchIndex: 1 } });
    expect(store.readState("inventory", "items", "sku-1")?.value.available).toBe(5);
    expect(store.metadata().randomDraws).toBe(0);
    expect(store.listScheduledEvents()).toEqual([]);
    store.close();
    const reopened = SqliteWorldStore.open(filePath);
    try {
      const resumed = new WorldKernel({
        store: reopened,
        packageLockHash: HASH_B,
        tools,
        toolOverrides: rules,
      });
      expect(resumed.invoke(invocation()).outcome).toEqual({ status: "ok", value: returned });
    } finally {
      reopened.close();
    }
  });

  it("restores exact nonzero consumption across forks, full reset and package reset", () => {
    const rules = [{ ...returnRule, times: 2 }];
    const { kernel, store, directory } = createKernel({ toolOverrides: rules });
    const fresh = () =>
      new WorldKernel({
        store,
        packageLockHash: HASH_B,
        tools: [inventoryTool(), activityTool()],
        toolOverrides: rules,
      });
    try {
      kernel.invoke(invocation());
      const snapshot = join(directory, "used-once.sqlite");
      const snapshotId = store.createSnapshot(snapshot, "corr_override_snap");
      const fork = SqliteWorldStore.forkFromSnapshot({
        snapshotPath: snapshot,
        snapshotId,
        destinationPath: join(directory, "fork.sqlite"),
        worldInstanceId: "world_overrides_fork",
        correlationId: "corr_override_fork",
      });
      try {
        const forkKernel = new WorldKernel({
          store: fork,
          packageLockHash: HASH_B,
          tools: [inventoryTool(), activityTool()],
          toolOverrides: rules,
        });
        expect(forkKernel.invoke(invocation({ idempotencyKey: "fork-next" })).evidence[0]).toMatchObject({
          toolOverride: { matchIndex: 2 },
        });
      } finally {
        fork.close();
      }
      expect(kernel.invoke(invocation({ idempotencyKey: "second" })).evidence[0]).toMatchObject({
        toolOverride: { matchIndex: 2 },
      });
      expect(kernel.invoke(invocation({ idempotencyKey: "third" })).evidence[0]).not.toHaveProperty(
        "toolOverride",
      );
      store.resetPackagesFromSnapshot(snapshot, ["inventory"], "corr_override_pkg_reset");
      expect(fresh().invoke(invocation({ idempotencyKey: "after-package-reset" })).evidence[0]).toMatchObject(
        { toolOverride: { matchIndex: 2 } },
      );
      store.resetFromSnapshot(snapshot, "corr_override_reset");
      expect(fresh().invoke(invocation({ idempotencyKey: "after-full-reset" })).evidence[0]).toMatchObject({
        toolOverride: { matchIndex: 2 },
      });
    } finally {
      store.close();
    }
  });

  it("rejects unknown operations, duplicate ids, undeclared errors and invalid returns", () => {
    const { store } = createKernel({});
    try {
      const make = (toolOverrides: readonly ResolvedToolOverride[]) =>
        new WorldKernel({
          store,
          packageLockHash: HASH_B,
          tools: [inventoryTool(), activityTool()],
          toolOverrides,
        });
      expect(() => make([{ ...returnRule, operation: { ...operation, operationId: "missing" } }])).toThrow(
        "unavailable operation",
      );
      expect(() => make([returnRule, returnRule])).toThrow("duplicate Tool override id");
      expect(() =>
        make([{ ...returnRule, outcome: { kind: "error", code: "UNKNOWN", message: "not declared" } }]),
      ).toThrow("undeclared error");
      expect(() => make([{ ...returnRule, outcome: { kind: "return", value: { wrong: true } } }])).toThrow(
        "output schema",
      );
    } finally {
      store.close();
    }
  });

  it("matches actors and complete nested JSON values, not recursive subsets", () => {
    const tool = defineTool({
      manifest: {
        schemaVersion: 1,
        id: "echo-service",
        version: "1.0.0",
        engine: ">=0.1.0",
        capabilities: [],
        operations: [
          {
            id: "respond",
            inputSchema: { type: "object" },
            outputSchema: { type: "string" },
            idempotency: "none",
            fidelity: "contract",
          },
        ],
      },
      operations: { respond: () => "original" },
    });
    const ref = { packageId: "echo-service", operationId: "respond" };
    const { kernel, store } = createKernel({
      tools: [tool],
      grants: [ref],
      toolOverrides: [
        { id: "fallback", operation: ref, scope, outcome: { kind: "return", value: "fallback" } },
        {
          id: "matched",
          operation: ref,
          scope,
          when: { actorId: "operator", arguments: { object: { a: 1, b: [2, 3] } } },
          outcome: { kind: "return", value: "matched" },
        },
        {
          id: "other-actor",
          operation: ref,
          scope,
          when: { actorId: "someone-else" },
          outcome: { kind: "return", value: "wrong-actor" },
        },
      ],
    });
    const invoke = (args: JsonObject) =>
      kernel.invoke(invocation({ operation: ref, arguments: args, idempotencyKey: undefined }));
    try {
      expect(invoke({ object: { b: [2, 3], a: 1 }, extra: true }).outcome).toEqual({
        status: "ok",
        value: "matched",
      });
      expect(invoke({ object: { a: 1, b: [2, 3], extra: true } }).outcome).toEqual({
        status: "ok",
        value: "fallback",
      });
      expect(invoke({ object: { a: 1, b: [3, 2] } }).outcome).toEqual({ status: "ok", value: "fallback" });
      expect(invoke({}).outcome).toEqual({ status: "ok", value: "fallback" });
    } finally {
      store.close();
    }
  });
});
