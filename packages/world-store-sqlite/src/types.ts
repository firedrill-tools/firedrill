import type {
  ActorBindingId,
  ActorId,
  CorrelationId,
  EventRef,
  JsonObject,
  OperationRef,
  PackageId,
  Seed,
  Sha256,
  SnapshotId,
  StableId,
  VirtualTime,
  WorldInstanceId,
} from "@firedrill-run/contracts";

export interface InitialActor {
  readonly bindingId: ActorBindingId;
  readonly actorId: ActorId;
  readonly attributes?: JsonObject;
  readonly grants: readonly OperationRef[];
}

export interface InitialStateRecord {
  readonly packageId: PackageId;
  readonly namespace: StableId;
  readonly rowId: string;
  readonly value: JsonObject;
}

export interface InitialFault {
  readonly packageId: PackageId;
  readonly faultId: StableId;
}

export interface InitialScheduledEvent {
  readonly event: EventRef;
  readonly payload: JsonObject;
  readonly dueUs: VirtualTime;
  readonly actorBindingId: ActorBindingId;
}

export interface CreateSqliteWorldOptions {
  readonly filePath: string;
  readonly worldInstanceId: WorldInstanceId;
  readonly buildHash: Sha256;
  readonly packageLockHash: Sha256;
  readonly seed: Seed;
  readonly virtualTimeUs: VirtualTime;
  readonly correlationId: CorrelationId;
  readonly actors?: readonly InitialActor[];
  readonly state?: readonly InitialStateRecord[];
  readonly activeFaults?: readonly InitialFault[];
  readonly scheduledEvents?: readonly InitialScheduledEvent[];
}

export interface ForkSqliteWorldOptions {
  readonly snapshotPath: string;
  readonly destinationPath: string;
  readonly snapshotId: SnapshotId;
  readonly worldInstanceId: WorldInstanceId;
  readonly correlationId: CorrelationId;
}
