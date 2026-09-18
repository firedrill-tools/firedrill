import type { Diagnostic, JsonObject } from "@firedrill-run/contracts";

export type FiredrillProjectErrorCode =
  | "framework.AGENT_CALLBACK_UNUSED"
  | "framework.BUILD_HASH_MISMATCH"
  | "framework.BUILD_INVALID"
  | "framework.DRILL_NOT_FOUND"
  | "framework.DATA_IMPORT_INVALID"
  | "framework.FAULT_NOT_FOUND"
  | "framework.INTERNAL_ERROR"
  | "framework.INVALID_ARGUMENT"
  | "framework.NO_DRILLS"
  | "framework.NO_DRILLS_SELECTED"
  | "framework.REPORT_INVALID"
  | "framework.SOURCE_INVALID"
  | "framework.SCENARIO_NOT_FOUND"
  | "framework.SCENARIO_EXISTS"
  | "framework.SCENARIO_CAPTURE_CHANGED"
  | "framework.SCENARIO_EXPORT_TOO_LARGE"
  | "framework.SUITE_NOT_FOUND"
  | "framework.TOOL_CONFORMANCE_FAILED"
  | "framework.TOOL_CONFORMANCE_SUITE_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_EXISTS"
  | "framework.TOOL_CONTRIBUTION_SOURCE_REQUIRED"
  | "framework.TOOL_CONTRIBUTION_UNSAFE"
  | "framework.TOOL_NOT_FOUND"
  | "framework.WORLD_CLOSED"
  | "framework.WORLD_RESET_FAILED";

export class FiredrillProjectError extends Error {
  readonly code: FiredrillProjectErrorCode;
  readonly diagnostics: readonly Diagnostic[];
  readonly details: JsonObject;

  constructor(
    code: FiredrillProjectErrorCode,
    message: string,
    options: { readonly diagnostics?: readonly Diagnostic[]; readonly details?: JsonObject } = {},
  ) {
    super(message);
    this.name = "FiredrillProjectError";
    this.code = code;
    this.diagnostics = options.diagnostics ?? [];
    this.details = options.details ?? {};
  }
}
