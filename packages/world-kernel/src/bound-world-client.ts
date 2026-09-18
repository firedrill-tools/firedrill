import { createHash } from "node:crypto";
import type { ActorBindingId, JsonObject, OperationRef } from "@firedrill-run/contracts";
import { ActorBindingIdSchema, JsonObjectSchema, OperationRefSchema } from "@firedrill-run/contracts";
import type { KernelInvocationResult } from "./types.js";
import type { WorldKernel } from "./world-kernel.js";

export interface BoundWorldCallOptions {
  readonly idempotencyKey?: string;
}

export interface BoundWorldClientOptions {
  readonly kernel: WorldKernel;
  readonly actorBindingId: ActorBindingId;
  /** A stable run- or world-local namespace used only to derive trace identifiers. */
  readonly namespace: string;
}

/**
 * A small programmatic binding for one scenario actor. Protocol adapters share
 * one instance so operation ordering and generated trace identifiers stay
 * deterministic for the same call order.
 */
export class BoundWorldClient {
  readonly actorBindingId: ActorBindingId;
  private readonly kernel: WorldKernel;
  private readonly traceNamespace: string;
  private sequence = 0;
  private revoked = false;

  constructor(options: BoundWorldClientOptions) {
    if (options.namespace.length === 0) throw new TypeError("world client namespace cannot be empty");
    this.kernel = options.kernel;
    this.actorBindingId = ActorBindingIdSchema.parse(options.actorBindingId);
    this.traceNamespace = createHash("sha256")
      .update("firedrill.bound-world-client.v1\0")
      .update(options.namespace)
      .digest("hex")
      .slice(0, 16);
  }

  callsIssued(): number {
    return this.sequence;
  }

  /** Creates a separately revocable client for one target invocation. */
  scope(namespace: string): BoundWorldClient {
    return new BoundWorldClient({
      kernel: this.kernel,
      actorBindingId: this.actorBindingId,
      namespace,
    });
  }

  /** Permanently prevents this invocation-scoped client from issuing more calls. */
  revoke(): void {
    this.revoked = true;
  }

  invoke(
    operationInput: OperationRef,
    argumentsInput: JsonObject,
    options: BoundWorldCallOptions = {},
  ): KernelInvocationResult {
    if (this.revoked) throw new TypeError("world client is no longer active");
    const operation = OperationRefSchema.parse(operationInput);
    const arguments_ = JsonObjectSchema.parse(argumentsInput);
    this.sequence += 1;
    const suffix = `${this.traceNamespace}_${String(this.sequence).padStart(8, "0")}`;
    return this.kernel.invoke({
      schemaVersion: 1,
      callId: `call_${suffix}`,
      correlationId: `corr_${suffix}`,
      operation,
      actorBindingId: this.actorBindingId,
      arguments: arguments_,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }
}
