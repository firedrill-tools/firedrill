import type { Diagnostic } from "@firedrill/contracts";
import { diagnostic } from "./diagnostics.js";
import type { SourceDocument } from "./types.js";

export const AUTHORED_SOURCE_SCHEMA_VERSION = 1 as const;

/**
 * Version dispatch happens before schema validation so an unfamiliar source
 * version is never reported as a generic field error or silently interpreted
 * using the current shape.
 */
export function authoredSourceVersionDiagnostic(document: SourceDocument): Diagnostic | undefined {
  if (
    typeof document.value !== "object" ||
    document.value === null ||
    Array.isArray(document.value) ||
    !("schemaVersion" in document.value)
  ) {
    return undefined;
  }
  const version = (document.value as Record<string, unknown>).schemaVersion;
  if (!Number.isSafeInteger(version) || version === AUTHORED_SOURCE_SCHEMA_VERSION) return undefined;
  return diagnostic({
    code: "FD1103",
    message: `unsupported authored source schemaVersion ${String(version)}; this release supports ${AUTHORED_SOURCE_SCHEMA_VERSION}`,
    span: document.spanAt(["schemaVersion"]),
    path: ["schemaVersion"],
    suggestion:
      typeof version === "number" && version > AUTHORED_SOURCE_SCHEMA_VERSION
        ? `Use a Firedrill release that supports schemaVersion ${version}; do not relabel a newer document as version ${AUTHORED_SOURCE_SCHEMA_VERSION}.`
        : `Migrate this resource to the published schemaVersion ${AUTHORED_SOURCE_SCHEMA_VERSION} shape before running it.`,
  });
}
