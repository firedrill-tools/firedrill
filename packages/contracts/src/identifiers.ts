import { z } from "zod";

const SEGMENT = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const OPERATION_PATH = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/;
const NODE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const StableIdSchema = z.string().min(1).max(96).regex(SEGMENT);
export const PackageIdSchema = StableIdSchema;
/** An installable npm-compatible package name, including optional scope. */
export const NodePackageNameSchema = z.string().min(1).max(214).regex(NODE_PACKAGE_NAME);
export const OperationIdSchema = z.string().min(1).max(160).regex(OPERATION_PATH);
export const EventIdSchema = z.string().min(1).max(160).regex(OPERATION_PATH);
export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const SeedSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn, "seed exceeds unsigned 64-bit range");
export const VirtualTimeSchema = z.number().int().nonnegative().safe();

function executionId(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{5,95}$`));
}

export const RunIdSchema = executionId("run");
export const CallIdSchema = executionId("call");
export const TransactionIdSchema = executionId("txn");
export const WorldInstanceIdSchema = executionId("world");
export const SnapshotIdSchema = executionId("snap");
export const ScheduledEventIdSchema = executionId("pending");
export const CorrelationIdSchema = executionId("corr");
export const ActorBindingIdSchema = executionId("actor");
export const ActorIdSchema = StableIdSchema;

export const OperationRefSchema = z
  .object({
    packageId: PackageIdSchema,
    operationId: OperationIdSchema,
  })
  .strict();

export const EventRefSchema = z
  .object({
    packageId: PackageIdSchema,
    eventId: EventIdSchema,
  })
  .strict();

export type StableId = z.infer<typeof StableIdSchema>;
export type PackageId = z.infer<typeof PackageIdSchema>;
export type NodePackageName = z.infer<typeof NodePackageNameSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type Seed = z.infer<typeof SeedSchema>;
export type VirtualTime = z.infer<typeof VirtualTimeSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type CallId = z.infer<typeof CallIdSchema>;
export type TransactionId = z.infer<typeof TransactionIdSchema>;
export type WorldInstanceId = z.infer<typeof WorldInstanceIdSchema>;
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;
export type ScheduledEventId = z.infer<typeof ScheduledEventIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type ActorBindingId = z.infer<typeof ActorBindingIdSchema>;
export type ActorId = z.infer<typeof ActorIdSchema>;
export type OperationRef = z.infer<typeof OperationRefSchema>;
export type EventRef = z.infer<typeof EventRefSchema>;
