import type {
  ActorBindingId,
  ActorId,
  AssertionResult,
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
      readonly kind: "fault";
      readonly packageId: PackageId;
      readonly faultId: StableId;
      readonly operation: OperationRef;
      readonly timing: "before" | "after_commit";
      readonly errorCode: string;
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

export interface WorldTransaction {
  readonly primarySequence: number;
  readonly virtualTimeUs: VirtualTime;
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
  getIdempotencyReceipt(invocation: OperationInvocation): IdempotencyReceipt | null;
  putIdempotencyReceipt(
    invocation: OperationInvocation,
    requestHash: string,
    outcome: OperationOutcome,
  ): void;
  appendEvidence(draft: EvidenceDraft): void;
  scheduleEvent(
    event: EventRef,
    payload: JsonObject,
    dueUs: VirtualTime,
    actorBindingId: ActorBindingId,
  ): ScheduledEventId;
  setVirtualTime(toUs: VirtualTime): void;
  claimScheduledEvent(id: ScheduledEventId, status: "fired" | "failed"): ScheduledEvent;
}

export interface WorldTransactionResult<T> {
  readonly value: T;
  readonly primary: EvidenceDraft;
}

export interface CommittedWorldTransaction<T> {
  readonly value: T;
  readonly evidence: readonly EvidenceEntry[];
}

export interface WorldStore {
  readonly filePath: string;
  metadata(): WorldMetadata;
  transact<T>(
    correlationId: CorrelationId,
    execute: (transaction: WorldTransaction) => WorldTransactionResult<T>,
  ): CommittedWorldTransaction<T>;
  readState(packageId: PackageId, namespace: StableId, rowId: string): StoredStateRecord | null;
  scanState(
    packageId: PackageId,
    namespace: StableId,
    options?: StateScanOptions,
  ): readonly StoredStateRecord[];
  readEvidence(fromSequence?: number, limit?: number): readonly EvidenceEntry[];
  nextScheduledEvent(atOrBeforeUs?: VirtualTime): ScheduledEvent | null;
  listScheduledEvents(status?: ScheduledEvent["status"]): readonly ScheduledEvent[];
  stateHash(): string;
  evidenceHash(): string;
  createSnapshot(destinationPath: string, correlationId: CorrelationId): SnapshotId;
  resetFromSnapshot(sourcePath: string, correlationId: CorrelationId): void;
  close(): void;
}

export interface WorldStoreFailure {
  readonly error: ErrorEnvelope;
}
