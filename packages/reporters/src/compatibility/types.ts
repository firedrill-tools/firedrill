import type { EvidenceEntry, ReportToolDescriptor, RunResult } from "@firedrill-tools/contracts";

/** Already validated, redacted report values; never raw Tool output. */
export interface ReportProjectionInput {
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  readonly tools: readonly ReportToolDescriptor[];
}

export interface ReportProjections {
  readonly json: string;
  readonly terminal: string;
  readonly junit: string;
  readonly html: string;
}
