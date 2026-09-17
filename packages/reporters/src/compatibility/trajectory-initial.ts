// Frozen trajectory algorithm from 74a0bb9. Compatibility-only.
import type {
  CheckpointResult,
  ErrorEnvelope,
  EvidenceEntry,
  InteractionResult,
  OperationOutcome,
  Sha256,
  TargetResult,
} from "@firedrill-tools/contracts";
import { semanticHash } from "@firedrill-tools/world-ir";

export interface TrajectoryHashInput {
  readonly interactions: readonly InteractionResult[];
  readonly checkpoints: readonly CheckpointResult[];
  readonly evidence: readonly EvidenceEntry[];
}

function stableError(error: ErrorEnvelope): unknown {
  const { correlationId: _correlationId, evidence, ...stable } = error;
  const stableEvidence = evidence?.sequence === undefined ? undefined : { sequence: evidence.sequence };
  return {
    ...stable,
    ...(stableEvidence === undefined ? {} : { evidence: stableEvidence }),
  };
}

function stableOutcome(outcome: OperationOutcome): unknown {
  return outcome.error === undefined ? outcome : { ...outcome, error: stableError(outcome.error) };
}

function stableTargetResult(result: TargetResult): unknown {
  const { attachments: _attachments, ...stable } = result;
  return result.error === undefined ? stable : { ...stable, error: stableError(result.error) };
}

function stableEvidenceEntry(entry: EvidenceEntry): unknown {
  const { correlationId: _correlationId, ...stable } = entry;
  if (entry.kind === "operation") {
    const {
      callId: _callId,
      correlationId: _invocationCorrelationId,
      idempotencyKey: _idempotencyKey,
      ...invocation
    } = entry.invocation;
    return {
      ...stable,
      invocation,
      outcome: stableOutcome(entry.outcome),
    };
  }
  if (entry.kind === "lifecycle") {
    const { worldInstanceId: _worldInstanceId, snapshotId: _snapshotId, ...lifecycle } = stable;
    return lifecycle;
  }
  return stable;
}

/**
 * Hashes reproducible behavior while excluding per-execution trace identities.
 * Integrity remains covered separately by the exact evidence hash.
 */
export function trajectoryHash(input: TrajectoryHashInput): Sha256 {
  return semanticHash({
    schemaVersion: 1,
    interactions: input.interactions.map((interaction) => ({
      ...interaction,
      targetResult: stableTargetResult(interaction.targetResult),
    })),
    checkpoints: input.checkpoints,
    evidence: input.evidence.map(stableEvidenceEntry),
  });
}
