import { resolve } from "node:path";
import type { VerifiedLocalReport } from "@firedrill/reporters";
import { LocalReportVerificationError, verifyLocalReport } from "@firedrill/reporters";
import { FiredrillProjectError } from "./run-drills.js";

export interface VerifyReportOptions {
  /** Directory containing a Firedrill local report bundle. */
  readonly report: string;
}

/** Verify a local evidence bundle without contacting a hosted service. */
export function verifyReport(options: VerifyReportOptions): VerifiedLocalReport {
  try {
    return verifyLocalReport(resolve(options.report));
  } catch (error) {
    if (!(error instanceof LocalReportVerificationError)) throw error;
    throw new FiredrillProjectError("framework.REPORT_INVALID", error.message, {
      details: { reporterCode: error.code },
    });
  }
}

export type { VerifiedLocalReport } from "@firedrill/reporters";
