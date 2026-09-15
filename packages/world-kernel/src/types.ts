import type {
  CorrelationId,
  ErrorEnvelope,
  EvidenceEntry,
  OperationInvocation,
  OperationOutcome,
  PackageId,
  ResolvedToolOverride,
  ScheduledEventId,
  Sha256,
  StableId,
  VirtualTime,
} from "@firedrill/contracts";
import type { ToolDefinition } from "@firedrill/tool-sdk";
import type { WorldStore } from "@firedrill/world-store";

export interface WorldKernelBudgets {
  readonly maxToolCalls: number;
  readonly maxStateMutations: number;
  readonly maxEvents: number;
  readonly maxRandomDraws: number;
}

export interface WorldKernelUsage {
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly toolCallBudgetExceeded: boolean;
}

export interface WorldKernelOptions {
  readonly store: WorldStore;
  readonly packageLockHash: Sha256;
  readonly tools: readonly ToolDefinition[];
  readonly toolOverrides?: readonly ResolvedToolOverride[];
  readonly budgets?: Partial<WorldKernelBudgets>;
  /** Called once, after the first rejected over-budget call is durably recorded. */
  readonly onToolCallBudgetExceeded?: (usage: WorldKernelUsage) => void;
}

export interface KernelInvocationResult {
  readonly invocation: OperationInvocation;
  readonly outcome: OperationOutcome;
  readonly evidence: readonly EvidenceEntry[];
}

export interface FaultControlInput {
  readonly packageId: PackageId;
  readonly faultId: StableId;
  readonly active: boolean;
}

export interface FaultControlResult extends FaultControlInput {
  readonly previouslyActive: boolean;
  readonly changed: boolean;
  readonly evidence: readonly EvidenceEntry[];
}

export interface ScheduledEventFailure {
  readonly scheduledEventId: ScheduledEventId;
  readonly error: ErrorEnvelope;
}

export interface ClockAdvanceResult {
  readonly requestedUs: VirtualTime;
  readonly reachedUs: VirtualTime;
  readonly scheduledEventsProcessed: number;
  readonly failures: readonly ScheduledEventFailure[];
  readonly evidence: readonly EvidenceEntry[];
  readonly stoppedEarly: boolean;
}

export interface AdvanceTimeOptions {
  readonly correlationId: CorrelationId;
  readonly maxEvents?: number;
  /** Return false to stop after the current scheduled event without advancing farther. */
  readonly afterScheduledEvent?: (checkpoint: {
    readonly scheduledEventId: ScheduledEventId;
    readonly virtualTimeUs: VirtualTime;
    readonly processed: number;
  }) => boolean;
}
