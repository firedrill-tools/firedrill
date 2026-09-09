import type {
  ActorBindingId,
  ActorId,
  AssertionResult,
  CallbackDeliveryId,
  CallbackErrorEvidence,
  CallbackRef,
  CallbackRequestEvidence,
  CallbackResponseEvidence,
  CorrelationId,
  ErrorEnvelope,
  EventRef,
  EvidenceEntry,
  JsonObject,
  OperationInvocation,
  OperationOutcome,
  OperationRef,
  PackageId,
  ScheduledEventId,
  Seed,
  Sha256,
  SnapshotId,
  StableId,
  ToolOverrideEvidence,
  VirtualTime,
  WorldInstanceId,
} from "@firedrill/contracts";

export interface WorldMetadata {
  readonly schemaVersion: 1;
  readonly worldInstanceId: WorldInstanceId;
  readonly buildHash: Sha256;
  readonly packageLockHash: Sha256;
  readonly seed: Seed;
  readonly virtualTimeUs: VirtualTime;
  readonly randomState: string;
  readonly randomDraws: number;
  readonly parentWorldInstanceId?: WorldInstanceId;
  readonly parentSnapshotId?: SnapshotId;
}

export interface StoredActor {
  readonly bindingId: ActorBindingId;
  readonly actorId: ActorId;
  readonly attributes: Readonly<JsonObject>;
  readonly grants: readonly OperationRef[];
}

export interface StoredStateRecord {
  readonly packageId: PackageId;
  readonly namespace: StableId;
  readonly rowId: string;
  readonly value: Readonly<JsonObject>;
}

export interface StateScanOptions {
  readonly afterRowId?: string;
  readonly limit?: number;
}

export interface StateNamespaceSummary {
  readonly packageId: PackageId;
  readonly namespace: StableId;
  readonly records: number;
}

export interface ActiveFault {
  readonly packageId: PackageId;
  readonly faultId: StableId;
}

export interface ScheduledEvent {
  readonly id: ScheduledEventId;
  readonly event: EventRef;
  readonly payload: Readonly<JsonObject>;
  readonly dueUs: VirtualTime;
  readonly correlationId: CorrelationId;
  readonly actorBindingId: ActorBindingId;
  readonly causeSequence: number;
  readonly status: "pending" | "fired" | "failed" | "cancelled";
}

export interface CallbackDelivery {
  readonly id: CallbackDeliveryId;
  readonly callback: CallbackRef;
  readonly receiverId: StableId;
  readonly event: EventRef;
  readonly payload: Readonly<JsonObject>;
  readonly eventSequence: number;
  readonly dueUs: VirtualTime;
  readonly correlationId: CorrelationId;
  readonly actorBindingId: ActorBindingId;
  readonly status: "pending" | "in_flight" | "delivered" | "failed";
  readonly attemptCount: number;
  readonly retryDelaysUs: readonly VirtualTime[];
}

type CallbackAttemptFailure =
  | {
      readonly response: CallbackResponseEvidence;
      readonly error?: CallbackErrorEvidence;
    }
  | {
      readonly response?: CallbackResponseEvidence;
      readonly error: CallbackErrorEvidence;
    };

export type CallbackAttemptSettlement =
  | {
      readonly status: "delivered";
      readonly attempt: number;
      readonly response: CallbackResponseEvidence;
      readonly durationMs: number;
    }
  | ({
      readonly status: "retry_scheduled";
      readonly attempt: number;
      readonly nextAttemptUs: VirtualTime;
      readonly durationMs: number;
    } & CallbackAttemptFailure)
  | ({
      readonly status: "failed";
      readonly attempt: number;
      readonly durationMs: number;
    } & CallbackAttemptFailure);

export interface IdempotencyReceipt {
  readonly requestHash: string;
  readonly outcome: OperationOutcome;
  readonly firstSequence: number;
}

export type EvidenceDraft =
  | {
      readonly kind: "operation";
      readonly invocation: OperationInvocation;
      readonly actorId?: ActorId;
      readonly outcome: OperationOutcome;
      readonly idempotency: "not_requested" | "recorded" | "replayed" | "not_recorded";
      readonly replayedFromSequence?: number;
      readonly toolOverride?: ToolOverrideEvidence;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "event";
      readonly event: EventRef;
      readonly phase: "emitted" | "scheduled" | "handled" | "failed";
      readonly payload: JsonObject;
      readonly scheduledEventId?: ScheduledEventId;
      readonly scheduledForUs?: VirtualTime;
      readonly handlerPackageId?: PackageId;
      readonly subscriptionId?: StableId;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "callback";
      readonly callback: CallbackRef;
      readonly deliveryId: CallbackDeliveryId;
      readonly receiverId: StableId;
      readonly event: EventRef;
      readonly phase: "queued" | "attempt_started" | "delivered" | "retry_scheduled" | "failed" | "recovered";
      readonly attempt?: number;
      readonly idempotencyKey: string;
      readonly scheduledForUs?: VirtualTime;
      readonly request?: CallbackRequestEvidence;
      readonly response?: CallbackResponseEvidence;
      readonly error?: CallbackErrorEvidence;
      readonly durationMs?: number;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "fault";
      readonly packageId: PackageId;
      readonly faultId: StableId;
      readonly operation: OperationRef;
      readonly timing: "before" | "after_commit";
      readonly errorCode: string;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "fault_control";
      readonly packageId: PackageId;
      readonly faultId: StableId;
      readonly previouslyActive: boolean;
      readonly active: boolean;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "clock";
      readonly fromUs: VirtualTime;
      readonly toUs: VirtualTime;
      readonly reason: "scenario" | "explicit" | "scheduled_work" | "reset";
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "verification";
      readonly checkpointId: StableId;
      readonly checkpointKind: "after_interaction" | "after_event" | "horizon" | "final";
      readonly interactionId?: StableId;
      readonly result: AssertionResult;
      readonly causeSequence?: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly action: "world_created" | "snapshot_created" | "world_reset" | "world_forked" | "world_closed";
      readonly worldInstanceId: WorldMetadata["worldInstanceId"];
      readonly snapshotId?: SnapshotId;
      readonly actorBindingId?: ActorBindingId;
      readonly details?: JsonObject;
      readonly causeSequence?: number;
    };

export interface CallbackTransition {
  readonly delivery: CallbackDelivery;
  readonly evidence: Extract<EvidenceDraft, { readonly kind: "callback" }>;
}

export interface WorldTransaction {
  readonly primarySequence: number;
  readonly virtualTimeUs: VirtualTime;
  /** Roll back only this synchronous block's SQL changes and buffered evidence on failure. */
  withSavepoint<T>(execute: () => T): T;
  /** Controller-owned usage, separate from Tool-readable state. */
  toolOverrideMatchCount(packageId: PackageId, overrideId: StableId): number;
  consumeToolOverride(packageId: PackageId, overrideId: StableId): number;
  getActor(bindingId: ActorBindingId): StoredActor | null;
  getState(packageId: PackageId, namespace: StableId, rowId: string): StoredStateRecord | null;
  scanState(
    packageId: PackageId,
    namespace: StableId,
    options?: StateScanOptions,
  ): readonly StoredStateRecord[];
  putState(packageId: PackageId, namespace: StableId, rowId: string, value: JsonObject): void;
  deleteState(packageId: PackageId, namespace: StableId, rowId: string): boolean;
  nextRandomU64(packageId: PackageId): bigint;
  activeFaultIds(packageId: PackageId): readonly StableId[];
  /** Controller-only mutation. The kernel validates declaration ownership first. Returns prior state. */
  setFaultActive(packageId: PackageId, faultId: StableId, active: boolean): boolean;
  getIdempotencyReceipt(invocation: OperationInvocation): IdempotencyReceipt | null;
  putIdempotencyReceipt(
    invocation: OperationInvocation,
    requestHash: string,
    outcome: OperationOutcome,
  ): void;
  appendEvidence(draft: EvidenceDraft): number;
  scheduleEvent(
    event: EventRef,
    payload: JsonObject,
    dueUs: VirtualTime,
    actorBindingId: ActorBindingId,
  ): ScheduledEventId;
  setVirtualTime(toUs: VirtualTime): void;
  claimScheduledEvent(id: ScheduledEventId, status: "fired" | "failed"): ScheduledEvent;
  enqueueCallback(input: {
    readonly callback: CallbackRef;
    readonly receiverId: StableId;
    readonly event: EventRef;
    readonly payload: JsonObject;
    readonly eventSequence: number;
    readonly dueUs: VirtualTime;
    readonly actorBindingId: ActorBindingId;
    readonly retryDelaysUs: readonly VirtualTime[];
  }): CallbackDeliveryId;
  startCallbackAttempt(id: CallbackDeliveryId, request: CallbackRequestEvidence): CallbackTransition;
  failCallbackDelivery(id: CallbackDeliveryId, error: CallbackErrorEvidence): CallbackTransition;
  settleCallbackAttempt(id: CallbackDeliveryId, settlement: CallbackAttemptSettlement): CallbackTransition;
  recoverCallbackAttempt(id: CallbackDeliveryId): CallbackTransition;
}

export interface WorldTransactionResult<T> {
  readonly value: T;
  readonly primary: EvidenceDraft;
}

export interface CommittedWorldTransaction<T> {
  readonly value: T;
  readonly evidence: readonly EvidenceEntry[];
}

export interface WorldReader {
  readonly filePath: string;
  metadata(): WorldMetadata;
  listActiveFaults(packageId?: PackageId): readonly ActiveFault[];
  readState(packageId: PackageId, namespace: StableId, rowId: string): StoredStateRecord | null;
  listStateNamespaces(): readonly StateNamespaceSummary[];
  scanState(
    packageId: PackageId,
    namespace: StableId,
    options?: StateScanOptions,
  ): readonly StoredStateRecord[];
  /** Omit kinds for the journal head; an empty filter returns zero. Filtering reads only indexed heads. */
  latestEvidenceSequence(kinds?: readonly EvidenceEntry["kind"][]): number;
  readEvidence(fromSequence?: number, limit?: number): readonly EvidenceEntry[];
  listScheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[];
  listCallbackDeliveries(status?: CallbackDelivery["status"]): readonly CallbackDelivery[];
  close(): void;
}

export interface WorldStore extends WorldReader {
  transact<T>(
    correlationId: CorrelationId,
    execute: (transaction: WorldTransaction) => WorldTransactionResult<T>,
  ): CommittedWorldTransaction<T>;
  nextScheduledEvent(atOrBeforeUs?: VirtualTime): ScheduledEvent | null;
  nextCallbackDelivery(atOrBeforeUs?: VirtualTime): CallbackDelivery | null;
  stateHash(): string;
  evidenceHash(): string;
  createSnapshot(destinationPath: string, correlationId: CorrelationId): SnapshotId;
  resetFromSnapshot(sourcePath: string, correlationId: CorrelationId): void;
  resetPackagesFromSnapshot(
    sourcePath: string,
    packageIds: readonly PackageId[],
    correlationId: CorrelationId,
  ): PackageResetSummary;
}

export interface PackageResetSummary {
  readonly packages: readonly PackageId[];
  readonly stateChanges: number;
  readonly activeFaultsRestored: number;
  readonly scheduledEventsRestored: number;
  readonly callbacksRestored: number;
  readonly idempotencyReceiptsRestored: number;
}

export interface WorldStoreFailure {
  readonly error: ErrorEnvelope;
}
