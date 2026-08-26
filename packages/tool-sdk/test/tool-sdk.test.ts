import { describe, expect, it } from "vitest";
import { ToolFailure, defineTool, defineToolBehavior, isToolFailure } from "../src/index.js";

const manifest = {
  schemaVersion: 1,
  id: "calendar",
  version: "1.0.0",
  engine: ">=0.1.0",
  capabilities: ["state.read"],
  state: [{ namespace: "events", schema: { type: "object" } }],
  operations: [
    {
      id: "events.get",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      idempotency: "none",
      fidelity: "stateful",
    },
  ],
  subscriptions: [
    {
      id: "receive-reminder",
      event: { packageId: "messaging", eventId: "reminder.sent" },
    },
  ],
} as const;

describe("defineTool", () => {
  it("accepts exact operation and subscription handlers", () => {
    const tool = defineTool({
      manifest,
      operations: { "events.get": () => ({ id: "event_1" }) },
      subscriptions: { "receive-reminder": () => undefined },
    });
    expect(tool.manifest.id).toBe("calendar");
  });

  it("deeply freezes the validated manifest so runtime routing cannot drift", () => {
    const tool = defineTool({
      manifest,
      operations: { "events.get": () => ({ id: "event_1" }) },
      subscriptions: { "receive-reminder": () => undefined },
    });
    expect(Object.isFrozen(tool.manifest)).toBe(true);
    expect(Object.isFrozen(tool.manifest.operations)).toBe(true);
    expect(Object.isFrozen(tool.manifest.operations[0])).toBe(true);
    expect(Object.isFrozen(tool.manifest.operations[0]?.inputSchema)).toBe(true);
  });

  it("rejects missing and undeclared handlers", () => {
    expect(() =>
      defineTool({
        manifest,
        operations: { "events.delete": () => ({}) },
      }),
    ).toThrow(/missing: events.get; undeclared: events.delete/);
  });
});

describe("defineToolBehavior", () => {
  it("supports a manifest-independent behavior module", () => {
    const behavior = defineToolBehavior({ operations: { "slots.reserve": () => ({ reserved: true }) } });
    expect(behavior.operations["slots.reserve"]?.({}, {} as never)).toEqual({ reserved: true });
    expect(Object.isFrozen(behavior.operations)).toBe(true);
  });

  it("rejects extra surfaces and non-functions", () => {
    expect(() =>
      defineToolBehavior({ operations: {}, hidden: {} } as unknown as Parameters<
        typeof defineToolBehavior
      >[0]),
    ).toThrow(/only operations, subscriptions, http, and callbacks/);
    expect(() =>
      defineToolBehavior({ operations: { invalid: true } } as unknown as Parameters<
        typeof defineToolBehavior
      >[0]),
    ).toThrow(/must be a function/);
  });

  it("requires exact pure codecs for declared HTTP routes", () => {
    const routeManifest = {
      ...manifest,
      http: [
        {
          id: "get-event",
          operationId: "events.get",
          method: "GET",
          path: "/events/{eventId}",
          auth: { kind: "bearer" },
          requestBody: "none",
          response: { successStatus: 200, errors: [] },
        },
      ],
    } as const;
    expect(() =>
      defineTool({
        manifest: routeManifest,
        operations: { "events.get": () => ({ id: "event_1" }) },
        subscriptions: { "receive-reminder": () => undefined },
      }),
    ).toThrow(/HTTP route handlers do not match the manifest \(missing: get-event\)/);

    const tool = defineTool({
      manifest: routeManifest,
      operations: { "events.get": () => ({ id: "event_1" }) },
      subscriptions: { "receive-reminder": () => undefined },
      http: {
        "get-event": {
          decode: (request) => ({ arguments: { id: request.path.eventId ?? "missing" } }),
          encode: ({ outcome }) => ({
            body:
              outcome.status === "ok"
                ? { kind: "json", value: outcome.value ?? null }
                : { kind: "json", value: { error: outcome.error?.message ?? "failed" } },
          }),
        },
      },
    });
    expect(Object.isFrozen(tool.http)).toBe(true);
  });

  it("requires an exact pure codec for each declared callback", () => {
    const callbackManifest = {
      ...manifest,
      events: [{ id: "reminder.due", payloadSchema: { type: "object" } }],
      callbacks: [
        {
          id: "notify-application",
          eventId: "reminder.due",
          receiverId: "application",
          method: "POST",
          path: "/callbacks/reminders",
          idempotencyHeader: "Idempotency-Key",
        },
      ],
    } as const;
    expect(() =>
      defineTool({
        manifest: callbackManifest,
        operations: { "events.get": () => ({ id: "event_1" }) },
        subscriptions: { "receive-reminder": () => undefined },
      }),
    ).toThrow(/callback handlers do not match the manifest \(missing: notify-application\)/);

    const tool = defineTool({
      manifest: callbackManifest,
      operations: { "events.get": () => ({ id: "event_1" }) },
      subscriptions: { "receive-reminder": () => undefined },
      callbacks: {
        "notify-application": {
          encode: ({ deliveryId, payload }) => ({
            headers: { "content-type": "application/json" },
            body: { kind: "json", value: { deliveryId, payload } },
          }),
        },
      },
    });
    expect(Object.isFrozen(tool.callbacks)).toBe(true);
    expect(() =>
      defineToolBehavior({
        operations: {},
        callbacks: { invalid: { encode: () => ({ body: { kind: "empty" } }), hidden: true } },
      } as never),
    ).toThrow(/callbacks.invalid must contain only an encode function/);
  });
});

describe("ToolFailure", () => {
  it("keeps structured expected failure details", () => {
    const failure = new ToolFailure({
      code: "CONFLICT",
      message: "the event overlaps",
      details: { existingId: "event_1" },
    });
    expect(failure.code).toBe("CONFLICT");
    expect(failure.details).toEqual({ existingId: "event_1" });
    expect(isToolFailure(failure)).toBe(true);
    expect(
      isToolFailure({
        name: "ToolFailure",
        message: "spoofed without the shared brand",
        code: "CONFLICT",
        retryable: false,
      }),
    ).toBe(false);
  });

  it("rejects unstable error codes", () => {
    expect(() => new ToolFailure({ code: "not-valid", message: "bad" })).toThrow(/invalid Tool/);
  });
});
