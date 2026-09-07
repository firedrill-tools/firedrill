import type { ErrorEnvelope, JsonObject, JsonValue, OperationOutcome } from "@firedrill/contracts";
import { OperationInvocationSchema } from "@firedrill/contracts";
import { BoundWorldClient, type WorldKernel } from "@firedrill/world-kernel";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentBinding } from "../src/run-drills.js";
import { type MockToolOptions, mockTool, ToolMockError } from "../src/testing.js";

const operation = { packageId: "message-store", operationId: "messages.update" };
const envelope: ErrorEnvelope = {
  schemaVersion: 1,
  code: "tool.NOT_ALLOWED",
  source: "tool",
  message: "The actor may not update this message",
  retryable: false,
  correlationId: "corr_test_mock",
  issues: [{ code: "owner", message: "Actor is not the owner", path: ["messageId"] }],
  details: { expectedOwner: "another-actor" },
  evidence: { runId: "run_test_mock", sequence: 3 },
};

/** Stub only the kernel result; use the real actor-scoped client, including revocation. */
function bindingFor(outcome: OperationOutcome = { status: "ok", value: { changed: true } }) {
  const kernelInvoke = vi.fn<WorldKernel["invoke"]>((input) => ({
    invocation: OperationInvocationSchema.parse(input),
    outcome,
    evidence: [],
  }));
  const world = new BoundWorldClient({
    kernel: { invoke: kernelInvoke } as unknown as WorldKernel,
    actorBindingId: "actor_test_mock",
    namespace: "mock-tool-test",
  });
  const invoke = vi.spyOn(world, "invoke");
  const binding: AgentBinding = { environment: {}, world };
  return { binding, world, invoke, kernelInvoke };
}

describe("mockTool", () => {
  it("infers the native signature and forwards one mapped, actor-scoped call", () => {
    const { binding, invoke, kernelInvoke } = bindingFor();
    const input = vi.fn((messageId: string, revision: number): JsonObject => ({ messageId, revision }));
    const idempotencyKey = vi.fn((messageId: string, revision: number) => `${messageId}:${revision}`);
    const output = vi.fn((value: JsonValue) => ({ accepted: Boolean((value as JsonObject).changed) }));
    const replacement = mockTool(binding, { mode: "sync", operation, input, output, idempotencyKey });

    expectTypeOf(replacement).parameters.toEqualTypeOf<[string, number]>();
    expectTypeOf(replacement).returns.toEqualTypeOf<{ accepted: boolean }>();
    expect(replacement("message-1", 4)).toEqual({ accepted: true });
    expect(input).toHaveBeenCalledExactlyOnceWith("message-1", 4);
    expect(idempotencyKey).toHaveBeenCalledExactlyOnceWith("message-1", 4);
    expect(output).toHaveBeenCalledExactlyOnceWith({ changed: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      operation,
      { messageId: "message-1", revision: 4 },
      { idempotencyKey: "message-1:4" },
    );
    expect(kernelInvoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actorBindingId: "actor_test_mock",
        operation,
        idempotencyKey: "message-1:4",
      }),
    );
  });

  it.each(
    ([null, false, 0, "", [1, "two"], { changed: false }] satisfies JsonValue[]).map((value) => ({ value })),
  )("returns an unmodified successful JSON value: $value", ({ value }) => {
    const { binding, invoke } = bindingFor({ status: "ok", value });
    const replacement = mockTool(binding, { mode: "sync", operation, input: () => ({}) });
    expectTypeOf(replacement).returns.toEqualTypeOf<JsonValue>();
    expect(replacement()).toEqual(value);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(operation, {}, {});
  });

  it("returns promises in async mode with inferred raw and mapped result types", async () => {
    const { binding } = bindingFor({ status: "ok", value: "updated" });
    const raw = mockTool(binding, { mode: "async", operation, input: (id: string) => ({ id }) });
    const mapped = mockTool(binding, {
      mode: "async",
      operation,
      input: (id: string) => ({ id }),
      output: (value) => Promise.resolve(String(value).toUpperCase()),
    });
    expectTypeOf(raw).toEqualTypeOf<(id: string) => Promise<JsonValue>>();
    expectTypeOf(mapped).toEqualTypeOf<(id: string) => Promise<string>>();
    await expect(raw("message-1")).resolves.toBe("updated");
    await expect(mapped("message-2")).resolves.toBe("UPDATED");
  });

  it.each(["denied", "tool_error", "unsupported", "invalid"] as const)(
    "throws a typed error preserving the complete %s world envelope",
    (status) => {
      const { binding, invoke } = bindingFor({ status, error: envelope });
      const output = vi.fn(() => "must not succeed");
      const replacement = mockTool(binding, { mode: "sync", operation, input: () => ({}), output });
      let caught: unknown;
      try {
        replacement();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolMockError);
      expect(caught).toMatchObject({ name: "ToolMockError", message: envelope.message, status, envelope });
      expect(output).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects asynchronously for a world failure without throwing from the call site", async () => {
    const { binding } = bindingFor({ status: "denied", error: envelope });
    const replacement = mockTool(binding, { mode: "async", operation, input: () => ({}) });
    let result: Promise<JsonValue> | undefined;
    expect(() => {
      result = replacement();
    }).not.toThrow();
    await expect(result).rejects.toMatchObject({ name: "ToolMockError", status: "denied", envelope });
  });

  it("throws a mapped native Error directly, never returns it as success", () => {
    class NativeServiceError extends Error {}
    const nativeError = new NativeServiceError("native failure", { cause: envelope });
    const { binding } = bindingFor({ status: "tool_error", error: envelope });
    const error = vi.fn(() => nativeError);
    const output = vi.fn(() => "unexpected success");
    const replacement = mockTool(binding, { mode: "sync", operation, input: () => ({}), error, output });
    expect(replacement).toThrow(nativeError);
    expect(error).toHaveBeenCalledExactlyOnceWith(envelope);
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects an invalid native-error mapping instead of converting failure to success", () => {
    const { binding } = bindingFor({ status: "invalid", error: envelope });
    const replacement = mockTool(binding, {
      mode: "sync",
      operation,
      input: () => ({}),
      error: (() => "not an error") as unknown as (value: ErrorEnvelope) => Error,
    });
    expect(replacement).toThrow("mockTool error mapper must return an Error");
  });

  it("fails at factory setup when a direct binding is missing, including async mode", () => {
    const binding: AgentBinding = { environment: { FIREDRILL_HTTP_URL: "http://127.0.0.1:1" } };
    const input = vi.fn(() => ({}));
    expect(() => mockTool(binding, { mode: "sync", operation, input })).toThrow("direct world binding");
    expect(() => mockTool(binding, { mode: "async", operation, input })).toThrow("direct world binding");
    expect(input).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "automatic" },
    { input: undefined },
    { output: false },
    { error: false },
    { idempotencyKey: false },
    { operation: { packageId: "Invalid package", operationId: "messages.update" } },
    { operation: { ...operation, extra: true } },
    { fallback: () => "must not run" },
  ])("validates options before invoking the world: %j", (invalid) => {
    const { binding, invoke } = bindingFor();
    const options = { mode: "sync", operation, input: () => ({}), ...invalid } as unknown as MockToolOptions<
      []
    > & { mode: "sync"; output?: never };
    expect(() => mockTool(binding, options)).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(256), 42, undefined])("refuses invalid idempotency keys: %j", (key) => {
    const { binding, invoke } = bindingFor();
    const idempotencyKey = vi.fn(() => key) as unknown as () => string;
    const replacement = mockTool(binding, { mode: "sync", operation, input: () => ({}), idempotencyKey });
    expect(replacement).toThrow("mockTool idempotencyKey must return a string");
    expect(idempotencyKey).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates mapper exceptions and invokes no fallback", async () => {
    const { binding, invoke } = bindingFor();
    const failure = new Error("input mapping failed");
    const input = () => {
      throw failure;
    };
    const synchronous = mockTool(binding, { mode: "sync", operation, input });
    const asynchronous = mockTool(binding, { mode: "async", operation, input });
    expect(synchronous).toThrow(failure);
    await expect(asynchronous()).rejects.toBe(failure);
    expect(invoke).not.toHaveBeenCalled();

    const output = () => {
      throw failure;
    };
    const badOutput = mockTool(binding, { mode: "sync", operation, input: () => ({}), output });
    expect(badOutput).toThrow(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON mapped input before invoking the world", () => {
    const { binding, invoke } = bindingFor();
    const input = (() => ({ value: undefined })) as unknown as () => JsonObject;
    const replacement = mockTool(binding, { mode: "sync", operation, input });
    expect(replacement).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each<OperationOutcome>([
    { status: "ok" },
    { status: "denied" },
    { status: "ok", value: "success", error: envelope },
    { status: "tool_error", value: "success", error: envelope },
  ])("refuses malformed world outcomes instead of manufacturing success: %j", (outcome) => {
    const { binding } = bindingFor(outcome);
    const output = vi.fn(() => "must not run");
    const replacement = mockTool(binding, { mode: "sync", operation, input: () => ({}), output });
    expect(replacement).toThrow();
    expect(output).not.toHaveBeenCalled();
  });

  it("retains revocation checks and cannot invoke the kernel after the binding ends", async () => {
    const { binding, world, kernelInvoke } = bindingFor();
    const synchronous = mockTool(binding, { mode: "sync", operation, input: () => ({}) });
    const asynchronous = mockTool(binding, { mode: "async", operation, input: () => ({}) });
    world.revoke();
    expect(synchronous).toThrow("world client is no longer active");
    await expect(asynchronous()).rejects.toThrow("world client is no longer active");
    expect(kernelInvoke).not.toHaveBeenCalled();
  });

  it("captures the configured operation and mappers before later caller mutation", () => {
    const { binding, invoke } = bindingFor();
    const chosenOperation = { ...operation };
    const options = { mode: "sync" as const, operation: chosenOperation, input: () => ({ value: 1 }) };
    const replacement = mockTool(binding, options);
    chosenOperation.operationId = "messages.delete";
    options.input = () => ({ value: 2 });
    replacement();
    expect(invoke).toHaveBeenCalledExactlyOnceWith(operation, { value: 1 }, {});
  });
});
