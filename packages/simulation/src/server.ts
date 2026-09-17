import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { ErrorEnvelope } from "@firedrill-tools/contracts";
import { FiredrillProjectError } from "@firedrill-tools/sdk";
import { ZodError } from "zod";
import {
  CompareSimulationRunsSchema,
  SimulationApiErrorSchema,
  SimulationRunRequestListSchema,
  StartSimulationRunSchema,
} from "./contracts.js";
import {
  LocalSimulationError,
  LocalSimulationSupervisor,
  type LocalSimulationSupervisorOptions,
} from "./supervisor.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface StartLocalSimulationServerOptions extends LocalSimulationSupervisorOptions {
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly token?: string;
}

export interface LocalSimulationServer {
  readonly baseUrl: string;
  readonly token: string;
  readonly supervisor: LocalSimulationSupervisor;
  close(): Promise<void>;
}

export interface LocalSimulationRequestContext {
  readonly token: string;
  readonly url: URL;
}

export type LocalSimulationRequestFallback = (
  request: IncomingMessage,
  response: ServerResponse,
  context: LocalSimulationRequestContext,
) => void | Promise<void>;

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

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function writeHtml(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(value);
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new LocalSimulationError(
      415,
      "framework.INVALID_CONTENT_TYPE",
      "request content-type must be application/json",
    );
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  let oversized = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
  let bytes = 0;
  const chunks: Buffer[] = [];
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
    throw new LocalSimulationError(413, "framework.REQUEST_TOO_LARGE", "request body exceeds 64 KiB");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LocalSimulationError(400, "framework.INVALID_JSON", "request body must be valid JSON");
  }
}

function errorResponse(error: unknown): { readonly status: number; readonly value: unknown } {
  if (error instanceof LocalSimulationError) {
    return {
      status: error.status,
      value: SimulationApiErrorSchema.parse({ schemaVersion: 1, error: error.envelope }),
    };
  }
  if (error instanceof FiredrillProjectError) {
    const envelope: ErrorEnvelope = {
      schemaVersion: 1,
      code: error.code,
      source: "framework",
      message: error.message,
      retryable: false,
      issues: error.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        ...(diagnostic.suggestion === undefined ? {} : { suggestion: diagnostic.suggestion }),
      })),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
    };
    return { status: 422, value: SimulationApiErrorSchema.parse({ schemaVersion: 1, error: envelope }) };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      value: SimulationApiErrorSchema.parse({
        schemaVersion: 1,
        error: {
          schemaVersion: 1,
          code: "framework.INVALID_ARGUMENT",
          source: "framework",
          message: "request parameters are invalid",
          retryable: false,
          issues: error.issues.map((issue) => ({
            code: "framework.INVALID_ARGUMENT",
            message: issue.message,
            path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
          })),
        },
      }),
    };
  }
  return {
    status: 500,
    value: SimulationApiErrorSchema.parse({
      schemaVersion: 1,
      error: {
        schemaVersion: 1,
        code: "framework.INTERNAL_ERROR",
        source: "framework",
        message: "local simulation request failed",
        retryable: false,
        issues: [],
      },
    }),
  };
}

function integerParameter(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new LocalSimulationError(400, "framework.INVALID_ARGUMENT", `${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new LocalSimulationError(
      400,
      "framework.INVALID_ARGUMENT",
      `${name} exceeds the supported integer range`,
    );
  }
  return parsed;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new LocalSimulationError(400, "framework.INVALID_ARGUMENT", "route identifier is malformed");
  }
}

/**
 * Creates the canonical loopback request handler used by both the headless
 * control server and same-origin local interfaces. A fallback may serve fixed
 * local assets after Firedrill has validated the loopback host and origin.
 */
export function createLocalSimulationRequestHandler(
  supervisor: LocalSimulationSupervisor,
  token: string,
  fallback?: LocalSimulationRequestFallback,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!validRequestOrigin(request)) {
        throw new LocalSimulationError(
          421,
          "framework.LOOPBACK_REQUIRED",
          "request host and origin must be loopback",
        );
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { schemaVersion: 1, status: "ready" });
        return;
      }
      if (!url.pathname.startsWith("/api/") && fallback !== undefined) {
        await fallback(request, response, { token, url });
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        response.setHeader("www-authenticate", 'Bearer realm="Firedrill local simulation"');
        throw new LocalSimulationError(
          401,
          "framework.CONTROL_UNAUTHORIZED",
          "invalid local simulation token",
        );
      }
      if (request.method === "GET" && url.pathname === "/api/v1/project") {
        writeJson(response, 200, supervisor.project());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/project/refresh") {
        writeJson(response, 200, await supervisor.refreshProject());
        return;
      }
      const sourceMatch = /^\/api\/v1\/sources\/(world|scenario|tool|drill|suite|target)\/([^/]+)$/.exec(
        url.pathname,
      );
      const toolSourceMatch = /^\/api\/v1\/tools\/([^/]+)\/implementation\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && toolSourceMatch !== null) {
        writeJson(
          response,
          200,
          supervisor.toolSource(decoded(toolSourceMatch[1] ?? ""), decoded(toolSourceMatch[2] ?? "")),
        );
        return;
      }
      if (request.method === "GET" && sourceMatch !== null) {
        writeJson(response, 200, supervisor.source(sourceMatch[1] ?? "", decoded(sourceMatch[2] ?? "")));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/runs") {
        if (
          [...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "limit") ||
          url.searchParams.getAll("cursor").length > 1 ||
          url.searchParams.getAll("limit").length > 1
        ) {
          throw new LocalSimulationError(
            400,
            "framework.INVALID_ARGUMENT",
            "saved-run query accepts one cursor and one limit",
          );
        }
        const cursor = url.searchParams.get("cursor");
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^[1-9]\d*$/.test(limit)) {
          throw new LocalSimulationError(
            400,
            "framework.INVALID_ARGUMENT",
            "saved-run limit must be an integer from 1 through 500",
          );
        }
        writeJson(
          response,
          200,
          supervisor.listRuns({
            ...(cursor === null ? {} : { cursor }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/runs") {
        const input = StartSimulationRunSchema.parse(await requestJson(request));
        writeJson(response, 202, supervisor.startRun(input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/comparisons") {
        const input = CompareSimulationRunsSchema.parse(await requestJson(request));
        writeJson(response, 200, supervisor.compare(input.baselineRunId, input.candidateRunId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/run-requests") {
        writeJson(
          response,
          200,
          SimulationRunRequestListSchema.parse({
            schemaVersion: 1,
            requests: supervisor.listRunRequests(),
          }),
        );
        return;
      }
      const requestMatch = /^\/api\/v1\/run-requests\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && requestMatch !== null) {
        writeJson(response, 200, supervisor.runRequest(decoded(requestMatch[1] ?? "")));
        return;
      }
      const cancelMatch = /^\/api\/v1\/run-requests\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch !== null) {
        writeJson(response, 202, supervisor.cancelRunRequest(decoded(cancelMatch[1] ?? "")));
        return;
      }
      const evidenceMatch = /^\/api\/v1\/runs\/([^/]+)\/evidence$/.exec(url.pathname);
      if (request.method === "GET" && evidenceMatch !== null) {
        writeJson(
          response,
          200,
          supervisor.evidence(
            decoded(evidenceMatch[1] ?? ""),
            integerParameter(url.searchParams.get("from"), 1, "from"),
            integerParameter(url.searchParams.get("limit"), 200, "limit"),
          ),
        );
        return;
      }
      const stateMatch = /^\/api\/v1\/runs\/([^/]+)\/state$/.exec(url.pathname);
      if (request.method === "GET" && stateMatch !== null) {
        const packageId = url.searchParams.get("packageId");
        const namespace = url.searchParams.get("namespace");
        const afterRowId = url.searchParams.get("after");
        if (packageId === null || namespace === null) {
          throw new LocalSimulationError(
            400,
            "framework.INVALID_ARGUMENT",
            "state queries require packageId and namespace",
          );
        }
        writeJson(
          response,
          200,
          supervisor.state(decoded(stateMatch[1] ?? ""), packageId, namespace, {
            ...(afterRowId === null ? {} : { afterRowId }),
            limit: integerParameter(url.searchParams.get("limit"), 100, "limit"),
          }),
        );
        return;
      }
      const reportMatch = /^\/api\/v1\/runs\/([^/]+)\/report$/.exec(url.pathname);
      if (request.method === "GET" && reportMatch !== null) {
        writeHtml(response, supervisor.reportHtml(decoded(reportMatch[1] ?? "")));
        return;
      }
      const attachmentsMatch = /^\/api\/v1\/runs\/([^/]+)\/report\/attachments$/.exec(url.pathname);
      if (request.method === "GET" && attachmentsMatch !== null) {
        writeJson(response, 200, supervisor.reportAttachments(decoded(attachmentsMatch[1] ?? "")));
        return;
      }
      const attachmentMatch = /^\/api\/v1\/runs\/([^/]+)\/report\/attachments\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && attachmentMatch !== null) {
        const file = supervisor.reportAttachment(
          decoded(attachmentMatch[1] ?? ""),
          decoded(attachmentMatch[2] ?? ""),
        );
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": file.body.byteLength,
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${file.name}"`,
          "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(file.body);
        return;
      }
      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch !== null) {
        writeJson(response, 200, supervisor.run(decoded(runMatch[1] ?? "")));
        return;
      }
      throw new LocalSimulationError(404, "framework.ROUTE_NOT_FOUND", "route not found");
    } catch (error) {
      const failure = errorResponse(error);
      writeJson(response, failure.status, failure.value);
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startLocalSimulationServer(
  options: StartLocalSimulationServerOptions = {},
): Promise<LocalSimulationServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (token.length < 24 || token.length > 256 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new TypeError("local simulation token must contain 24 through 256 HTTP-header-safe characters");
  }
  const supervisor = await LocalSimulationSupervisor.create(options);
  const server = createServer(createLocalSimulationRequestHandler(supervisor, token));
  try {
    await listen(server, port, hostname);
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await supervisor.close();
    await closeServer(server);
    throw new Error("local simulation server has no TCP address");
  }
  const baseUrl = `http://${hostname === "::1" ? `[${hostname}]` : hostname}:${address.port}`;
  let closed = false;
  return {
    baseUrl,
    token,
    supervisor,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await supervisor.close();
    },
  };
}
