import { VirtualTimeSchema } from "@firedrill/contracts";
import type { CorrelationId } from "@firedrill/contracts";
import type {
  AdvanceTimeOptions,
  ClockAdvanceResult,
  ScheduledEventFailure,
  WorldKernel,
} from "@firedrill/world-kernel";
import type { WorldStore } from "@firedrill/world-store";

export interface DrillCallbackSettlement {
  /** Delivers all callback work due at the world's current virtual time. */
  flush(signal?: AbortSignal): Promise<void>;
  /** Returns the next callback retry/delivery time, or null when none is pending. */
  nextDueUs(): number | null;
}

export type VirtualTimeSettlementCheckpoint = Parameters<
  NonNullable<AdvanceTimeOptions["afterScheduledEvent"]>
>[0];

export interface VirtualTimeSettlementOptions {
  readonly store: WorldStore;
  readonly kernel: WorldKernel;
  readonly callbacks: DrillCallbackSettlement;
  readonly targetUs: number;
  /** Remaining scheduled-event budget for this entire settlement, including every retry deadline. */
  readonly maxEvents: number;
  readonly correlationId: (progress: {
    readonly step: number;
    readonly processedEvents: number;
    readonly currentUs: number;
    readonly targetUs: number;
  }) => CorrelationId;
  /** Runs after each committed successful event. `processed` is cumulative within this settlement. */
  readonly afterScheduledEvent?:
    | ((checkpoint: VirtualTimeSettlementCheckpoint) => boolean)
    | ((checkpoint: VirtualTimeSettlementCheckpoint) => void);
  readonly signal?: AbortSignal;
}

interface VirtualTimeSettlementProgress {
  readonly requestedUs: number;
  readonly reachedUs: number;
  readonly scheduledEventsProcessed: number;
  readonly eventBudgetExhausted: boolean;
}

export type VirtualTimeSettlementResult = VirtualTimeSettlementProgress &
  (
    | { readonly status: "completed" | "stopped" }
    | { readonly status: "aborted"; readonly reason: unknown }
    | {
        readonly status: "failed";
        readonly reason: "scheduled_event" | "callback" | "observer" | "kernel" | "no_progress";
        /** An in-process diagnostic, not a serializable or safe-to-publish error envelope. */
        readonly error: unknown;
        readonly failure?: ScheduledEventFailure;
      }
  );

/**
 * Settles one bounded world-clock interval, delivering callbacks before moving
 * beyond their due time. Invalid inputs throw before work starts; execution
 * failures and cancellation return the committed progress, without rollback.
 * The caller owns serialization of world access and any longer-lived budget.
 */
export async function settleVirtualTime(
  options: VirtualTimeSettlementOptions,
): Promise<VirtualTimeSettlementResult> {
  const requestedUs = VirtualTimeSchema.parse(options.targetUs);
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 0) {
    throw new RangeError("maxEvents must be a non-negative safe integer");
  }
  if (options.kernel.store !== options.store) throw new TypeError("kernel and settlement must share a store");
  if (requestedUs < options.store.metadata().virtualTimeUs) {
    throw new RangeError("virtual clock cannot move backward");
  }
  let processedEvents = 0;
  let step = 0;
  let stopped = false;
  const progress = (): VirtualTimeSettlementProgress => ({
    requestedUs,
    reachedUs: options.store.metadata().virtualTimeUs,
    scheduledEventsProcessed: processedEvents,
    eventBudgetExhausted: false,
  });
  const aborted = (): VirtualTimeSettlementResult => ({
    ...progress(),
    status: "aborted",
    reason: options.signal?.reason,
  });
  const failed = (
    reason: Extract<VirtualTimeSettlementResult, { status: "failed" }>["reason"],
    error: unknown,
  ): VirtualTimeSettlementResult => ({ ...progress(), status: "failed", reason, error });
  const nextDueUs = (): number | null => {
    const dueUs = options.callbacks.nextDueUs();
    return dueUs === null ? null : VirtualTimeSchema.parse(dueUs);
  };

  for (;;) {
    if (options.signal?.aborted) return aborted();
    try {
      await options.callbacks.flush(options.signal);
    } catch (error) {
      return options.signal?.aborted ? aborted() : failed("callback", error);
    }
    if (options.signal?.aborted) return aborted();
    const currentUs = options.store.metadata().virtualTimeUs;
    let callbackDueUs: number | null;
    try {
      callbackDueUs = nextDueUs();
    } catch (error) {
      return failed("callback", error);
    }
    if (options.signal?.aborted) return aborted();
    if (callbackDueUs !== null && callbackDueUs <= currentUs) {
      return failed("no_progress", new Error("callback flush left delivery work due at the current time"));
    }
    if (stopped) return { ...progress(), status: "stopped" };
    // An equal-time request still settles events already due at that instant.
    if (currentUs >= requestedUs && options.store.nextScheduledEvent(requestedUs) === null) {
      return { ...progress(), status: "completed" };
    }
    const stepUs = callbackDueUs !== null && callbackDueUs < requestedUs ? callbackDueUs : requestedUs;
    const before = processedEvents;
    let stoppedForCallback = false;
    let observerFailure: { readonly reason: "observer" | "callback"; readonly error: unknown } | undefined;
    let advanced: ClockAdvanceResult;
    try {
      const correlationId = options.correlationId({
        step: ++step,
        processedEvents,
        currentUs,
        targetUs: stepUs,
      });
      if (options.signal?.aborted) return aborted();
      advanced = options.kernel.advanceTime(stepUs, {
        correlationId,
        maxEvents: options.maxEvents - before,
        afterScheduledEvent: (checkpoint) => {
          processedEvents = before + checkpoint.processed;
          try {
            const observed = options.afterScheduledEvent?.({ ...checkpoint, processed: processedEvents });
            if (observed !== undefined && typeof observed !== "boolean") {
              throw new TypeError("scheduled-event observers must synchronously return boolean or undefined");
            }
            stopped = observed === false;
          } catch (error) {
            observerFailure = { reason: "observer", error };
            return false;
          }
          if (stopped || options.signal?.aborted) return false;
          try {
            const dueUs = nextDueUs();
            stoppedForCallback = dueUs !== null && dueUs <= options.store.metadata().virtualTimeUs;
          } catch (error) {
            observerFailure = { reason: "callback", error };
            return false;
          }
          return !stoppedForCallback && !options.signal?.aborted;
        },
      });
    } catch (error) {
      return failed("kernel", error);
    }
    processedEvents = before + advanced.scheduledEventsProcessed;
    const failure = advanced.failures[0];
    if (failure !== undefined) {
      return {
        ...progress(),
        status: "failed",
        reason: "scheduled_event",
        error: failure.error,
        failure,
        eventBudgetExhausted: failure.error.code === "world.EVENT_BUDGET_EXCEEDED",
      };
    }
    if (observerFailure !== undefined) return failed(observerFailure.reason, observerFailure.error);
    if (options.signal?.aborted) return aborted();
    if (
      !stopped &&
      ((advanced.reachedUs <= currentUs && processedEvents === before) ||
        (advanced.reachedUs < stepUs && !stoppedForCallback))
    ) {
      return failed(
        "no_progress",
        new Error("world clock did not reach its requested time or expose pending callback work"),
      );
    }
  }
}
