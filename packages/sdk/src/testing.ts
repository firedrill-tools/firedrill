import type {
  ErrorEnvelope,
  JsonObject,
  JsonValue,
  OperationOutcome,
  OperationRef,
} from "@firedrill/contracts";
import { JsonObjectSchema, OperationOutcomeSchema, OperationRefSchema } from "@firedrill/contracts";
import type { AgentBinding } from "./run-drills.js";

export interface MockToolOptions<Arguments extends readonly unknown[], Result = JsonValue> {
  /** Controls whether calls return directly or return a promise, including failures. */
  readonly mode: "sync" | "async";
  readonly operation: OperationRef;
  /** Translate the existing dependency's arguments into one world operation input. */
  readonly input: (...arguments_: Arguments) => JsonObject;
  /** Translate only successful world values into the existing dependency's result. */
  readonly output?: (value: JsonValue) => Result;
  /** Translate a failed world outcome into the dependency's native Error type. */
  readonly error?: (envelope: ErrorEnvelope) => Error;
  readonly idempotencyKey?: (...arguments_: Arguments) => string;
}

type FailedOutcomeStatus = Exclude<OperationOutcome["status"], "ok">;

/** Default failure when no native-error mapper was supplied. World evidence is unchanged. */
export class ToolMockError extends Error {
  readonly envelope: ErrorEnvelope;
  readonly status: FailedOutcomeStatus;

  constructor(envelope: ErrorEnvelope, status: FailedOutcomeStatus) {
    super(envelope.message);
    this.name = "ToolMockError";
    this.envelope = envelope;
    this.status = status;
  }
}

/**
 * Creates a test-only replacement for an existing callable dependency. Install it
 * with the caller's own module mock, spy, or dependency-injection seam. This does
 * not patch imports, intercept subprocesses, or fall through to a real service.
 * The supplied direct binding owns state, permissions, faults, and call evidence.
 */
export function mockTool<Arguments extends readonly unknown[], Result>(
  binding: AgentBinding,
  options: MockToolOptions<Arguments, Result> & {
    readonly mode: "sync";
    readonly output: (value: JsonValue) => Result;
  },
): (...arguments_: Arguments) => Result;
export function mockTool<Arguments extends readonly unknown[]>(
  binding: AgentBinding,
  options: MockToolOptions<Arguments> & { readonly mode: "sync"; readonly output?: never },
): (...arguments_: Arguments) => JsonValue;
export function mockTool<Arguments extends readonly unknown[], Result>(
  binding: AgentBinding,
  options: MockToolOptions<Arguments, Result> & {
    readonly mode: "async";
    readonly output: (value: JsonValue) => Result;
  },
): (...arguments_: Arguments) => Promise<Awaited<Result>>;
export function mockTool<Arguments extends readonly unknown[]>(
  binding: AgentBinding,
  options: MockToolOptions<Arguments> & { readonly mode: "async"; readonly output?: never },
): (...arguments_: Arguments) => Promise<JsonValue>;
export function mockTool<Arguments extends readonly unknown[], Result>(
  binding: AgentBinding,
  options: MockToolOptions<Arguments, Result>,
): (...arguments_: Arguments) => unknown {
  const world = binding?.world;
  if (world === undefined || world === null || typeof world.invoke !== "function") {
    throw new TypeError("mockTool requires an active direct world binding; declare a direct target binding");
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mockTool options must be an object");
  }
  const allowed = new Set(["mode", "operation", "input", "output", "error", "idempotencyKey"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new TypeError("mockTool options contain an unknown field");
  }
  if (options.mode !== "sync" && options.mode !== "async") {
    throw new TypeError('mockTool mode must be "sync" or "async"');
  }
  if (typeof options.input !== "function") {
    throw new TypeError("mockTool input must be a function");
  }
  for (const key of ["output", "error", "idempotencyKey"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new TypeError(`mockTool ${key} must be a function when supplied`);
    }
  }
  const operation = OperationRefSchema.parse(options.operation);
  const { input, output, error, idempotencyKey, mode } = options;
  const invokeWorld = world.invoke.bind(world);
  const invoke = (...arguments_: Arguments): Result | JsonValue => {
    const argumentsInput = JsonObjectSchema.parse(input(...arguments_));
    let callOptions = {};
    if (idempotencyKey !== undefined) {
      const key = idempotencyKey(...arguments_);
      if (typeof key !== "string" || key.length === 0 || key.length > 255) {
        throw new TypeError("mockTool idempotencyKey must return a string containing 1 to 255 characters");
      }
      callOptions = { idempotencyKey: key };
    }
    const outcome = OperationOutcomeSchema.parse(invokeWorld(operation, argumentsInput, callOptions).outcome);
    if (outcome.status !== "ok") {
      if (outcome.error === undefined) throw new TypeError("failed world operation did not contain an error");
      if (error === undefined) throw new ToolMockError(outcome.error, outcome.status);
      const nativeError = error(outcome.error);
      if (!(nativeError instanceof Error)) throw new TypeError("mockTool error mapper must return an Error");
      throw nativeError;
    }
    if (outcome.value === undefined)
      throw new TypeError("successful world operation did not contain a value");
    return output === undefined ? outcome.value : output(outcome.value);
  };
  return mode === "async" ? async (...arguments_: Arguments) => invoke(...arguments_) : invoke;
}
