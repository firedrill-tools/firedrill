import type {
  AssertionResult,
  CheckpointResult,
  ErrorEnvelope,
  EvidenceEntry,
  InteractionResult,
  OperationOutcome,
  Sha256,
  TargetResult,
} from "@firedrill/contracts";
import { semanticHash } from "./hash.js";

export interface TrajectoryHashInput {
  readonly interactions: readonly InteractionResult[];
  readonly checkpoints: readonly CheckpointResult[];
  readonly evidence: readonly EvidenceEntry[];
}

type EvidenceSequenceMap = ReadonlyMap<number, number>;
type OpaqueIdentityMap = ReadonlyMap<string, number>;

function mappedSequence(sequence: number | undefined, sequences: EvidenceSequenceMap): number | undefined {
  return sequence === undefined ? undefined : sequences.get(sequence);
}

function mappedIdentity(value: string | undefined, identities: OpaqueIdentityMap): number | undefined {
  return value === undefined ? undefined : identities.get(value);
}

function stableAssertionResult(result: AssertionResult, sequences: EvidenceSequenceMap): unknown {
  return {
    ...result,
    evidenceSequences: result.evidenceSequences.flatMap((sequence) => {
      const mapped = sequences.get(sequence);
      return mapped === undefined ? [] : [mapped];
    }),
  };
}

function stableCheckpoint(checkpoint: CheckpointResult, sequences: EvidenceSequenceMap): unknown {
  return {
    ...checkpoint,
    assertionResults: checkpoint.assertionResults.map((result) => stableAssertionResult(result, sequences)),
  };
}

function stableError(error: ErrorEnvelope, sequences: EvidenceSequenceMap): unknown {
  const { correlationId: _correlationId, evidence, ...stable } = error;
  const sequence = mappedSequence(evidence?.sequence, sequences);
  const stableEvidence = sequence === undefined ? undefined : { sequence };
  return {
    ...stable,
    ...(stableEvidence === undefined ? {} : { evidence: stableEvidence }),
  };
}

function stableOutcome(outcome: OperationOutcome, sequences: EvidenceSequenceMap): unknown {
  return outcome.error === undefined ? outcome : { ...outcome, error: stableError(outcome.error, sequences) };
}

function stableTargetResult(result: TargetResult, sequences: EvidenceSequenceMap): unknown {
  const { attachments: _attachments, ...stable } = result;
  return result.error === undefined ? stable : { ...stable, error: stableError(result.error, sequences) };
}

function stableEvidenceEntry(
  entry: EvidenceEntry,
  sequences: EvidenceSequenceMap,
  scheduledEvents: OpaqueIdentityMap,
  callbackDeliveries: OpaqueIdentityMap,
): unknown {
  const {
    causeSequence,
    correlationId: _correlationId,
    sequence,
    transactionId: _transactionId,
    ...fields
  } = entry;
  const normalizedCauseSequence = mappedSequence(causeSequence, sequences);
  const stable: Record<string, unknown> = {
    ...fields,
    sequence: sequences.get(sequence),
    ...(normalizedCauseSequence === undefined ? {} : { causeSequence: normalizedCauseSequence }),
  };
  if (entry.kind === "operation") {
    const {
      actorBindingId: _actorBindingId,
      callId: _callId,
      correlationId: _invocationCorrelationId,
      idempotencyKey: _idempotencyKey,
      ...invocation
    } = entry.invocation;
    const replayedFromSequence = mappedSequence(entry.replayedFromSequence, sequences);
    const { replayedFromSequence: _replayedFromSequence, ...operation } = stable;
    return {
      ...operation,
      invocation,
      outcome: stableOutcome(entry.outcome, sequences),
      ...(replayedFromSequence === undefined ? {} : { replayedFromSequence }),
    };
  }
  if (entry.kind === "event") {
    const { scheduledEventId: _scheduledEventId, ...event } = stable;
    const scheduledEventId = mappedIdentity(entry.scheduledEventId, scheduledEvents);
    return {
      ...event,
      ...(scheduledEventId === undefined ? {} : { scheduledEventId }),
    };
  }
  if (entry.kind === "callback") {
    const {
      deliveryId: _deliveryId,
      durationMs: _durationMs,
      idempotencyKey: _idempotencyKey,
      ...callback
    } = stable;
    const deliveryId = mappedIdentity(entry.deliveryId, callbackDeliveries);
    // The wire key scopes external deduplication, not the world's behavior.
    // Exact evidence integrity still covers this per-execution identity.
    const { idempotencyKey: _requestIdempotencyKey, ...request } = entry.request ?? {};
    return {
      ...callback,
      ...(entry.request === undefined ? {} : { request }),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      idempotencyKey: entry.idempotencyKey === entry.deliveryId ? deliveryId : entry.idempotencyKey,
    };
  }
  if (entry.kind === "verification") {
    return { ...stable, result: stableAssertionResult(entry.result, sequences) };
  }
  return stable;
}

/**
 * Hashes reproducible behavior while excluding per-execution trace identities.
 * Integrity remains covered separately by the exact evidence hash.
 */
export function trajectoryHash(input: TrajectoryHashInput): Sha256 {
  // World lifecycle rows describe how a runtime materialized, snapshotted,
  // reset, forked, or closed the substrate. They remain in exact evidence but
  // are not agent/world behavior: local and hosted operation may legitimately
  // perform different lifecycle plumbing around the same drill.
  const evidence = input.evidence.filter((entry) => entry.kind !== "lifecycle");
  const sequences = new Map(evidence.map((entry, index) => [entry.sequence, index + 1]));
  const scheduledEvents = new Map<string, number>();
  const callbackDeliveries = new Map<string, number>();
  for (const entry of evidence) {
    if (entry.kind === "event" && entry.scheduledEventId !== undefined) {
      if (!scheduledEvents.has(entry.scheduledEventId)) {
        scheduledEvents.set(entry.scheduledEventId, scheduledEvents.size + 1);
      }
    }
    if (entry.kind === "callback" && !callbackDeliveries.has(entry.deliveryId)) {
      callbackDeliveries.set(entry.deliveryId, callbackDeliveries.size + 1);
    }
  }
  return semanticHash({
    schemaVersion: 1,
    interactions: input.interactions.map((interaction) => ({
      ...interaction,
      targetResult: stableTargetResult(interaction.targetResult, sequences),
    })),
    checkpoints: input.checkpoints.map((checkpoint) => stableCheckpoint(checkpoint, sequences)),
    evidence: evidence.map((entry) =>
      stableEvidenceEntry(entry, sequences, scheduledEvents, callbackDeliveries),
    ),
  });
}
