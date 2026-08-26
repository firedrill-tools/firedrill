import { createHash, createHmac } from "node:crypto";
import { validateHeaderValue } from "node:http";
import {
  CallbackErrorEvidenceSchema,
  JsonValueSchema,
  VirtualTimeSchema,
  compareStableStrings,
} from "@firedrill/contracts";
import type {
  CallbackContract,
  CallbackErrorEvidence,
  CallbackRequestEvidence,
  CallbackResponseEvidence,
  VirtualTime,
} from "@firedrill/contracts";
import type {
  ToolCallbackCodec,
  ToolCallbackRequest,
  ToolDefinition,
  ToolHttpResponseBody,
} from "@firedrill/tool-sdk";
import type { CallbackDelivery, CallbackTransition, WorldStore } from "@firedrill/world-store";

export const MAX_CALLBACK_REQUEST_BYTES = 1024 * 1024;
export const MAX_CALLBACK_RESPONSE_BYTES = 64 * 1024;
export const MAX_CALLBACK_HEADERS = 64;
export const MAX_CALLBACK_HEADER_BYTES = 16 * 1024;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface CallbackReceiver {
  /** Local receiver origin. Paths come from the Tool callback contract. */
  readonly baseUrl: string;
  /** BYOK secret used only when the callback contract declares HMAC signing. */
  readonly secret?: string;
}

export interface CallbackDispatcherOptions {
  readonly store: WorldStore;
  readonly tools: readonly ToolDefinition[];
  readonly receivers: Readonly<Record<string, CallbackReceiver>>;
  /** Test seam. Ordinary callers use the platform fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface CallbackDispatchOutcome {
  readonly deliveryId: CallbackDelivery["id"];
  readonly attempt: number;
  readonly status: "delivered" | "retry_scheduled" | "failed";
}

export interface CallbackDispatchResult {
  readonly outcomes: readonly CallbackDispatchOutcome[];
}

interface CallbackRuntime {
  readonly contract: CallbackContract;
  readonly codec: ToolCallbackCodec;
}

interface PreparedCallback {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly evidence: CallbackRequestEvidence;
}

class CallbackPreparationError extends Error {
  readonly evidence: CallbackErrorEvidence;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CallbackPreparationError";
    this.evidence = CallbackErrorEvidenceSchema.parse({
      code: `framework.${code}`,
      message,
      retryable: false,
    });
  }
}

function runtimeKey(packageId: string, callbackId: string): string {
  return `${packageId}\u0000${callbackId}`;
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function loopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function callbackUrl(receiver: CallbackReceiver, path: string): URL {
  let base: URL;
  try {
    base = new URL(receiver.baseUrl);
  } catch {
    throw new CallbackPreparationError("CALLBACK_RECEIVER_INVALID", "callback receiver URL is invalid");
  }
  if (
    base.protocol !== "http:" ||
    !loopbackHostname(base.hostname) ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0 ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new CallbackPreparationError(
      "CALLBACK_RECEIVER_BLOCKED",
      "local callbacks require a credential-free loopback HTTP origin",
    );
  }
  return new URL(path, base);
}

function callbackBody(body: ToolHttpResponseBody): { readonly bytes: Buffer; readonly contentType?: string } {
  if (body.kind === "empty") return { bytes: Buffer.alloc(0) };
  if (body.kind === "json") {
    return {
      bytes: Buffer.from(`${JSON.stringify(JsonValueSchema.parse(body.value))}\n`, "utf8"),
      contentType: "application/json; charset=utf-8",
    };
  }
  if (body.kind === "text") {
    if (body.contentType !== undefined) validateHeaderValue("content-type", body.contentType);
    return {
      bytes: Buffer.from(body.value, "utf8"),
      contentType: body.contentType ?? "text/plain; charset=utf-8",
    };
  }
  validateHeaderValue("content-type", body.contentType);
  return { bytes: Buffer.from(body.value), contentType: body.contentType };
}

function callbackHeaders(
  request: ToolCallbackRequest,
  contract: CallbackContract,
  delivery: CallbackDelivery,
  receiver: CallbackReceiver,
  bytes: Buffer,
  contentType?: string,
): Readonly<Record<string, string>> {
  const entries = Object.entries(request.headers ?? {});
  if (entries.length > MAX_CALLBACK_HEADERS) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      `callback codec returned more than ${MAX_CALLBACK_HEADERS} headers`,
    );
  }
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  const reserved = new Set([contract.idempotencyHeader.toLowerCase()]);
  if (contract.signature.kind === "hmac-sha256") reserved.add(contract.signature.header.toLowerCase());
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      FORBIDDEN_REQUEST_HEADERS.has(lower) ||
      reserved.has(lower) ||
      headers[lower] !== undefined
    ) {
      throw new CallbackPreparationError(
        "CALLBACK_REQUEST_INVALID",
        `callback codec returned forbidden or duplicate header ${name}`,
      );
    }
    try {
      validateHeaderValue(name, value);
    } catch {
      throw new CallbackPreparationError(
        "CALLBACK_REQUEST_INVALID",
        `callback codec returned an invalid value for header ${name}`,
      );
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > MAX_CALLBACK_HEADER_BYTES) {
      throw new CallbackPreparationError(
        "CALLBACK_REQUEST_INVALID",
        "callback request headers exceed 16 KiB",
      );
    }
    headers[lower] = value;
  }
  if (contentType !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = contentType;
  }
  headers[contract.idempotencyHeader.toLowerCase()] = delivery.id;
  if (contract.signature.kind === "hmac-sha256") {
    if (receiver.secret === undefined || receiver.secret.length === 0) {
      throw new CallbackPreparationError(
        "CALLBACK_SECRET_MISSING",
        `callback receiver ${delivery.receiverId} requires a signing secret`,
      );
    }
    headers[contract.signature.header.toLowerCase()] =
      `${contract.signature.prefix}${createHmac("sha256", receiver.secret).update(bytes).digest("hex")}`;
  }
  const totalHeaderBytes = Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
    0,
  );
  if (Object.keys(headers).length > MAX_CALLBACK_HEADERS || totalHeaderBytes > MAX_CALLBACK_HEADER_BYTES) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback request headers exceed the framework limit",
    );
  }
  return Object.freeze(headers);
}

function prepareCallback(
  delivery: CallbackDelivery,
  runtime: CallbackRuntime,
  receiver: CallbackReceiver,
): PreparedCallback {
  let encoded: ToolCallbackRequest;
  try {
    encoded = runtime.codec.encode({
      callbackId: runtime.contract.id,
      deliveryId: delivery.id,
      receiverId: delivery.receiverId,
      event: delivery.event,
      payload: delivery.payload,
      virtualTimeUs: delivery.dueUs,
      attempt: delivery.attemptCount + 1,
    });
  } catch (error) {
    throw new CallbackPreparationError(
      "CALLBACK_CODEC_FAILED",
      error instanceof Error
        ? `callback codec failed: ${error.message}`
        : "callback codec failed with a non-error value",
    );
  }
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback codec must return a request object",
    );
  }
  const body = callbackBody(encoded.body);
  if (body.bytes.length > MAX_CALLBACK_REQUEST_BYTES) {
    throw new CallbackPreparationError("CALLBACK_REQUEST_TOO_LARGE", "callback request body exceeds 1 MiB");
  }
  const headers = callbackHeaders(
    encoded,
    runtime.contract,
    delivery,
    receiver,
    body.bytes,
    body.contentType,
  );
  return {
    url: callbackUrl(receiver, runtime.contract.path),
    headers,
    body: body.bytes,
    evidence: {
      method: runtime.contract.method,
      path: runtime.contract.path,
      bodyHash: sha256(body.bytes),
      bodyBytes: body.bytes.length,
      signature:
        runtime.contract.signature.kind === "none"
          ? { kind: "none" }
          : { kind: "hmac-sha256", header: runtime.contract.signature.header.toLowerCase() },
    },
  };
}

async function responseEvidence(response: Response): Promise<CallbackResponseEvidence> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RangeError("callback response body exceeds 64 KiB");
  }
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteCount += next.value.byteLength;
      if (byteCount > MAX_CALLBACK_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RangeError("callback response body exceeds 64 KiB");
      }
      chunks.push(next.value);
    }
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    byteCount,
  );
  return {
    status: response.status,
    body: new TextDecoder().decode(body),
    bodyHash: sha256(body),
    bodyBytes: body.length,
  };
}

function callbackError(code: string, message: string, retryable: boolean): CallbackErrorEvidence {
  return CallbackErrorEvidenceSchema.parse({ code: `framework.${code}`, message, retryable });
}

function callbackResult(transition: CallbackTransition) {
  return { value: transition.delivery, primary: transition.evidence };
}

export class CallbackDispatcher {
  private readonly store: WorldStore;
  private readonly runtimes = new Map<string, CallbackRuntime>();
  private readonly receivers: Readonly<Record<string, CallbackReceiver>>;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private activeDispatch: Promise<CallbackDispatchResult> | undefined;

  constructor(options: CallbackDispatcherOptions) {
    this.store = options.store;
    this.receivers = Object.freeze({ ...options.receivers });
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    for (const tool of options.tools) {
      for (const contract of tool.manifest.callbacks) {
        const key = runtimeKey(tool.manifest.id, contract.id);
        if (this.runtimes.has(key))
          throw new TypeError(`duplicate callback runtime ${tool.manifest.id}.${contract.id}`);
        const codec = tool.callbacks[contract.id];
        if (codec === undefined) {
          throw new TypeError(`Tool ${tool.manifest.id} has no codec for callback ${contract.id}`);
        }
        this.runtimes.set(key, { contract, codec });
      }
    }
  }

  nextDueUs(): VirtualTime | null {
    return this.store.nextCallbackDelivery()?.dueUs ?? null;
  }

  recoverInFlight(): number {
    const interrupted = [...this.store.listCallbackDeliveries("in_flight")].sort((left, right) =>
      compareStableStrings(left.id, right.id),
    );
    for (const delivery of interrupted) {
      this.store.transact(delivery.correlationId, (transaction) =>
        callbackResult(transaction.recoverCallbackAttempt(delivery.id)),
      );
    }
    return interrupted.length;
  }

  async dispatchDue(): Promise<CallbackDispatchResult> {
    if (this.activeDispatch !== undefined) return this.activeDispatch;
    const active = this.performDispatchDue();
    this.activeDispatch = active;
    try {
      return await active;
    } finally {
      if (this.activeDispatch === active) this.activeDispatch = undefined;
    }
  }

  private async performDispatchDue(): Promise<CallbackDispatchResult> {
    const nowUs = this.store.metadata().virtualTimeUs;
    const outcomes: CallbackDispatchOutcome[] = [];
    while (true) {
      const delivery = this.store.nextCallbackDelivery(nowUs);
      if (delivery === null) break;
      const runtime = this.runtimes.get(
        runtimeKey(delivery.callback.packageId, delivery.callback.callbackId),
      );
      const receiver = this.receivers[delivery.receiverId];
      if (runtime === undefined || receiver === undefined) {
        const error = callbackError(
          runtime === undefined ? "CALLBACK_RUNTIME_MISSING" : "CALLBACK_RECEIVER_MISSING",
          runtime === undefined
            ? `callback runtime ${delivery.callback.packageId}.${delivery.callback.callbackId} is unavailable`
            : `callback receiver ${delivery.receiverId} was not configured for this drill`,
          false,
        );
        const failed = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(transaction.failCallbackDelivery(delivery.id, error)),
        ).value;
        outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
        continue;
      }

      let prepared: PreparedCallback;
      try {
        prepared = prepareCallback(delivery, runtime, receiver);
      } catch (error) {
        const failure =
          error instanceof CallbackPreparationError
            ? error.evidence
            : callbackError(
                "CALLBACK_REQUEST_INVALID",
                error instanceof Error ? error.message : "callback request preparation failed",
                false,
              );
        const failed = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(transaction.failCallbackDelivery(delivery.id, failure)),
        ).value;
        outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
        continue;
      }

      const started = this.store.transact(delivery.correlationId, (transaction) =>
        callbackResult(transaction.startCallbackAttempt(delivery.id, prepared.evidence)),
      ).value;
      const startedAt = performance.now();
      let response: CallbackResponseEvidence | undefined;
      let error: CallbackErrorEvidence | undefined;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), runtime.contract.timeoutMs);
      try {
        const received = await this.fetchImplementation(prepared.url, {
          method: runtime.contract.method,
          headers: prepared.headers,
          body: prepared.body,
          redirect: "manual",
          signal: controller.signal,
        });
        response = await responseEvidence(received);
        if (response.status < 200 || response.status > 299) {
          error = callbackError(
            "CALLBACK_HTTP_REJECTED",
            `callback receiver returned HTTP ${String(response.status)}`,
            true,
          );
        }
      } catch (caught) {
        const timedOut = controller.signal.aborted;
        error = callbackError(
          timedOut
            ? "CALLBACK_TIMEOUT"
            : caught instanceof RangeError
              ? "CALLBACK_RESPONSE_TOO_LARGE"
              : "CALLBACK_NETWORK_ERROR",
          timedOut
            ? `callback receiver did not respond within ${String(runtime.contract.timeoutMs)} ms`
            : caught instanceof Error
              ? caught.message
              : "callback request failed",
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
      const durationMs = Math.min(60_000, Math.max(0, performance.now() - startedAt));

      if (error === undefined && response !== undefined) {
        const delivered = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(
            transaction.settleCallbackAttempt(delivery.id, {
              status: "delivered",
              attempt: started.attemptCount,
              response,
              durationMs,
            }),
          ),
        ).value;
        outcomes.push({ deliveryId: delivered.id, attempt: delivered.attemptCount, status: "delivered" });
        continue;
      }

      if (error === undefined) {
        throw new Error(`callback delivery ${delivery.id} completed without a response or error`);
      }

      const retryDelay = started.retryDelaysUs[started.attemptCount - 1];
      if (retryDelay !== undefined) {
        const nextAttemptUs = VirtualTimeSchema.parse(nowUs + retryDelay);
        const retried = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(
            transaction.settleCallbackAttempt(delivery.id, {
              status: "retry_scheduled",
              attempt: started.attemptCount,
              nextAttemptUs,
              ...(response === undefined ? {} : { response }),
              error,
              durationMs,
            }),
          ),
        ).value;
        outcomes.push({ deliveryId: retried.id, attempt: retried.attemptCount, status: "retry_scheduled" });
      } else {
        const failed = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(
            transaction.settleCallbackAttempt(delivery.id, {
              status: "failed",
              attempt: started.attemptCount,
              ...(response === undefined ? {} : { response }),
              error,
              durationMs,
            }),
          ),
        ).value;
        outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
      }
    }
    return { outcomes: Object.freeze(outcomes) };
  }
}
