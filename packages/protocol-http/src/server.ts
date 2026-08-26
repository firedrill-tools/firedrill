import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { JsonObjectSchema } from "@firedrill/contracts";
import type { JsonObject, OperationOutcome } from "@firedrill/contracts";
import type { ToolDefinition } from "@firedrill/tool-sdk";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import {
  WireRequestError,
  invokeWireRoute,
  matchWireRoute,
  registerWireRoutes,
  wireMethodsForPath,
  wireRouteAuthorized,
  writeWireResponse,
} from "./wire.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface StartHttpWorldBindingOptions {
  readonly client: BoundWorldClient;
  readonly tools: readonly ToolDefinition[];
  /** Internal composition seam used by protocol wrappers that need only the generic operation surface. */
  readonly syntheticRoutes?: boolean;
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly token?: string;
}

export interface HttpWorldBinding {
  readonly kind: "http";
  readonly baseUrl: string;
  readonly token: string;
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

interface OperationRequest {
  readonly arguments: JsonObject;
  readonly idempotencyKey?: string;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function loopbackHostname(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "[::1]" || value === "::1";
}

function validRequestOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    if (!loopbackHostname(new URL(`http://${host}`).hostname)) return false;
  } catch {
    return false;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return loopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setWireAuthenticationChallenge(
  response: ServerResponse,
  auth: ToolDefinition["manifest"]["http"][number]["auth"],
): void {
  if (auth.kind === "bearer") {
    response.setHeader("www-authenticate", 'Bearer realm="Firedrill synthetic API"');
  } else if (auth.kind === "basic") {
    response.setHeader("www-authenticate", 'Basic realm="Firedrill synthetic API", charset="UTF-8"');
  }
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  let oversized = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      oversized = true;
      continue;
    }
    if (!oversized) chunks.push(buffer);
  }
  if (oversized) {
    throw new RangeError("request body exceeds 1 MiB");
  }
  return Buffer.concat(chunks);
}

async function operationRequest(request: IncomingMessage): Promise<OperationRequest> {
  const bytes = await requestBody(request);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "arguments" && key !== "idempotencyKey")) {
    throw new TypeError("request body accepts only arguments and idempotencyKey");
  }
  const arguments_ = JsonObjectSchema.parse(record.arguments);
  if (record.idempotencyKey !== undefined && typeof record.idempotencyKey !== "string") {
    throw new TypeError("idempotencyKey must be a string");
  }
  return {
    arguments: arguments_,
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
  };
}

function outcomeStatus(outcome: OperationOutcome): number {
  if (outcome.status === "ok") return 200;
  if (outcome.status === "denied") return 403;
  if (outcome.status === "unsupported") return 404;
  if (outcome.status === "invalid") return 400;
  return 422;
}

function toolIndex(tools: readonly ToolDefinition[]) {
  return tools.map((tool) => ({
    id: tool.manifest.id,
    version: tool.manifest.version,
    operations: tool.manifest.operations.map((operation) => ({
      id: operation.id,
      ...(operation.description === undefined ? {} : { description: operation.description }),
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
      idempotency: operation.idempotency,
      fidelity: operation.fidelity,
    })),
  }));
}

function handler(options: {
  readonly client: BoundWorldClient;
  readonly tools: readonly ToolDefinition[];
  readonly token: string;
  readonly syntheticRoutes: boolean;
}) {
  const wireRoutes = registerWireRoutes(options.syntheticRoutes ? options.tools : []);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!validRequestOrigin(request)) {
      writeJson(response, 421, { schemaVersion: 1, error: "request host or origin is not loopback" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const wire = matchWireRoute(wireRoutes, request.method, url.pathname);
    if (wire !== undefined) {
      if (!wireRouteAuthorized(request, url, wire.route, options.token)) {
        setWireAuthenticationChallenge(response, wire.route.contract.auth);
        writeJson(response, 401, {
          schemaVersion: 1,
          code: "framework.HTTP_UNAUTHORIZED",
          error: "invalid synthetic API credential",
        });
        return;
      }
      try {
        writeWireResponse(
          response,
          await invokeWireRoute({ match: wire, request, url, client: options.client }),
        );
      } catch (error) {
        writeJson(response, error instanceof WireRequestError ? error.status : 500, {
          schemaVersion: 1,
          code: error instanceof WireRequestError ? error.code : "framework.HTTP_RESPONSE_MAPPING_FAILED",
          error: error instanceof WireRequestError ? error.message : "synthetic API response mapping failed",
        });
      }
      return;
    }
    const allowedWireMethods = wireMethodsForPath(wireRoutes, url.pathname);
    if (allowedWireMethods.length > 0) {
      response.setHeader("allow", allowedWireMethods.join(", "));
      writeJson(response, 405, {
        schemaVersion: 1,
        code: "framework.HTTP_METHOD_NOT_ALLOWED",
        error: "method is not allowed for this synthetic API route",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { schemaVersion: 1, status: "ready" });
      return;
    }
    if (!authorized(request.headers.authorization, options.token)) {
      response.setHeader("www-authenticate", 'Bearer realm="Firedrill local world"');
      writeJson(response, 401, { schemaVersion: 1, error: "invalid world token" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tools") {
      writeJson(response, 200, { schemaVersion: 1, tools: toolIndex(options.tools) });
      return;
    }
    const match = /^\/v1\/operations\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || match === null) {
      writeJson(response, 404, { schemaVersion: 1, error: "route not found" });
      return;
    }
    try {
      const packageId = decodeURIComponent(match[1] ?? "");
      const operationId = decodeURIComponent(match[2] ?? "");
      const body = await operationRequest(request);
      const result = options.client.invoke(
        { packageId, operationId },
        body.arguments,
        body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey },
      );
      writeJson(response, outcomeStatus(result.outcome), {
        schemaVersion: 1,
        callId: result.invocation.callId,
        correlationId: result.invocation.correlationId,
        outcome: result.outcome,
      });
    } catch (error) {
      writeJson(response, error instanceof RangeError ? 413 : 400, {
        schemaVersion: 1,
        error: error instanceof Error ? error.message : "invalid request",
      });
    }
  };
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startHttpWorldBinding(
  options: StartHttpWorldBindingOptions,
): Promise<HttpWorldBinding> {
  const hostname = options.hostname ?? "127.0.0.1";
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (token.length < 16) throw new TypeError("world token must contain at least 16 characters");
  const routeHandler = handler({
    client: options.client,
    tools: options.tools,
    token,
    syntheticRoutes: options.syntheticRoutes ?? true,
  });
  const server = createServer((request, response) => {
    void routeHandler(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { schemaVersion: 1, error: "binding failed" });
      else response.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await listen(server, options.port ?? 0, hostname);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("HTTP world binding did not receive a TCP address");
  }
  const displayHost = hostname === "::1" ? "[::1]" : hostname;
  const baseUrl = `http://${displayHost}:${address.port}`;
  let closed = false;
  return {
    kind: "http",
    baseUrl,
    token,
    environment: Object.freeze({
      FIREDRILL_HTTP_URL: baseUrl,
      FIREDRILL_HTTP_TOKEN: token,
    }),
    async close() {
      if (closed) return;
      closed = true;
      await close(server);
    },
  };
}
