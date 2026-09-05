import { createHash, createHmac } from "node:crypto";
import { validateHeaderValue } from "node:http";
import type {
  CallbackContract,
  CallbackErrorEvidence,
  CallbackRequestEvidence,
  CallbackResponseEvidence,
  PackageId,
  VirtualTime,
} from "@firedrill/contracts";
import {
  CallbackErrorEvidenceSchema,
  compareStableStrings,
  JsonValueSchema,
  PackageIdSchema,
  VirtualTimeSchema,
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
  /** Receiver origin. Defaults to local loopback HTTP; paths come only from the Tool contract. */
  readonly baseUrl: string;
  /** BYOK secret used only when the callback contract declares HMAC signing. */
  readonly secret?: string;
}

/** Dispatcher-owned delivery context, passed separately from codec-controlled HTTP data. */
export interface CallbackTransportContext {
  readonly receiverId: string;
}

/** An explicitly owned network edge, never supplied by a Tool callback codec. */
export interface CallbackTransport {
  /** Selects an approved origin for this receiver. Anything other than true fails closed. */
  authorizeOrigin(input: { readonly receiverId: string; readonly origin: string }): boolean;
  /**
   * Enforces destination/network policy on every connection, including DNS resolution.
   * Must honor the abort signal and reject redirects. Its fetch rejection and response
   * body completion/cancellation must await cleanup of active I/O. Origin selection
   * alone is not a network-isolation boundary. The dispatcher supplies a frozen context
   * on every attempt; implementations needing receiver identity must reject its absence.
   * Ordinary fetch implementations remain assignable and may ignore the third argument.
   */
  readonly fetch: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
    context?: CallbackTransportContext,
  ) => Promise<Response>;
}

export interface CallbackDispatcherOptions {
  readonly store: WorldStore;
  readonly tools: readonly ToolDefinition[];
  /** Static mappings and resolveReceiver are mutually exclusive; neither provides fallback for the other. */
  readonly receivers?: Readonly<Record<string, CallbackReceiver>>;
  /**
   * Resolve only the current due delivery, on every attempt. No lookup runs at construction.
   * The frozen context is reused for transport.fetch. Honor the shared abort signal and
   * await cleanup before settling; the callback timeout includes this lookup and preparation.
   * Exceptions are replaced with safe resolution-failure evidence, never their diagnostics.
   */
  readonly resolveReceiver?: (
    context: CallbackTransportContext,
    signal: AbortSignal,
  ) => Promise<CallbackReceiver | undefined>;
  /** Test seam. Ordinary callers use the platform fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
  /** Explicit caller-owned origin policy and network transport. No remote transport is built in. */
  readonly transport?: CallbackTransport;
  /**
   * Stable execution identity, required with an explicit transport. Preserve across retries
   * and recovery; change for every full-world reset/fork execution generation. Never include secrets.
   * When omitted, local delivery IDs remain the wire idempotency keys.
   */
  readonly idempotencyScope?: string;
  /**
   * Per-package execution identities for partial resets. Requires idempotencyScope.
   * Keys must name installed Tools; values follow the same scope bounds. Copied at construction.
   * An override applies to deliveries owned by the package or emitted by its events.
   */
  readonly idempotencyScopeByPackage?: Readonly<Record<PackageId, string>>;
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

function callbackUrl(
  receiver: CallbackReceiver,
  path: string,
  receiverId: string,
  transport: CallbackTransport | undefined,
): URL {
  let base: URL;
  try {
    base = new URL(receiver.baseUrl);
  } catch {
    throw new CallbackPreparationError("CALLBACK_RECEIVER_INVALID", "callback receiver URL is invalid");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0 ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new CallbackPreparationError(
      "CALLBACK_RECEIVER_BLOCKED",
      "callbacks require a credential-free HTTP origin without a path, query, or fragment",
    );
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\s?#]/.test(path) || path.length > 512) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback path must be a static absolute path",
    );
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.pathname !== path) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback path must not escape or normalize its declared path",
    );
  }
  let allowed = base.protocol === "http:" && loopbackHostname(base.hostname);
  if (transport !== undefined) {
    try {
      allowed = transport.authorizeOrigin(Object.freeze({ receiverId, origin: base.origin })) === true;
    } catch {
      allowed = false;
    }
  }
  if (!allowed) {
    throw new CallbackPreparationError(
      "CALLBACK_RECEIVER_BLOCKED",
      transport === undefined
        ? "local callbacks require a credential-free loopback HTTP origin"
        : "callback receiver origin is not authorized by the configured transport",
    );
  }
  return url;
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
  idempotencyKey: string,
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
  if ([...reserved].some((name) => !HEADER_NAME.test(name) || FORBIDDEN_REQUEST_HEADERS.has(name))) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback contract declares a forbidden delivery header",
    );
  }
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
  headers[contract.idempotencyHeader.toLowerCase()] = idempotencyKey;
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
  transport: CallbackTransport | undefined,
  idempotencyKey: string,
): PreparedCallback {
  const url = callbackUrl(receiver, runtime.contract.path, delivery.receiverId, transport);
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
  if (Object.keys(encoded).some((key) => key !== "headers" && key !== "body")) {
    throw new CallbackPreparationError(
      "CALLBACK_REQUEST_INVALID",
      "callback codec may supply only headers and body",
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
    idempotencyKey,
    body.bytes,
    body.contentType,
  );
  return {
    url,
    headers,
    body: body.bytes,
    evidence: {
      method: runtime.contract.method,
      path: runtime.contract.path,
      bodyHash: sha256(body.bytes),
      bodyBytes: body.bytes.length,
      idempotencyKey,
      signature:
        runtime.contract.signature.kind === "none"
          ? { kind: "none" }
          : { kind: "hmac-sha256", header: runtime.contract.signature.header.toLowerCase() },
    },
  };
}

async function responseEvidence(response: Response, signal: AbortSignal): Promise<CallbackResponseEvidence> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RangeError("callback response body exceeds 64 KiB");
  }
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        byteCount += next.value.byteLength;
        if (byteCount > MAX_CALLBACK_RESPONSE_BYTES) {
          throw new RangeError("callback response body exceeds 64 KiB");
        }
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
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
  private readonly resolveReceiver: CallbackDispatcherOptions["resolveReceiver"];
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly transport: CallbackTransport | undefined;
  private readonly idempotencyScope: string | undefined;
  private readonly idempotencyScopeByPackage: Readonly<Record<PackageId, string>>;
  private activeDispatch: Promise<CallbackDispatchResult> | undefined;

  constructor(options: CallbackDispatcherOptions) {
    this.store = options.store;
    if ((options.receivers === undefined) === (options.resolveReceiver === undefined)) {
      throw new TypeError("callbacks require exactly one static receiver map or receiver resolver");
    }
    if (options.resolveReceiver !== undefined && typeof options.resolveReceiver !== "function") {
      throw new TypeError("callback receiver resolver must be a function");
    }
    this.resolveReceiver = options.resolveReceiver;
    this.receivers = Object.freeze(
      Object.fromEntries(
        Object.entries(options.receivers ?? {}).map(([id, receiver]) => [id, Object.freeze({ ...receiver })]),
      ),
    );
    if (options.transport !== undefined && options.fetch !== undefined) {
      throw new TypeError("callback transport and test fetch cannot be supplied together");
    }
    if (options.transport !== undefined && options.idempotencyScope === undefined) {
      throw new TypeError("an explicit callback transport requires an idempotency scope");
    }
    if (
      options.idempotencyScope !== undefined &&
      (typeof options.idempotencyScope !== "string" ||
        options.idempotencyScope.trim().length === 0 ||
        Buffer.byteLength(options.idempotencyScope) > 1024)
    ) {
      throw new TypeError("callback idempotency scope must be a nonempty string of at most 1024 bytes");
    }
    this.idempotencyScope = options.idempotencyScope;
    const packageScopes = options.idempotencyScopeByPackage;
    if (packageScopes !== undefined && this.idempotencyScope === undefined) {
      throw new TypeError("callback package idempotency scopes require a base idempotency scope");
    }
    if (
      packageScopes !== undefined &&
      (typeof packageScopes !== "object" ||
        packageScopes === null ||
        (Object.getPrototypeOf(packageScopes) !== Object.prototype &&
          Object.getPrototypeOf(packageScopes) !== null))
    ) {
      throw new TypeError("callback package idempotency scopes must be a record");
    }
    const installedPackages = new Set(options.tools.map((tool) => tool.manifest.id));
    this.idempotencyScopeByPackage = Object.freeze(
      Object.fromEntries(
        Reflect.ownKeys(packageScopes ?? {}).map((packageId) => {
          if (
            typeof packageId !== "string" ||
            !PackageIdSchema.safeParse(packageId).success ||
            !installedPackages.has(packageId)
          ) {
            throw new TypeError("callback package idempotency scope keys must name installed Tools");
          }
          const scope = packageScopes?.[packageId];
          if (typeof scope !== "string" || scope.trim().length === 0 || Buffer.byteLength(scope) > 1024) {
            throw new TypeError(
              "callback package idempotency scope must be a nonempty string of at most 1024 bytes",
            );
          }
          return [packageId, scope];
        }),
      ),
    );
    this.transport =
      options.transport === undefined
        ? undefined
        : Object.freeze({
            authorizeOrigin: options.transport.authorizeOrigin.bind(options.transport),
            fetch: options.transport.fetch.bind(options.transport),
          });
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
    if (this.activeDispatch !== undefined)
      throw new Error("cannot recover callbacks during an active dispatch");
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

  /**
   * Drain due deliveries. Joining an active drain does not replace its owner's signal.
   * Cancellation waits for transport cleanup and durable settlement before rejecting;
   * callers must await this boundary before resetting or closing the world.
   */
  async dispatchDue(signal?: AbortSignal): Promise<CallbackDispatchResult> {
    signal?.throwIfAborted();
    if (this.activeDispatch !== undefined) return this.activeDispatch;
    // Publish ownership before a resolver can synchronously reenter dispatchDue.
    const active = Promise.resolve().then(() => this.performDispatchDue(signal));
    this.activeDispatch = active;
    try {
      return await active;
    } finally {
      if (this.activeDispatch === active) this.activeDispatch = undefined;
    }
  }

  private idempotencyKey(delivery: CallbackDelivery): string {
    if (this.idempotencyScope === undefined) return delivery.id;
    const applicableOverrides = [...new Set([delivery.callback.packageId, delivery.event.packageId])]
      .filter((packageId) => Object.hasOwn(this.idempotencyScopeByPackage, packageId))
      .sort(compareStableStrings)
      .map((packageId) => [packageId, this.idempotencyScopeByPackage[packageId]]);
    const identity =
      applicableOverrides.length === 0
        ? [this.idempotencyScope, delivery.id]
        : [this.idempotencyScope, delivery.id, applicableOverrides];
    return sha256(Buffer.from(JSON.stringify(identity), "utf8"));
  }

  private async performDispatchDue(signal: AbortSignal | undefined): Promise<CallbackDispatchResult> {
    const nowUs = this.store.metadata().virtualTimeUs;
    const outcomes: CallbackDispatchOutcome[] = [];
    while (true) {
      signal?.throwIfAborted();
      const delivery = this.store.nextCallbackDelivery(nowUs);
      if (delivery === null) break;
      const runtime = this.runtimes.get(
        runtimeKey(delivery.callback.packageId, delivery.callback.callbackId),
      );
      if (runtime === undefined) {
        const error = callbackError(
          "CALLBACK_RUNTIME_MISSING",
          `callback runtime ${delivery.callback.packageId}.${delivery.callback.callbackId} is unavailable`,
          false,
        );
        const failed = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(transaction.failCallbackDelivery(delivery.id, error)),
        ).value;
        outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
        continue;
      }

      const context = Object.freeze({ receiverId: delivery.receiverId });
      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), runtime.contract.timeoutMs);
      const requestSignal =
        signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
      // A synchronous codec cannot be preempted, but it must not send HTTP after
      // consuming the budget while the event loop could not run the timer.
      const refreshBudget = () => {
        if (performance.now() - startedAt >= runtime.contract.timeoutMs) controller.abort();
      };
      const checkBudget = () => {
        refreshBudget();
        requestSignal.throwIfAborted();
      };
      try {
        let receiver: CallbackReceiver | undefined;
        try {
          const resolved =
            this.resolveReceiver === undefined
              ? Object.hasOwn(this.receivers, delivery.receiverId)
                ? this.receivers[delivery.receiverId]
                : undefined
              : await this.resolveReceiver(context, requestSignal);
          checkBudget();
          if (resolved !== undefined) {
            if (typeof resolved !== "object" || resolved === null) throw new TypeError("invalid receiver");
            const { baseUrl, secret } = resolved;
            if (typeof baseUrl !== "string" || (secret !== undefined && typeof secret !== "string"))
              throw new TypeError("invalid receiver");
            receiver = Object.freeze({ baseUrl, ...(secret === undefined ? {} : { secret }) });
          }
          checkBudget();
        } catch {
          refreshBudget();
          signal?.throwIfAborted();
          const failure = callbackError(
            controller.signal.aborted ? "CALLBACK_RECEIVER_TIMEOUT" : "CALLBACK_RECEIVER_UNAVAILABLE",
            controller.signal.aborted
              ? "callback receiver resolution exceeded the callback timeout"
              : "callback receiver could not be resolved",
            false,
          );
          const failed = this.store.transact(delivery.correlationId, (transaction) =>
            callbackResult(transaction.failCallbackDelivery(delivery.id, failure)),
          ).value;
          outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
          continue;
        }
        if (receiver === undefined) {
          signal?.throwIfAborted();
          const error = callbackError(
            "CALLBACK_RECEIVER_MISSING",
            `callback receiver ${delivery.receiverId} was not configured for this drill`,
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
          prepared = prepareCallback(
            delivery,
            runtime,
            receiver,
            this.transport,
            this.idempotencyKey(delivery),
          );
          checkBudget();
        } catch (error) {
          refreshBudget();
          signal?.throwIfAborted();
          const failure = controller.signal.aborted
            ? callbackError(
                "CALLBACK_PREPARATION_TIMEOUT",
                "callback preparation exceeded the callback timeout",
                false,
              )
            : error instanceof CallbackPreparationError
              ? error.evidence
              : callbackError(
                  "CALLBACK_REQUEST_INVALID",
                  this.resolveReceiver === undefined && error instanceof Error
                    ? error.message
                    : "callback request preparation failed",
                  false,
                );
          const failed = this.store.transact(delivery.correlationId, (transaction) =>
            callbackResult(transaction.failCallbackDelivery(delivery.id, failure)),
          ).value;
          outcomes.push({ deliveryId: failed.id, attempt: failed.attemptCount, status: "failed" });
          continue;
        }

        signal?.throwIfAborted();
        const started = this.store.transact(delivery.correlationId, (transaction) =>
          callbackResult(transaction.startCallbackAttempt(delivery.id, prepared.evidence)),
        ).value;
        let response: CallbackResponseEvidence | undefined;
        let error: CallbackErrorEvidence | undefined;
        try {
          checkBudget();
          const request: RequestInit = {
            method: runtime.contract.method,
            headers: prepared.headers,
            body: prepared.body,
            redirect: "manual",
            signal: requestSignal,
          };
          const received =
            this.transport === undefined
              ? await this.fetchImplementation(prepared.url, request)
              : await this.transport.fetch(prepared.url, request, context);
          if (received.redirected) {
            await received.body?.cancel();
            throw new Error("callback transport followed a redirect");
          }
          response = await responseEvidence(received, requestSignal);
          checkBudget();
          if (response.status < 200 || response.status > 299) {
            error = callbackError(
              "CALLBACK_HTTP_REJECTED",
              `callback receiver returned HTTP ${String(response.status)}`,
              true,
            );
          }
        } catch (caught) {
          refreshBudget();
          const aborted = signal?.aborted === true;
          const timedOut = !aborted && controller.signal.aborted;
          error = callbackError(
            aborted
              ? "CALLBACK_ABORTED"
              : timedOut
                ? "CALLBACK_TIMEOUT"
                : caught instanceof RangeError
                  ? "CALLBACK_RESPONSE_TOO_LARGE"
                  : "CALLBACK_NETWORK_ERROR",
            aborted
              ? "callback delivery was interrupted; the receiver outcome may be unknown"
              : timedOut
                ? `callback receiver did not respond within ${String(runtime.contract.timeoutMs)} ms`
                : caught instanceof Error
                  ? caught.message
                  : "callback request failed",
            true,
          );
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
        signal?.throwIfAborted();
      } finally {
        clearTimeout(timeout);
      }
    }
    return { outcomes: Object.freeze(outcomes) };
  }
}
