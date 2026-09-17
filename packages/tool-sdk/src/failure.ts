import type { JsonObject } from "@firedrill-tools/contracts";

const TOOL_CODE = /^[A-Z][A-Z0-9_]*$/;
const TOOL_FAILURE_BRAND = Symbol.for("dev.firedrill.tool-failure");

export interface ToolFailureOptions {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}

/** An expected, declared failure returned by synthetic Tool behavior. */
export class ToolFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(options: ToolFailureOptions) {
    if (!TOOL_CODE.test(options.code)) {
      throw new TypeError(`invalid Tool failure code ${JSON.stringify(options.code)}`);
    }
    if (options.message.length === 0) throw new TypeError("Tool failure message cannot be empty");
    super(options.message);
    this.name = "ToolFailure";
    Object.defineProperty(this, TOOL_FAILURE_BRAND, { value: true });
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Recognizes expected Tool failures across separately bundled Tool SDK copies.
 * Tool artifacts are self-contained, so `instanceof` is not a stable boundary.
 */
export function isToolFailure(value: unknown): value is ToolFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ToolFailure> & { readonly [TOOL_FAILURE_BRAND]?: unknown };
  return (
    candidate[TOOL_FAILURE_BRAND] === true &&
    candidate.name === "ToolFailure" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    TOOL_CODE.test(candidate.code) &&
    typeof candidate.retryable === "boolean"
  );
}
