import { createHash } from "node:crypto";
import {
  CorrelationIdSchema,
  FIREDRILL_ENGINE_VERSION,
  JsonObjectSchema,
  JsonValueSchema,
  OperationInvocationSchema,
  OperationOutcomeSchema,
  Sha256Schema,
  VirtualTimeSchema,
  canonicalJson,
} from "@firedrill/contracts";
import type {
  CorrelationId,
  ErrorEnvelope,
  EventRef,
  EvidenceEntry,
  JsonObject,
  JsonValue,
  OperationContract,
  OperationInvocation,
  OperationOutcome,
  ToolEventContract,
  ToolPackageManifest,
} from "@firedrill/contracts";
import { ToolFailure, isToolFailure } from "@firedrill/tool-sdk";
import type {
  ToolActor,
  ToolContext,
  ToolDefinition,
  ToolExecutionSource,
  ToolOperationHandler,
  ToolSubscriptionHandler,
} from "@firedrill/tool-sdk";
import type {
  EvidenceDraft,
  StoredActor,
  WorldStore,
  WorldTransaction,
  WorldTransactionResult,
} from "@firedrill/world-store";
import type { ValidateFunction } from "ajv";
import { satisfies, validRange } from "semver";
import { ExecutionAbort, frameworkError, toolError, worldError } from "./errors.js";
import type {
  AdvanceTimeOptions,
  ClockAdvanceResult,
  KernelInvocationResult,
  ScheduledEventFailure,
  WorldKernelBudgets,
  WorldKernelOptions,
  WorldKernelUsage,
} from "./types.js";
import { ajvIssues, createSchemaCompiler } from "./validation.js";
import type { CompiledOperationSchemas } from "./validation.js";

export const WORLD_ENGINE_VERSION = FIREDRILL_ENGINE_VERSION;

interface OperationRuntime {
  readonly tool: ToolDefinition;
  readonly contract: OperationContract;
  readonly handler: ToolOperationHandler;
  readonly schemas: CompiledOperationSchemas;
}

interface EventRuntime {
  readonly tool: ToolDefinition;
  readonly contract: ToolEventContract;
  readonly validate: ValidateFunction<unknown>;
}

interface StateRuntime {
  readonly validate: ValidateFunction<unknown>;
}

interface SubscriptionRuntime {
  readonly tool: ToolDefinition;
  readonly subscriptionId: string;
  readonly event: EventRef;
  readonly handler: ToolSubscriptionHandler;
}

interface QueuedEvent {
  readonly event: EventRef;
  readonly payload: JsonObject;
}

interface BudgetState {
  stateMutations: number;
  events: number;
  randomDraws: number;
}

const DEFAULT_BUDGETS: WorldKernelBudgets = {
  maxToolCalls: 1_000,
  maxStateMutations: 10_000,
  maxEvents: 10_000,
  maxRandomDraws: 10_000,
};

const UINT64_SPACE = 1n << 64n;

function operationKey(packageId: string, operationId: string): string {
  return `${packageId}\u0000${operationId}`;
}

function eventKey(event: EventRef): string {
  return `${event.packageId}\u0000${event.eventId}`;
}

function positiveBudget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function eventAdvanceBudget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function requestHash(invocation: OperationInvocation): string {
  const semantic = {
    operation: invocation.operation,
    actorBindingId: invocation.actorBindingId,
    arguments: invocation.arguments,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(semantic)).digest("hex")}`;
}

function operationGranted(actor: StoredActor, invocation: OperationInvocation): boolean {
  return actor.grants.some(
    (grant) =>
      grant.packageId === invocation.operation.packageId &&
      grant.operationId === invocation.operation.operationId,
  );
}

function unrecordedIdempotency(invocation: OperationInvocation): "not_requested" | "not_recorded" {
  return invocation.idempotencyKey === undefined ? "not_requested" : "not_recorded";
}

function errorDetails(error: unknown): JsonObject {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { thrownType: typeof error };
}

export class WorldKernel {
  readonly store: WorldStore;
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly operations = new Map<string, OperationRuntime>();
  private readonly events = new Map<string, EventRuntime>();
  private readonly state = new Map<string, StateRuntime>();
  private readonly subscriptions = new Map<string, readonly SubscriptionRuntime[]>();
  private readonly budgets: WorldKernelBudgets;
  private readonly onToolCallBudgetExceeded: WorldKernelOptions["onToolCallBudgetExceeded"];
  private toolCalls = 0;
  private toolCallBudgetExceeded = false;

  constructor(options: WorldKernelOptions) {
    this.store = options.store;
    const packageLockHash = Sha256Schema.parse(options.packageLockHash);
    const storedLockHash = this.store.metadata().packageLockHash;
    if (packageLockHash !== storedLockHash) {
      throw new TypeError(
        `resolved Tool set ${packageLockHash} does not match world package lock ${storedLockHash}`,
      );
    }
    this.budgets = {
      maxToolCalls: positiveBudget(
        options.budgets?.maxToolCalls ?? DEFAULT_BUDGETS.maxToolCalls,
        "maxToolCalls",
      ),
      maxStateMutations: positiveBudget(
        options.budgets?.maxStateMutations ?? DEFAULT_BUDGETS.maxStateMutations,
        "maxStateMutations",
      ),
      maxEvents: positiveBudget(options.budgets?.maxEvents ?? DEFAULT_BUDGETS.maxEvents, "maxEvents"),
      maxRandomDraws: positiveBudget(
        options.budgets?.maxRandomDraws ?? DEFAULT_BUDGETS.maxRandomDraws,
        "maxRandomDraws",
      ),
    };
    this.onToolCallBudgetExceeded = options.onToolCallBudgetExceeded;
    const compiler = createSchemaCompiler();
    for (const tool of options.tools) {
      const manifest = tool.manifest;
      if (this.tools.has(manifest.id)) throw new TypeError(`duplicate Tool package ${manifest.id}`);
      const range = validRange(manifest.engine);
      if (range === null || !satisfies(WORLD_ENGINE_VERSION, range, { includePrerelease: true })) {
        throw new TypeError(
          `Tool package ${manifest.id}@${manifest.version} requires engine ${manifest.engine}; current engine is ${WORLD_ENGINE_VERSION}`,
        );
      }
      this.tools.set(manifest.id, tool);
      for (const contract of manifest.state) {
        this.state.set(operationKey(manifest.id, contract.namespace), {
          validate: compiler.compilePayload(contract.schema),
        });
      }
      for (const contract of manifest.operations) {
        const key = operationKey(manifest.id, contract.id);
        const handler = tool.operations[contract.id];
        if (handler === undefined)
          throw new TypeError(`Tool package ${manifest.id} has no handler for ${contract.id}`);
        this.operations.set(key, {
          tool,
          contract,
          handler,
          schemas: compiler.compile(contract.inputSchema, contract.outputSchema),
        });
      }
      for (const contract of manifest.events) {
        const key = eventKey({ packageId: manifest.id, eventId: contract.id });
        this.events.set(key, { tool, contract, validate: compiler.compilePayload(contract.payloadSchema) });
      }
    }

    const pendingSubscriptions = new Map<string, SubscriptionRuntime[]>();
    for (const tool of options.tools) {
      for (const contract of tool.manifest.subscriptions) {
        const key = eventKey(contract.event);
        if (!this.events.has(key)) {
          throw new TypeError(
            `Tool package ${tool.manifest.id} subscribes to unavailable event ${contract.event.packageId}.${contract.event.eventId}`,
          );
        }
        const handler = tool.subscriptions[contract.id];
        if (handler === undefined) {
          throw new TypeError(
            `Tool package ${tool.manifest.id} has no subscription handler for ${contract.id}`,
          );
        }
        const subscribers = pendingSubscriptions.get(key) ?? [];
        subscribers.push({ tool, subscriptionId: contract.id, event: contract.event, handler });
        pendingSubscriptions.set(key, subscribers);
      }
    }
    for (const [key, subscribers] of pendingSubscriptions) {
      this.subscriptions.set(
        key,
        [...subscribers].sort((left, right) => {
          const packageOrder = left.tool.manifest.id.localeCompare(right.tool.manifest.id);
          return packageOrder === 0 ? left.subscriptionId.localeCompare(right.subscriptionId) : packageOrder;
        }),
      );
    }
  }

  usage(): WorldKernelUsage {
    return {
      toolCalls: this.toolCalls,
      maxToolCalls: this.budgets.maxToolCalls,
      toolCallBudgetExceeded: this.toolCallBudgetExceeded,
    };
  }

  invoke(input: unknown): KernelInvocationResult {
    const invocation = OperationInvocationSchema.parse(input);
    this.toolCalls += 1;
    if (this.toolCalls > this.budgets.maxToolCalls) {
      const result = this.recordOutcome(invocation, {
        status: "tool_error",
        error: worldError(
          invocation.correlationId,
          "TOOL_CALL_BUDGET_EXCEEDED",
          `drill exceeded its ${this.budgets.maxToolCalls} Tool-call budget`,
          {
            details: {
              attempted: this.toolCalls,
              limit: this.budgets.maxToolCalls,
            },
          },
        ),
      });
      if (!this.toolCallBudgetExceeded) {
        this.toolCallBudgetExceeded = true;
        try {
          this.onToolCallBudgetExceeded?.(this.usage());
        } catch {
          // Observers cannot change the already recorded operation outcome.
        }
      }
      return result;
    }
    const runtime = this.operations.get(
      operationKey(invocation.operation.packageId, invocation.operation.operationId),
    );
    if (runtime === undefined) {
      return this.recordOutcome(invocation, {
        status: "unsupported",
        error: worldError(
          invocation.correlationId,
          "OPERATION_UNSUPPORTED",
          `operation ${invocation.operation.packageId}.${invocation.operation.operationId} is not installed in this world`,
        ),
      });
    }

    if (!runtime.schemas.input(invocation.arguments)) {
      return this.recordOutcome(invocation, {
        status: "invalid",
        error: frameworkError(
          invocation.correlationId,
          "INVALID_OPERATION_INPUT",
          `arguments do not match ${invocation.operation.packageId}.${invocation.operation.operationId}`,
          { issues: ajvIssues(runtime.schemas.input.errors) },
        ),
      });
    }

    const idempotencyError = this.validateIdempotencyContract(invocation, runtime.contract);
    if (idempotencyError !== undefined) {
      return this.recordOutcome(invocation, { status: "invalid", error: idempotencyError });
    }

    try {
      const committed = this.store.transact(invocation.correlationId, (transaction) =>
        this.executeOperation(transaction, invocation, runtime),
      );
      return {
        invocation,
        outcome: committed.value,
        evidence: committed.evidence,
      };
    } catch (error) {
      if (!(error instanceof ExecutionAbort)) throw error;
      const secondary: EvidenceDraft[] = [];
      if (error.failedEvent !== undefined) {
        secondary.push({
          kind: "event",
          event: error.failedEvent.event,
          phase: "failed",
          payload: error.failedEvent.payload,
          ...(error.failedEvent.handlerPackageId === undefined
            ? {}
            : { handlerPackageId: error.failedEvent.handlerPackageId }),
          ...(error.failedEvent.subscriptionId === undefined
            ? {}
            : { subscriptionId: error.failedEvent.subscriptionId }),
        });
      }
      return this.recordOutcome(
        invocation,
        { status: "tool_error", error: error.envelope },
        undefined,
        secondary,
      );
    }
  }

  advanceTime(toUs: number, options: AdvanceTimeOptions): ClockAdvanceResult {
    const requestedUs = VirtualTimeSchema.parse(toUs);
    const correlationId = CorrelationIdSchema.parse(options.correlationId);
    const maxEvents = eventAdvanceBudget(options.maxEvents ?? this.budgets.maxEvents, "maxEvents");
    const startedAt = this.store.metadata().virtualTimeUs;
    if (requestedUs < startedAt) throw new RangeError("virtual clock cannot move backward");
    let processed = 0;
    let stoppedEarly = false;
    const failures: ScheduledEventFailure[] = [];
    const evidence: EvidenceEntry[] = [];

    while (true) {
      const scheduled = this.store.nextScheduledEvent(requestedUs);
      if (scheduled === null) break;
      if (processed >= maxEvents) {
        failures.push({
          scheduledEventId: scheduled.id,
          error: worldError(
            correlationId,
            "EVENT_BUDGET_EXCEEDED",
            `advance stopped after ${maxEvents} scheduled events`,
          ),
        });
        break;
      }
      const current = this.store.metadata().virtualTimeUs;
      if (scheduled.dueUs > current) {
        const clock = this.store.transact(correlationId, (transaction) => {
          transaction.setVirtualTime(scheduled.dueUs);
          return {
            value: undefined,
            primary: {
              kind: "clock",
              fromUs: current,
              toUs: scheduled.dueUs,
              reason: "scheduled_work",
            },
          };
        });
        evidence.push(...clock.evidence);
      }
      const failure = this.processScheduledEvent(scheduled.id);
      evidence.push(...failure.evidence);
      processed += 1;
      if (failure.error !== undefined) {
        failures.push({ scheduledEventId: scheduled.id, error: failure.error });
        break;
      }
      if (
        options.afterScheduledEvent?.({
          scheduledEventId: scheduled.id,
          virtualTimeUs: this.store.metadata().virtualTimeUs,
          processed,
        }) === false
      ) {
        stoppedEarly = true;
        break;
      }
    }

    const reachedBeforeFinalAdvance = this.store.metadata().virtualTimeUs;
    if (failures.length === 0 && !stoppedEarly && requestedUs > reachedBeforeFinalAdvance) {
      const clock = this.store.transact(correlationId, (transaction) => {
        transaction.setVirtualTime(requestedUs);
        return {
          value: undefined,
          primary: {
            kind: "clock",
            fromUs: reachedBeforeFinalAdvance,
            toUs: requestedUs,
            reason: "explicit",
          },
        };
      });
      evidence.push(...clock.evidence);
    }

    return {
      requestedUs,
      reachedUs: this.store.metadata().virtualTimeUs,
      scheduledEventsProcessed: processed,
      failures,
      evidence,
      stoppedEarly,
    };
  }

  private executeOperation(
    transaction: WorldTransaction,
    invocation: OperationInvocation,
    runtime: OperationRuntime,
  ): WorldTransactionResult<OperationOutcome> {
    const actor = transaction.getActor(invocation.actorBindingId);
    if (actor === null) {
      const outcome: OperationOutcome = {
        status: "denied",
        error: worldError(
          invocation.correlationId,
          "ACTOR_NOT_FOUND",
          `actor binding ${invocation.actorBindingId} is not present in this world`,
        ),
      };
      return {
        value: outcome,
        primary: {
          kind: "operation" as const,
          invocation,
          outcome,
          idempotency: unrecordedIdempotency(invocation),
        },
      };
    }
    if (!operationGranted(actor, invocation)) {
      const outcome: OperationOutcome = {
        status: "denied",
        error: worldError(
          invocation.correlationId,
          "OPERATION_DENIED",
          `actor ${actor.actorId} cannot call ${invocation.operation.packageId}.${invocation.operation.operationId}`,
        ),
      };
      return {
        value: outcome,
        primary: {
          kind: "operation" as const,
          invocation,
          outcome,
          idempotency: unrecordedIdempotency(invocation),
        },
      };
    }

    const hash = invocation.idempotencyKey === undefined ? undefined : requestHash(invocation);
    const receipt = transaction.getIdempotencyReceipt(invocation);
    if (receipt !== null) {
      if (receipt.requestHash !== hash) {
        const outcome: OperationOutcome = {
          status: "invalid",
          error: worldError(
            invocation.correlationId,
            "IDEMPOTENCY_CONFLICT",
            "the idempotency key was already used with different arguments",
          ),
        };
        return {
          value: outcome,
          primary: { kind: "operation" as const, invocation, outcome, idempotency: "not_recorded" as const },
        };
      }
      return {
        value: receipt.outcome,
        primary: {
          kind: "operation" as const,
          invocation,
          outcome: receipt.outcome,
          idempotency: "replayed" as const,
          replayedFromSequence: receipt.firstSequence,
        },
      };
    }

    const fault = this.activeFault(transaction, runtime.tool.manifest, runtime.contract.id);
    if (fault?.timing === "before") {
      const outcome: OperationOutcome = {
        status: "tool_error",
        error: toolError(invocation.correlationId, fault.error.code, fault.error.message, {
          retryable: fault.error.retryable,
        }),
      };
      transaction.appendEvidence({
        kind: "fault",
        packageId: runtime.tool.manifest.id,
        faultId: fault.id,
        operation: invocation.operation,
        timing: fault.timing,
        errorCode: fault.error.code,
      });
      return {
        value: outcome,
        primary: {
          kind: "operation" as const,
          invocation,
          outcome,
          idempotency: unrecordedIdempotency(invocation),
        },
      };
    }

    const queue: QueuedEvent[] = [];
    const budget: BudgetState = { stateMutations: 0, events: 0, randomDraws: 0 };
    const context = this.createContext(
      runtime.tool,
      actor,
      { kind: "operation", operationId: runtime.contract.id },
      invocation.correlationId,
      transaction,
      queue,
      budget,
    );
    let value: JsonValue;
    try {
      const candidate: unknown = runtime.handler(
        JsonObjectSchema.parse(JSON.parse(canonicalJson(invocation.arguments))),
        context,
      );
      if (isPromiseLike(candidate)) {
        throw new ExecutionAbort(
          worldError(
            invocation.correlationId,
            "ASYNC_TOOL_HANDLER",
            "Tool handlers must be synchronous because their effects share one SQLite transaction",
          ),
        );
      }
      const json = JsonValueSchema.safeParse(candidate);
      if (!json.success || !runtime.schemas.output(candidate)) {
        throw new ExecutionAbort(
          worldError(
            invocation.correlationId,
            "INVALID_TOOL_OUTPUT",
            `Tool handler returned a value outside the declared schema for ${invocation.operation.packageId}.${invocation.operation.operationId}`,
            { issues: ajvIssues(runtime.schemas.output.errors) },
          ),
        );
      }
      value = json.data;
      this.dispatchQueue(queue, actor, invocation.correlationId, transaction, budget);
    } catch (error) {
      if (error instanceof ExecutionAbort) throw error;
      if (isToolFailure(error)) {
        if (!runtime.contract.declaredErrors.includes(error.code)) {
          throw new ExecutionAbort(
            worldError(
              invocation.correlationId,
              "UNDECLARED_TOOL_ERROR",
              `Tool handler returned undeclared error ${error.code}`,
              { details: { packageId: runtime.tool.manifest.id, operationId: runtime.contract.id } },
            ),
          );
        }
        throw new ExecutionAbort(
          toolError(invocation.correlationId, error.code, error.message, {
            retryable: error.retryable,
            ...(error.details === undefined ? {} : { details: error.details }),
          }),
        );
      }
      throw new ExecutionAbort(
        worldError(invocation.correlationId, "TOOL_HANDLER_CRASH", "Tool handler threw unexpectedly", {
          details: errorDetails(error),
        }),
      );
    }

    let outcome: OperationOutcome = { status: "ok", value };
    if (fault?.timing === "after_commit") {
      outcome = {
        status: "tool_error",
        error: toolError(invocation.correlationId, fault.error.code, fault.error.message, {
          retryable: fault.error.retryable,
        }),
      };
      transaction.appendEvidence({
        kind: "fault",
        packageId: runtime.tool.manifest.id,
        faultId: fault.id,
        operation: invocation.operation,
        timing: fault.timing,
        errorCode: fault.error.code,
      });
    }
    outcome = OperationOutcomeSchema.parse(outcome);
    const idempotency: "not_requested" | "recorded" =
      invocation.idempotencyKey === undefined ? "not_requested" : "recorded";
    if (hash !== undefined) transaction.putIdempotencyReceipt(invocation, hash, outcome);
    return {
      value: outcome,
      primary: { kind: "operation" as const, invocation, outcome, idempotency },
    };
  }

  private createContext(
    tool: ToolDefinition,
    actor: StoredActor,
    source: ToolExecutionSource,
    correlationId: CorrelationId,
    transaction: WorldTransaction,
    queue: QueuedEvent[],
    budget: BudgetState,
  ): ToolContext {
    const packageId = tool.manifest.id;
    const capabilities = new Set(tool.manifest.capabilities);
    const namespaces = new Set(tool.manifest.state.map((state) => state.namespace));
    const declaredEvents = new Set(tool.manifest.events.map((event) => event.id));
    const requireCapability = (capability: ToolPackageManifest["capabilities"][number]) => {
      if (!capabilities.has(capability)) {
        throw new ExecutionAbort(
          worldError(
            correlationId,
            "CAPABILITY_NOT_DECLARED",
            `Tool package ${packageId} used undeclared capability ${capability}`,
          ),
        );
      }
    };
    const requireNamespace = (namespace: string): StateRuntime => {
      if (!namespaces.has(namespace)) {
        throw new ExecutionAbort(
          worldError(
            correlationId,
            "STATE_NAMESPACE_NOT_DECLARED",
            `Tool package ${packageId} used undeclared state namespace ${namespace}`,
          ),
        );
      }
      const runtime = this.state.get(operationKey(packageId, namespace));
      if (runtime === undefined) throw new TypeError(`state schema ${packageId}.${namespace} is unavailable`);
      return runtime;
    };
    const validateState = (namespace: string, rowId: string, value: JsonObject): JsonObject => {
      const normalized = JsonObjectSchema.parse(value);
      const runtime = requireNamespace(namespace);
      if (!runtime.validate(normalized)) {
        throw new ExecutionAbort(
          worldError(
            correlationId,
            "INVALID_STATE_VALUE",
            `state value does not match ${packageId}.${namespace}`,
            { issues: ajvIssues(runtime.validate.errors), details: { packageId, namespace, rowId } },
          ),
        );
      }
      return normalized;
    };
    const validateEvent = (eventId: string, payload: JsonObject): JsonObject => {
      requireCapability("event.emit");
      if (!declaredEvents.has(eventId)) {
        throw new ExecutionAbort(
          worldError(
            correlationId,
            "EVENT_NOT_DECLARED",
            `Tool package ${packageId} emitted undeclared event ${eventId}`,
          ),
        );
      }
      const normalized = JsonObjectSchema.parse(payload);
      const runtime = this.events.get(eventKey({ packageId, eventId }));
      if (runtime === undefined || !runtime.validate(normalized)) {
        throw new ExecutionAbort(
          worldError(
            correlationId,
            "INVALID_EVENT_PAYLOAD",
            `event payload does not match ${packageId}.${eventId}`,
            { issues: ajvIssues(runtime?.validate.errors) },
          ),
        );
      }
      return normalized;
    };
    const count = (field: keyof BudgetState, limit: number, label: string) => {
      budget[field] += 1;
      if (budget[field] > limit) {
        throw new ExecutionAbort(
          worldError(correlationId, `${label}_BUDGET_EXCEEDED`, `${label.toLowerCase()} budget exceeded`),
        );
      }
    };
    const draw = (): bigint => {
      requireCapability("random.draw");
      count("randomDraws", this.budgets.maxRandomDraws, "RANDOM_DRAW");
      return transaction.nextRandomU64(packageId);
    };
    const actorView: ToolActor = {
      id: actor.actorId,
      attributes: actor.attributes,
      grants: actor.grants,
    };
    const budgets = this.budgets;
    return {
      packageId,
      actor: actorView,
      source,
      fail(options) {
        if (source.kind !== "operation") {
          throw new ExecutionAbort(
            worldError(
              correlationId,
              "TOOL_FAILURE_OUTSIDE_OPERATION",
              "context.fail is available only while handling a Tool operation",
            ),
          );
        }
        throw new ToolFailure(options);
      },
      state: {
        get(namespace, rowId) {
          requireCapability("state.read");
          requireNamespace(namespace);
          const value = transaction.getState(packageId, namespace, rowId)?.value;
          return value === undefined ? null : validateState(namespace, rowId, value);
        },
        scan(namespace, options) {
          requireCapability("state.read");
          requireNamespace(namespace);
          return transaction.scanState(packageId, namespace, options).map((record) => ({
            rowId: record.rowId,
            value: validateState(namespace, record.rowId, record.value),
          }));
        },
        put(namespace, rowId, value) {
          requireCapability("state.write");
          requireNamespace(namespace);
          count("stateMutations", budgets.maxStateMutations, "STATE_MUTATION");
          transaction.putState(packageId, namespace, rowId, validateState(namespace, rowId, value));
        },
        delete(namespace, rowId) {
          requireCapability("state.write");
          requireNamespace(namespace);
          count("stateMutations", budgets.maxStateMutations, "STATE_MUTATION");
          return transaction.deleteState(packageId, namespace, rowId);
        },
      },
      clock: {
        nowUs() {
          requireCapability("clock.read");
          return transaction.virtualTimeUs;
        },
      },
      random: {
        nextU64: draw,
        nextFloat() {
          return Number(draw() >> 11n) / 9_007_199_254_740_992;
        },
        nextInteger(minInclusive, maxExclusive) {
          if (
            !Number.isSafeInteger(minInclusive) ||
            !Number.isSafeInteger(maxExclusive) ||
            maxExclusive <= minInclusive
          ) {
            throw new RangeError("random integer bounds must be safe integers with max greater than min");
          }
          const range = BigInt(maxExclusive - minInclusive);
          const ceiling = UINT64_SPACE - (UINT64_SPACE % range);
          let value = draw();
          while (value >= ceiling) value = draw();
          return minInclusive + Number(value % range);
        },
      },
      events: {
        emit: (eventId, payload) => {
          count("events", this.budgets.maxEvents, "EVENT");
          const normalized = validateEvent(eventId, payload);
          const event = { packageId, eventId };
          transaction.appendEvidence({ kind: "event", event, phase: "emitted", payload: normalized });
          queue.push({ event, payload: normalized });
        },
        scheduleAt: (eventId, payload, virtualTimeUs) => {
          requireCapability("clock.schedule");
          count("events", this.budgets.maxEvents, "EVENT");
          const dueUs = VirtualTimeSchema.parse(virtualTimeUs);
          if (dueUs <= transaction.virtualTimeUs) {
            throw new ExecutionAbort(
              worldError(
                correlationId,
                "INVALID_EVENT_SCHEDULE",
                "scheduled events must be in the future; use emit for immediate events",
              ),
            );
          }
          const normalized = validateEvent(eventId, payload);
          transaction.scheduleEvent({ packageId, eventId }, normalized, dueUs, actor.bindingId);
        },
      },
    };
  }

  private dispatchQueue(
    queue: QueuedEvent[],
    actor: StoredActor,
    correlationId: CorrelationId,
    transaction: WorldTransaction,
    budget: BudgetState,
  ): void {
    let index = 0;
    while (index < queue.length) {
      const queued = queue[index];
      index += 1;
      if (queued === undefined) continue;
      for (const subscription of this.subscriptions.get(eventKey(queued.event)) ?? []) {
        const context = this.createContext(
          subscription.tool,
          actor,
          { kind: "subscription", subscriptionId: subscription.subscriptionId, event: queued.event },
          correlationId,
          transaction,
          queue,
          budget,
        );
        try {
          const result: unknown = subscription.handler(queued.payload, context);
          if (isPromiseLike(result)) {
            throw new Error("subscription handlers must be synchronous");
          }
        } catch (error) {
          if (error instanceof ExecutionAbort) {
            throw new ExecutionAbort(error.envelope, {
              event: queued.event,
              payload: queued.payload,
              handlerPackageId: subscription.tool.manifest.id,
              subscriptionId: subscription.subscriptionId,
            });
          }
          throw new ExecutionAbort(
            worldError(correlationId, "SUBSCRIPTION_FAILED", "Tool event subscription failed", {
              details: {
                packageId: subscription.tool.manifest.id,
                subscriptionId: subscription.subscriptionId,
                ...errorDetails(error),
              },
            }),
            {
              event: queued.event,
              payload: queued.payload,
              handlerPackageId: subscription.tool.manifest.id,
              subscriptionId: subscription.subscriptionId,
            },
          );
        }
        transaction.appendEvidence({
          kind: "event",
          event: queued.event,
          phase: "handled",
          payload: queued.payload,
          handlerPackageId: subscription.tool.manifest.id,
          subscriptionId: subscription.subscriptionId,
        });
      }
    }
  }

  private processScheduledEvent(scheduledEventId: ScheduledEventFailure["scheduledEventId"]): {
    readonly evidence: readonly EvidenceEntry[];
    readonly error?: ErrorEnvelope;
  } {
    const scheduled = this.store
      .listScheduledEvents("pending")
      .find((event) => event.id === scheduledEventId);
    if (scheduled === undefined) throw new Error(`pending scheduled event ${scheduledEventId} disappeared`);
    try {
      const committed = this.store.transact(scheduled.correlationId, (transaction) => {
        const claimed = transaction.claimScheduledEvent(scheduled.id, "fired");
        const actor = transaction.getActor(claimed.actorBindingId);
        if (actor === null) {
          throw new ExecutionAbort(
            worldError(
              claimed.correlationId,
              "ACTOR_NOT_FOUND",
              `scheduled event actor binding ${claimed.actorBindingId} is missing`,
            ),
            { event: claimed.event, payload: claimed.payload },
          );
        }
        const runtime = this.events.get(eventKey(claimed.event));
        if (runtime === undefined || !runtime.validate(claimed.payload)) {
          throw new ExecutionAbort(
            worldError(
              claimed.correlationId,
              "INVALID_EVENT_PAYLOAD",
              `stored event payload does not match ${claimed.event.packageId}.${claimed.event.eventId}`,
            ),
            { event: claimed.event, payload: claimed.payload },
          );
        }
        const budget: BudgetState = { stateMutations: 0, events: 1, randomDraws: 0 };
        const queue: QueuedEvent[] = [{ event: claimed.event, payload: claimed.payload }];
        this.dispatchQueue(queue, actor, claimed.correlationId, transaction, budget);
        return {
          value: undefined,
          primary: {
            kind: "event" as const,
            event: claimed.event,
            phase: "emitted" as const,
            payload: claimed.payload,
            scheduledEventId: claimed.id,
            scheduledForUs: claimed.dueUs,
            causeSequence: claimed.causeSequence,
          },
        };
      });
      return { evidence: committed.evidence };
    } catch (error) {
      if (!(error instanceof ExecutionAbort)) throw error;
      const failed = this.store.transact(scheduled.correlationId, (transaction) => {
        const claimed = transaction.claimScheduledEvent(scheduled.id, "failed");
        return {
          value: undefined,
          primary: {
            kind: "event" as const,
            event: claimed.event,
            phase: "failed" as const,
            payload: claimed.payload,
            scheduledEventId: claimed.id,
            scheduledForUs: claimed.dueUs,
            causeSequence: claimed.causeSequence,
            ...(error.failedEvent?.handlerPackageId === undefined
              ? {}
              : { handlerPackageId: error.failedEvent.handlerPackageId }),
            ...(error.failedEvent?.subscriptionId === undefined
              ? {}
              : { subscriptionId: error.failedEvent.subscriptionId }),
          },
        };
      });
      return { evidence: failed.evidence, error: error.envelope };
    }
  }

  private activeFault(
    transaction: WorldTransaction,
    manifest: ToolPackageManifest,
    operationId: string,
  ): ToolPackageManifest["faults"][number] | undefined {
    const active = new Set(transaction.activeFaultIds(manifest.id));
    return manifest.faults
      .filter((fault) => active.has(fault.id) && fault.appliesTo.includes(operationId))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
  }

  private validateIdempotencyContract(
    invocation: OperationInvocation,
    contract: OperationContract,
  ): ErrorEnvelope | undefined {
    if (contract.idempotency === "required" && invocation.idempotencyKey === undefined) {
      return frameworkError(
        invocation.correlationId,
        "IDEMPOTENCY_REQUIRED",
        `${invocation.operation.packageId}.${invocation.operation.operationId} requires an idempotency key`,
      );
    }
    if (contract.idempotency === "none" && invocation.idempotencyKey !== undefined) {
      return frameworkError(
        invocation.correlationId,
        "IDEMPOTENCY_NOT_SUPPORTED",
        `${invocation.operation.packageId}.${invocation.operation.operationId} does not accept an idempotency key`,
      );
    }
    return undefined;
  }

  private recordOutcome(
    invocation: OperationInvocation,
    outcome: OperationOutcome,
    idempotency?: "not_requested" | "recorded" | "replayed" | "not_recorded",
    secondary: readonly EvidenceDraft[] = [],
  ): KernelInvocationResult {
    const parsedOutcome = OperationOutcomeSchema.parse(outcome);
    const committed = this.store.transact(invocation.correlationId, (transaction) => {
      for (const draft of secondary) transaction.appendEvidence(draft);
      return {
        value: parsedOutcome,
        primary: {
          kind: "operation",
          invocation,
          outcome: parsedOutcome,
          idempotency: idempotency ?? unrecordedIdempotency(invocation),
        },
      };
    });
    return { invocation, outcome: committed.value, evidence: committed.evidence };
  }
}
