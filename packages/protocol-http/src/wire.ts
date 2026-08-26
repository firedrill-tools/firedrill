import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  JsonObjectSchema,
  JsonValueSchema,
  httpPathParameter,
  httpPathSegments,
  httpRoutesOverlap,
} from "@firedrill/contracts";
import type { HttpRouteAuth, HttpRouteContract, OperationOutcome } from "@firedrill/contracts";
import type {
  ToolDefinition,
  ToolHttpRequest,
  ToolHttpRequestBody,
  ToolHttpResponse,
} from "@firedrill/tool-sdk";
import type { BoundWorldClient, KernelInvocationResult } from "@firedrill/world-kernel";

export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

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

interface RegisteredRoute {
  readonly packageId: string;
  readonly contract: HttpRouteContract;
  readonly codec: ToolDefinition["http"][string];
  readonly segments: readonly string[];
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
  const path: Record<string, string> = {};
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
      routes.push({
        packageId: tool.manifest.id,
        contract,
        codec,
        segments: httpPathSegments(contract.path),
      });
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
  request: IncomingMessage,
  auth: HttpRouteAuth,
): Readonly<Record<string, readonly string[]>> {
  const headers: Record<string, string[]> = {};
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
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
  const query: Record<string, string[]> = {};
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
  if (auth.kind === "bearer") {
    const header = request.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ")
      ? equalSecret(header.slice("Bearer ".length), token)
      : false;
  }
  if (auth.kind === "header") {
    const header = request.headers[auth.name.toLowerCase()];
    const value = Array.isArray(header) ? one(header) : header;
    return value !== undefined && equalSecret(value, token);
  }
  if (auth.kind === "query") {
    const values = url.searchParams.getAll(auth.name);
    return values.length === 1 && equalSecret(values[0] ?? "", token);
  }
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (auth.token === "username") return equalSecret(username, token);
  return auth.username === username && equalSecret(password, token);
}

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
    request.resume();
    throw new WireRequestError("framework.HTTP_BODY_TOO_LARGE", 413, "request body exceeds 1 MiB");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      request.resume();
      throw new WireRequestError("framework.HTTP_BODY_TOO_LARGE", 413, "request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function mediaType(request: IncomingMessage): string | undefined {
  const value = request.headers["content-type"];
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(";", 1)[0]?.trim().toLowerCase();
}

async function requestBody(
  request: IncomingMessage,
  kind: HttpRouteContract["requestBody"],
): Promise<ToolHttpRequestBody> {
  const bytes = await requestBytes(request);
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
    const type = mediaType(request);
    if (type !== "application/json" && !type?.endsWith("+json")) {
      throw new WireRequestError(
        "framework.HTTP_CONTENT_TYPE_UNSUPPORTED",
        415,
        "request content type must be JSON",
      );
    }
    try {
      return { kind: "json", value: JsonValueSchema.parse(JSON.parse(bytes.toString("utf8"))) };
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
  if (mediaType(request) !== "application/x-www-form-urlencoded") {
    throw new WireRequestError(
      "framework.HTTP_CONTENT_TYPE_UNSUPPORTED",
      415,
      "request content type must be application/x-www-form-urlencoded",
    );
  }
  const form: Record<string, string[]> = {};
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
    return {
      bytes: Buffer.from(body.value, "utf8"),
      contentType: body.contentType ?? "text/plain; charset=utf-8",
    };
  }
  return { bytes: Buffer.from(body.value), contentType: body.contentType };
}

function responseHeaders(response: ToolHttpResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_RESPONSE_HEADERS.has(lower)) {
      throw new TypeError(`HTTP route codec returned forbidden response header ${name}`);
    }
    if (value.includes("\r") || value.includes("\n")) {
      throw new TypeError(`HTTP route codec returned an invalid value for header ${name}`);
    }
    headers[lower] = value;
  }
  return headers;
}

export async function invokeWireRoute(input: {
  readonly match: MatchedWireRoute;
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly client: BoundWorldClient;
}): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}> {
  const { route } = input.match;
  const request: ToolHttpRequest = {
    routeId: route.contract.id,
    method: route.contract.method,
    pathname: input.url.pathname,
    path: input.match.path,
    query: requestQuery(input.url, route.contract.auth),
    headers: requestHeaderValues(input.request, route.contract.auth),
    body: await requestBody(input.request, route.contract.requestBody),
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
  const result: KernelInvocationResult = input.client.invoke(
    { packageId: route.packageId, operationId: route.contract.operationId },
    operationInput.arguments,
    operationInput.idempotencyKey === undefined ? {} : { idempotencyKey: operationInput.idempotencyKey },
  );
  const encoded = route.codec.encode({ invocation: result.invocation, outcome: result.outcome });
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
