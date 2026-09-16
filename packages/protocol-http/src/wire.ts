import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateHeaderValue } from "node:http";
import type {
  HttpRouteAuth,
  HttpRouteContract,
  JsonValue,
  OperationOutcome,
  OperationRef,
} from "@firedrill/contracts";
import {
  httpPathParameter,
  httpPathSegments,
  httpRoutesOverlap,
  JsonObjectSchema,
  JsonValueSchema,
} from "@firedrill/contracts";
import type {
  ToolDefinition,
  ToolHttpOperationResult,
  ToolHttpRequest,
  ToolHttpRequestBody,
  ToolHttpResponse,
} from "@firedrill/tool-sdk";
import type { BoundWorldClient } from "@firedrill/world-kernel";

export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
export const MAX_HTTP_RESPONSE_HEADERS = 64;
export const MAX_HTTP_RESPONSE_HEADER_BYTES = 16 * 1024;

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export class WireRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "WireRequestError";
    this.code = code;
    this.status = status;
  }
}

export interface RegisteredRoute {
  readonly packageId: string;
  readonly contract: HttpRouteContract;
  readonly codec: ToolDefinition["http"][string];
  readonly segments: readonly string[];
}

/** Received wire data, before decoding. The host owns bounded I/O and cancellation. */
export interface HttpWireRequest {
  readonly method: string;
  readonly url: URL;
  /** Header pairs retain duplicate values; names are normalized before decoding. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface HttpWireResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type HttpWireInvoke = (
  operation: OperationRef,
  arguments_: ReturnType<typeof JsonObjectSchema.parse>,
  options: { readonly idempotencyKey?: string },
) => ToolHttpOperationResult | Promise<ToolHttpOperationResult>;

export interface HttpWireAuthority {
  readonly operation: OperationRef;
  readonly contract: HttpRouteContract;
}

export interface MatchedWireRoute {
  readonly route: RegisteredRoute;
  readonly path: Readonly<Record<string, string>>;
}

function matchWirePath(
  route: RegisteredRoute,
  concrete: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (route.segments.length !== concrete.length) return undefined;
  const path: Record<string, string> = Object.create(null);
  for (const [index, expected] of route.segments.entries()) {
    const actual = concrete[index];
    if (actual === undefined) return undefined;
    const parameter = httpPathParameter(expected);
    if (parameter === undefined) {
      if (expected !== actual) return undefined;
    } else {
      path[parameter] = actual;
    }
  }
  return Object.freeze(path);
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function decodePathSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.includes("/") || decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function concretePathSegments(pathname: string): readonly string[] | undefined {
  if (pathname === "/") return [];
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of pathname.slice(1).split("/")) {
    const decoded = decodePathSegment(segment);
    if (decoded === undefined || decoded.length === 0) return undefined;
    segments.push(decoded);
  }
  return segments;
}

export function registerWireRoutes(tools: readonly ToolDefinition[]): readonly RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const tool of tools) {
    for (const contract of tool.manifest.http) {
      const codec = tool.http[contract.id];
      if (codec === undefined) {
        throw new TypeError(`Tool ${tool.manifest.id} has no codec for HTTP route ${contract.id}`);
      }
      const conflict = routes.find((candidate) => httpRoutesOverlap(candidate.contract, contract));
      if (conflict !== undefined) {
        throw new TypeError(
          `HTTP route ${tool.manifest.id}.${contract.id} overlaps ${conflict.packageId}.${conflict.contract.id}`,
        );
      }
      const immutableContract = Object.freeze({
        ...contract,
        auth: Object.freeze({
          ...contract.auth,
          ...(contract.auth.kind === "bearer" ? { schemes: Object.freeze([...contract.auth.schemes]) } : {}),
        }),
        response: Object.freeze({
          ...contract.response,
          errors: Object.freeze(contract.response.errors.map((error) => Object.freeze({ ...error }))),
        }),
      }) as HttpRouteContract;
      routes.push(
        Object.freeze({
          packageId: tool.manifest.id,
          contract: immutableContract,
          codec: Object.freeze({ decode: codec.decode, encode: codec.encode }),
          segments: Object.freeze([...httpPathSegments(contract.path)]),
        }),
      );
    }
  }
  return Object.freeze(routes);
}

export function matchWireRoute(
  routes: readonly RegisteredRoute[],
  method: string | undefined,
  pathname: string,
): MatchedWireRoute | undefined {
  const concrete = concretePathSegments(pathname);
  if (concrete === undefined) return undefined;
  for (const route of routes) {
    if (route.contract.method !== method) continue;
    const path = matchWirePath(route, concrete);
    if (path !== undefined) return { route, path };
  }
  return undefined;
}

export function wireMethodsForPath(routes: readonly RegisteredRoute[], pathname: string): readonly string[] {
  const concrete = concretePathSegments(pathname);
  if (concrete === undefined) return [];
  return Object.freeze(
    routes
      .filter((route) => matchWirePath(route, concrete) !== undefined)
      .map((route) => route.contract.method)
      .sort(),
  );
}

function requestHeaderValues(
  pairs: readonly (readonly [string, string])[],
  auth: HttpRouteAuth,
): Readonly<Record<string, readonly string[]>> {
  const headers: Record<string, string[]> = Object.create(null);
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    const values = headers[name] ?? [];
    values.push(value);
    headers[name] = values;
  }
  if (auth.kind === "bearer" || auth.kind === "basic") delete headers.authorization;
  if (auth.kind === "header") delete headers[auth.name.toLowerCase()];
  return Object.freeze(
    Object.fromEntries(Object.entries(headers).map(([name, values]) => [name, Object.freeze(values)])),
  );
}

function requestQuery(url: URL, auth: HttpRouteAuth): Readonly<Record<string, readonly string[]>> {
  const query: Record<string, string[]> = Object.create(null);
  for (const [name, value] of url.searchParams) {
    const values = query[name] ?? [];
    values.push(value);
    query[name] = values;
  }
  if (auth.kind === "query") delete query[auth.name];
  return Object.freeze(
    Object.fromEntries(Object.entries(query).map(([name, values]) => [name, Object.freeze(values)])),
  );
}

function one(values: readonly string[] | undefined): string | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

export function wireRouteAuthorized(
  request: IncomingMessage,
  url: URL,
  route: RegisteredRoute,
  token: string,
): boolean {
  const auth = route.contract.auth;
  if (auth.kind === "none") return true;
  const actual = credentialFromHeaders(request.headers, url, auth);
  return actual !== undefined && equalSecret(actual, token);
}

function credentialFromHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  url: URL,
  auth: HttpRouteAuth,
): string | undefined {
  const header = (name: string) => {
    const values = headers[name];
    return typeof values === "string" ? values : one(values);
  };
  if (auth.kind === "none") return undefined;
  if (auth.kind === "bearer") {
    const value = header("authorization");
    if (value === undefined) return undefined;
    const separator = value.indexOf(" ");
    if (separator <= 0) return undefined;
    const scheme = value.slice(0, separator).toLowerCase();
    return auth.schemes.some((candidate) => candidate.toLowerCase() === scheme)
      ? value.slice(separator + 1)
      : undefined;
  }
  if (auth.kind === "header") return header(auth.name.toLowerCase());
  if (auth.kind === "query") {
    const values = url.searchParams.getAll(auth.name);
    return one(values);
  }
  const value = header("authorization");
  if (value === undefined || !value.startsWith("Basic ")) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (auth.token === "username") return username;
  return auth.username === username ? password : undefined;
}

/** Extracts only the authored API credential; this does not authenticate a host or select a world. */
export function httpWireCredential(
  request: Pick<HttpWireRequest, "headers" | "url">,
  auth: HttpRouteAuth,
): string | undefined {
  return credentialFromHeaders(requestHeaderValues(request.headers, { kind: "none" }), request.url, auth);
}

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  let oversized = Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      oversized = true;
      continue;
    }
    if (!oversized) chunks.push(buffer);
  }
  if (oversized) {
    throw new WireRequestError("framework.HTTP_BODY_TOO_LARGE", 413, "request body exceeds 1 MiB");
  }
  return Buffer.concat(chunks);
}

function mediaType(header: string | undefined): string | undefined {
  return header?.split(";", 1)[0]?.trim().toLowerCase();
}

/**
 * JSON bodies can legitimately be deeper than the schema used by an authored
 * Tool. Validate the transport shape iteratively so the host does not exhaust
 * the JavaScript stack before the Tool's own codec can apply its limits.
 */
function parseJsonBody(bytes: Buffer): JsonValue {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (Number.isFinite(current)) continue;
      throw new TypeError("JSON numbers must be finite");
    }
    if (typeof current !== "object") throw new TypeError("request body contains a non-JSON value");
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    for (const child of Object.values(current)) pending.push(child);
  }
  return value as JsonValue;
}

function requestBody(
  bytes: Buffer,
  contentType: string | undefined,
  kind: HttpRouteContract["requestBody"],
): ToolHttpRequestBody {
  if (kind === "none") {
    if (bytes.length > 0) {
      throw new WireRequestError(
        "framework.HTTP_BODY_NOT_ALLOWED",
        400,
        "this route does not accept a request body",
      );
    }
    return { kind: "none" };
  }
  if (kind === "json") {
    const type = mediaType(contentType);
    if (type !== "application/json" && !type?.endsWith("+json")) {
      throw new WireRequestError(
        "framework.HTTP_CONTENT_TYPE_UNSUPPORTED",
        415,
        "request content type must be JSON",
      );
    }
    try {
      return { kind: "json", value: parseJsonBody(bytes) };
    } catch {
      throw new WireRequestError("framework.HTTP_BODY_INVALID", 400, "request body must be valid JSON");
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WireRequestError("framework.HTTP_BODY_INVALID", 400, "request body must be valid UTF-8");
  }
  if (kind === "text") return { kind: "text", value: text };
  if (mediaType(contentType) !== "application/x-www-form-urlencoded") {
    throw new WireRequestError(
      "framework.HTTP_CONTENT_TYPE_UNSUPPORTED",
      415,
      "request content type must be application/x-www-form-urlencoded",
    );
  }
  const form: Record<string, string[]> = Object.create(null);
  for (const [name, value] of new URLSearchParams(text)) {
    const values = form[name] ?? [];
    values.push(value);
    form[name] = values;
  }
  return {
    kind: "form",
    value: Object.freeze(
      Object.fromEntries(Object.entries(form).map(([name, values]) => [name, Object.freeze(values)])),
    ),
  };
}

function decodedOperationInput(value: unknown): {
  readonly arguments: ReturnType<typeof JsonObjectSchema.parse>;
  readonly idempotencyKey?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireRequestError(
      "framework.HTTP_CODEC_INVALID",
      400,
      "HTTP route decoder must return an operation input object",
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "arguments" && key !== "idempotencyKey")) {
    throw new WireRequestError(
      "framework.HTTP_CODEC_INVALID",
      400,
      "HTTP route decoder returned unsupported operation input fields",
    );
  }
  let arguments_: ReturnType<typeof JsonObjectSchema.parse>;
  try {
    arguments_ = JsonObjectSchema.parse(record.arguments);
  } catch {
    throw new WireRequestError(
      "framework.HTTP_CODEC_INVALID",
      400,
      "HTTP route decoder returned invalid operation arguments",
    );
  }
  if (
    record.idempotencyKey !== undefined &&
    (typeof record.idempotencyKey !== "string" ||
      record.idempotencyKey.length === 0 ||
      record.idempotencyKey.length > 255)
  ) {
    throw new WireRequestError(
      "framework.HTTP_CODEC_INVALID",
      400,
      "HTTP route decoder returned an invalid idempotency key",
    );
  }
  return {
    arguments: arguments_,
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
  };
}

function outcomeStatus(route: HttpRouteContract, outcome: OperationOutcome): number {
  if (outcome.status === "ok") return route.response.successStatus;
  if (outcome.status === "invalid") return 400;
  if (outcome.status === "denied") return 403;
  if (outcome.status === "unsupported") return 404;
  const code = outcome.error?.source === "tool" ? outcome.error.code.replace(/^tool\./, "") : undefined;
  return route.response.errors.find((mapping) => mapping.code === code)?.status ?? 500;
}

function responseBytes(response: ToolHttpResponse): {
  readonly bytes: Buffer;
  readonly contentType?: string;
} {
  const body = response.body;
  if (body.kind === "empty") return { bytes: Buffer.alloc(0) };
  if (body.kind === "json") {
    const bytes = Buffer.from(`${JSON.stringify(JsonValueSchema.parse(body.value))}\n`, "utf8");
    return { bytes, contentType: "application/json; charset=utf-8" };
  }
  if (body.kind === "text") {
    if (body.contentType !== undefined) validateResponseContentType(body.contentType);
    return {
      bytes: Buffer.from(body.value, "utf8"),
      contentType: body.contentType ?? "text/plain; charset=utf-8",
    };
  }
  validateResponseContentType(body.contentType);
  return { bytes: Buffer.from(body.value), contentType: body.contentType };
}

function validateResponseContentType(value: string): void {
  if (value.length === 0 || value.length > 1024) {
    throw new TypeError("HTTP route codec returned an invalid response content type");
  }
  validateHeaderValue("content-type", value);
}

function responseHeaders(response: ToolHttpResponse): Record<string, string> {
  const entries = Object.entries(response.headers ?? {});
  if (entries.length > MAX_HTTP_RESPONSE_HEADERS) {
    throw new TypeError(`HTTP route codec returned more than ${MAX_HTTP_RESPONSE_HEADERS} headers`);
  }
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_RESPONSE_HEADERS.has(lower)) {
      throw new TypeError(`HTTP route codec returned forbidden response header ${name}`);
    }
    if (value.includes("\r") || value.includes("\n")) {
      throw new TypeError(`HTTP route codec returned an invalid value for header ${name}`);
    }
    validateHeaderValue(name, value);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > MAX_HTTP_RESPONSE_HEADER_BYTES) {
      throw new TypeError("HTTP route codec response headers exceed 16 KiB");
    }
    headers[lower] = value;
  }
  return headers;
}

export async function invokeWireRoute(input: {
  readonly match: MatchedWireRoute;
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly client: Pick<BoundWorldClient, "invoke">;
}): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}> {
  const headers: Array<readonly [string, string]> = [];
  for (let index = 0; index < input.request.rawHeaders.length; index += 2) {
    const name = input.request.rawHeaders[index];
    const value = input.request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.push([name, value]);
  }
  const response = await invokeHttpWireRoute({
    match: input.match,
    request: {
      method: input.request.method ?? "",
      url: input.url,
      headers,
      body: await requestBytes(input.request),
    },
    // The loopback server already enforced Host/Origin and authored route auth.
    authorize: () => true,
    invoke: (operation, arguments_, options) => input.client.invoke(operation, arguments_, options),
  });
  return { ...response, body: Buffer.from(response.body) };
}

/**
 * Runs the canonical codec pipeline without a listener or a kernel owner.
 * The host must authorize the immutable declared operation before any codec
 * executes, then enforce current actor/world authority again when invoking it.
 * Authored API auth and platform routing authority are independent: this strips
 * only the declared API credential. Remove any separate host credential first.
 */
export async function invokeHttpWireRoute(input: {
  readonly match: MatchedWireRoute;
  readonly request: HttpWireRequest;
  readonly authorize: (authority: HttpWireAuthority) => boolean | Promise<boolean>;
  readonly invoke: HttpWireInvoke;
  readonly signal?: AbortSignal;
}): Promise<HttpWireResponse> {
  const signal = input.signal;
  signal?.throwIfAborted();
  const route = input.match.route;
  const authorize = input.authorize;
  const invoke = input.invoke;
  const url = new URL(input.request.url.href);
  const concrete = concretePathSegments(url.pathname);
  const path = concrete === undefined ? undefined : matchWirePath(route, concrete);
  if (input.request.method !== route.contract.method || path === undefined) {
    throw new WireRequestError("framework.HTTP_ROUTE_MISMATCH", 400, "request does not match its HTTP route");
  }
  if (input.request.body.byteLength > MAX_HTTP_BODY_BYTES) {
    throw new WireRequestError("framework.HTTP_BODY_TOO_LARGE", 413, "request body exceeds 1 MiB");
  }
  // Snapshot caller-owned data before awaiting authorization. Neither the caller
  // nor an asynchronous authorizer can retarget the selected operation/request.
  const bytes = Buffer.from(input.request.body);
  const pairs = input.request.headers.map(([name, value]): readonly [string, string] => [name, value]);
  const receivedHeaders = requestHeaderValues(pairs, { kind: "none" });
  const operation = Object.freeze({ packageId: route.packageId, operationId: route.contract.operationId });
  const authority = Object.freeze({ operation, contract: route.contract });
  const authorized = await authorize(authority);
  signal?.throwIfAborted();
  if (authorized !== true) {
    throw new WireRequestError("framework.HTTP_UNAUTHORIZED", 401, "HTTP route is not authorized");
  }
  const request: ToolHttpRequest = {
    routeId: route.contract.id,
    method: route.contract.method,
    pathname: url.pathname,
    path,
    query: requestQuery(url, route.contract.auth),
    headers: requestHeaderValues(pairs, route.contract.auth),
    body: requestBody(bytes, receivedHeaders["content-type"]?.[0], route.contract.requestBody),
  };
  let operationInput: ReturnType<typeof decodedOperationInput>;
  try {
    operationInput = decodedOperationInput(route.codec.decode(request));
  } catch (error) {
    if (error instanceof WireRequestError) throw error;
    throw new WireRequestError(
      "framework.HTTP_REQUEST_MAPPING_FAILED",
      400,
      error instanceof Error
        ? `HTTP route could not decode the request: ${error.message}`
        : "HTTP route could not decode the request",
    );
  }
  signal?.throwIfAborted();
  const result = await invoke(
    operation,
    operationInput.arguments,
    operationInput.idempotencyKey === undefined ? {} : { idempotencyKey: operationInput.idempotencyKey },
  );
  signal?.throwIfAborted();
  if (
    result.invocation.operation.packageId !== operation.packageId ||
    result.invocation.operation.operationId !== operation.operationId
  ) {
    throw new TypeError("HTTP route invocation returned a different operation");
  }
  const encoded = route.codec.encode({ invocation: result.invocation, outcome: result.outcome });
  signal?.throwIfAborted();
  const status = outcomeStatus(route.contract, result.outcome);
  const encodedBody = responseBytes(encoded);
  if ((status === 204 || status === 205) && encodedBody.bytes.length > 0) {
    throw new TypeError(`HTTP route ${route.packageId}.${route.contract.id} returned a body for ${status}`);
  }
  if (encodedBody.bytes.length > MAX_HTTP_BODY_BYTES) {
    throw new TypeError(`HTTP route ${route.packageId}.${route.contract.id} response exceeds 1 MiB`);
  }
  const headers = responseHeaders(encoded);
  if (encodedBody.contentType !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = encodedBody.contentType;
  }
  return { status, headers, body: encodedBody.bytes };
}

export function writeWireResponse(
  response: ServerResponse,
  value: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer;
  },
): void {
  response.writeHead(value.status, {
    ...value.headers,
    "cache-control": "no-store",
    connection: "close",
    "content-length": value.body.length,
    "x-content-type-options": "nosniff",
  });
  response.end(value.body);
}
