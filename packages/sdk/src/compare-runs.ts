import { resolve } from "node:path";
import { LocalReportVerificationError, compareLocalReports } from "@firedrill/reporters";
import type { LocalRunComparison } from "@firedrill/reporters";
import { FiredrillProjectError } from "./project-error.js";

export interface CompareRunsOptions {
  readonly baselineReport: string;
  readonly candidateReport: string;
}

/** Compare two verified local evidence bundles without contacting a hosted service. */
export function compareRuns(options: CompareRunsOptions): LocalRunComparison {
  try {
    return compareLocalReports(resolve(options.baselineReport), resolve(options.candidateReport));
  } catch (error) {
    if (!(error instanceof LocalReportVerificationError)) throw error;
    throw new FiredrillProjectError("framework.REPORT_INVALID", error.message, {
      details: { reporterCode: error.code },
    });
  }
}

export type { LocalRunComparison } from "@firedrill/reporters";
