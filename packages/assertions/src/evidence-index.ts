import type {
  CallbackEvidence,
  CallbackRef,
  EventEvidence,
  EventRef,
  EvidenceEntry,
  OperationEvidence,
  OperationRef,
} from "@firedrill-run/contracts";
import { EvidenceEntrySchema } from "@firedrill-run/contracts";

function operationKey(operation: OperationRef): string {
  return `${operation.packageId}\u0000${operation.operationId}`;
}

function eventKey(event: EventRef, phase: EventEvidence["phase"]): string {
  return `${event.packageId}\u0000${event.eventId}\u0000${phase}`;
}

function callbackKey(callback: CallbackRef, phase: CallbackEvidence["phase"]): string {
  return `${callback.packageId}\u0000${callback.callbackId}\u0000${phase}`;
}

function stateKey(packageId: string, namespace: string, rowId?: string): string {
  return `${packageId}\u0000${namespace}${rowId === undefined ? "" : `\u0000${rowId}`}`;
}

/**
 * Incremental, ordered view of a run's evidence. A long-running drill can append
 * each journal row once instead of re-reading and re-validating the complete
 * SQLite journal at every invariant checkpoint.
 */
export class AssertionEvidenceIndex {
  private readonly entries: EvidenceEntry[] = [];
  private readonly operations: OperationEvidence[] = [];
  private readonly operationsByKey = new Map<string, OperationEvidence[]>();
  private readonly stateSequencesByKey = new Map<string, number[]>();
  private readonly eventsByKey = new Map<string, EventEvidence[]>();
  private readonly callbacksByKey = new Map<string, CallbackEvidence[]>();

  constructor(entries: readonly EvidenceEntry[] = []) {
    this.append(entries);
  }

  append(entries: readonly EvidenceEntry[]): void {
    let previous = this.entries.at(-1)?.sequence ?? 0;
    for (const raw of entries) {
      const entry = EvidenceEntrySchema.parse(raw);
      if (entry.sequence <= previous) {
        throw new TypeError("assertion evidence must be strictly ordered by sequence");
      }
      previous = entry.sequence;
      this.entries.push(entry);
      if (entry.kind === "operation") {
        this.operations.push(entry);
        const key = operationKey(entry.invocation.operation);
        const values = this.operationsByKey.get(key) ?? [];
        values.push(entry);
        this.operationsByKey.set(key, values);
      } else if (entry.kind === "state_change") {
        for (const key of [
          stateKey(entry.packageId, entry.namespace),
          stateKey(entry.packageId, entry.namespace, entry.rowId),
        ]) {
          const values = this.stateSequencesByKey.get(key) ?? [];
          values.push(entry.sequence);
          this.stateSequencesByKey.set(key, values);
        }
      } else if (entry.kind === "event") {
        const key = eventKey(entry.event, entry.phase);
        const values = this.eventsByKey.get(key) ?? [];
        values.push(entry);
        this.eventsByKey.set(key, values);
      } else if (entry.kind === "callback") {
        const key = callbackKey(entry.callback, entry.phase);
        const values = this.callbacksByKey.get(key) ?? [];
        values.push(entry);
        this.callbacksByKey.set(key, values);
      }
    }
  }

  lastSequence(): number {
    return this.entries.at(-1)?.sequence ?? 0;
  }

  all(): readonly EvidenceEntry[] {
    return this.entries;
  }

  allOperations(): readonly OperationEvidence[] {
    return this.operations;
  }

  operation(operation: OperationRef): readonly OperationEvidence[] {
    return this.operationsByKey.get(operationKey(operation)) ?? [];
  }

  stateSequences(packageId: string, namespace: string, rowId?: string): readonly number[] {
    return this.stateSequencesByKey.get(stateKey(packageId, namespace, rowId)) ?? [];
  }

  event(event: EventRef, phase: EventEvidence["phase"]): readonly EventEvidence[] {
    return this.eventsByKey.get(eventKey(event, phase)) ?? [];
  }

  callback(callback: CallbackRef, phase: CallbackEvidence["phase"]): readonly CallbackEvidence[] {
    return this.callbacksByKey.get(callbackKey(callback, phase)) ?? [];
  }
}
