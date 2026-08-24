import { ErrorEnvelopeSchema } from "@firedrill/contracts";
import type { CorrelationId, ErrorEnvelope, ErrorIssue, JsonObject } from "@firedrill/contracts";

export function frameworkError(
  correlationId: CorrelationId,
  code: string,
  message: string,
  options: { readonly details?: JsonObject; readonly issues?: readonly ErrorIssue[] } = {},
): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({
    schemaVersion: 1,
    source: "framework",
    code: `framework.${code}`,
    message,
    retryable: false,
    correlationId,
    issues: options.issues ?? [],
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

export function worldError(
  correlationId: CorrelationId,
  code: string,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly details?: JsonObject;
    readonly issues?: readonly ErrorIssue[];
  } = {},
): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({
    schemaVersion: 1,
    source: "world",
    code: `world.${code}`,
    message,
    retryable: options.retryable ?? false,
    correlationId,
    issues: options.issues ?? [],
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

export function toolError(
  correlationId: CorrelationId,
  code: string,
  message: string,
  options: { readonly retryable?: boolean; readonly details?: JsonObject } = {},
): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({
    schemaVersion: 1,
    source: "tool",
    code: `tool.${code}`,
    message,
    retryable: options.retryable ?? false,
    correlationId,
    issues: [],
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

export class ExecutionAbort extends Error {
  readonly envelope: ErrorEnvelope;
  readonly failedEvent:
    | {
        readonly event: { readonly packageId: string; readonly eventId: string };
        readonly payload: JsonObject;
        readonly handlerPackageId?: string;
        readonly subscriptionId?: string;
      }
    | undefined;

  constructor(
    envelope: ErrorEnvelope,
    failedEvent?: {
      readonly event: { readonly packageId: string; readonly eventId: string };
      readonly payload: JsonObject;
      readonly handlerPackageId?: string;
      readonly subscriptionId?: string;
    },
  ) {
    super(envelope.message);
    this.name = "ExecutionAbort";
    this.envelope = envelope;
    this.failedEvent = failedEvent;
  }
}
