import { resolve } from "node:path";
import {
  LocalReportVerificationError,
  compareLocalReports,
  compareLocalReportDetails,
} from "@firedrill/reporters";
import type { LocalRunComparisonDetailOptions, LocalRunComparisonDetailPage } from "@firedrill/reporters";
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

/** Read bounded recorded differences; never invokes an agent or mutates reports. */
export function compareRunDetails(
  options: CompareRunsOptions & LocalRunComparisonDetailOptions,
): LocalRunComparisonDetailPage {
  try {
    return compareLocalReportDetails(
      resolve(options.baselineReport),
      resolve(options.candidateReport),
      options,
    );
  } catch (error) {
    if (!(error instanceof LocalReportVerificationError)) throw error;
    throw new FiredrillProjectError("framework.REPORT_INVALID", error.message, {
      details: { reporterCode: error.code },
    });
  }
}
export type {
  LocalRunComparisonDetailOptions,
  LocalRunComparisonDetailPage,
  RunComparisonDetailItem,
  RecordedComparisonValue,
} from "@firedrill/reporters";
