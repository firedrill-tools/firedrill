import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type {
  JsonObject,
  JsonValue,
  OperationContract,
  OperationOutcome,
  OperationRef,
  ToolPackageManifest,
} from "@firedrill-tools/contracts";
import {
  FIREDRILL_FRAMEWORK_VERSION,
  JsonObjectSchema,
  JsonValueSchema,
  McpToolAliasSchema,
} from "@firedrill-tools/contracts";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { BaseContext, CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

const EXPLICIT_IDEMPOTENCY_KEY = "dev.firedrill/idempotency-key";
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpWorldClient {
  invoke(
    operation: OperationRef,
    arguments_: JsonObject,
    options?: { readonly idempotencyKey?: string },
  ): { readonly outcome: OperationOutcome } | Promise<{ readonly outcome: OperationOutcome }>;
}

export interface McpWorldHandler {
  fetch(request: Request, options?: { readonly parsedBody?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export interface CreateMcpWorldHandlerOptions {
  readonly client: McpWorldClient;
  readonly tools: readonly Pick<ToolPackageManifest, "id" | "operations">[];
  /** Stable, non-secret scope separating request-derived idempotency keys. */
  readonly bindingScope: string;
}

export interface StartMcpWorldBindingOptions {
  readonly client: McpWorldClient;
  readonly tools: readonly ToolPackageManifest[];
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly token?: string;
}

export interface McpWorldBinding {
  readonly kind: "mcp";
  readonly url: string;
  readonly token: string;
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

interface RegisteredOperation {
  readonly packageId: string;
  readonly operation: OperationContract;
  readonly toolName: string;
  readonly description?: string;
}

/**
 * MCP tool names remain readable and deterministic while preserving the Tool
 * package boundary. Package ids cannot contain dots, so the mapping is unique.
 */
export function mcpToolName(packageId: string, operationId: string): string {
  return `${packageId}.${operationId}`;
}

function operations(
  tools: readonly Pick<ToolPackageManifest, "id" | "operations">[],
): readonly RegisteredOperation[] {
  const names = new Set<string>();
  const registered: RegisteredOperation[] = [];
  for (const tool of tools) {
    for (const operation of tool.operations) {
      const toolName = mcpToolName(tool.id, operation.id);
      if (names.has(toolName)) throw new TypeError(`duplicate MCP tool name ${toolName}`);
      names.add(toolName);
      registered.push({
        packageId: tool.id,
        operation,
        toolName,
        ...(operation.description === undefined ? {} : { description: operation.description }),
      });
    }
  }
  // Reserve every canonical name first so aliases cannot steal another operation.
  for (const tool of tools) {
    for (const operation of tool.operations) {
      if (operation.mcp === undefined) continue;
      const alias = McpToolAliasSchema.parse(operation.mcp);
      if (alias.name === mcpToolName(tool.id, operation.id)) continue;
      if (names.has(alias.name)) throw new TypeError(`duplicate MCP tool name ${alias.name}`);
      names.add(alias.name);
      const description = alias.description ?? operation.description;
      registered.push({
        packageId: tool.id,
        operation,
        toolName: alias.name,
        ...(description === undefined ? {} : { description }),
      });
    }
  }
  return registered;
}

function explicitIdempotencyKey(context: BaseContext): string | undefined {
  const value = context.mcpReq._meta?.[EXPLICIT_IDEMPOTENCY_KEY];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new TypeError(`${EXPLICIT_IDEMPOTENCY_KEY} must be a non-empty string of at most 255 characters`);
  }
  return value;
}

function requestIdempotencyKey(context: BaseContext, bindingScope: string): string {
  return `mcp_${createHash("sha256")
    .update("firedrill.mcp.idempotency.v1\0")
    .update(bindingScope)
    .update("\0")
    .update(context.sessionId ?? "stateless")
    .update("\0")
    .update(JSON.stringify(context.mcpReq.id))
    .digest("hex")}`;
}

function callOptions(
  operation: OperationContract,
  context: BaseContext,
  bindingScope: string,
): { readonly idempotencyKey?: string } {
  const explicit = explicitIdempotencyKey(context);
  if (operation.idempotency === "none") {
    if (explicit !== undefined) {
      throw new TypeError(`${operation.id} does not accept an idempotency key`);
    }
    return {};
  }
  if (explicit !== undefined) return { idempotencyKey: explicit };
  if (operation.idempotency === "required") {
    return { idempotencyKey: requestIdempotencyKey(context, bindingScope) };
  }
  return {};
}

function toolResult(value: JsonValue): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(value: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

function buildServer(
  client: McpWorldClient,
  registered: readonly RegisteredOperation[],
  bindingScope: string,
): McpServer {
  const server = new McpServer({
    name: "firedrill-local-world",
    version: FIREDRILL_FRAMEWORK_VERSION,
  });
  for (const item of registered) {
    server.registerTool(
      item.toolName,
      {
        ...(item.description === undefined ? {} : { description: item.description }),
        inputSchema: fromJsonSchema(item.operation.inputSchema),
        outputSchema: fromJsonSchema(item.operation.outputSchema),
      },
      async (argumentsInput, context) => {
        try {
          const arguments_ = JsonObjectSchema.parse(argumentsInput);
          const result = await client.invoke(
            { packageId: item.packageId, operationId: item.operation.id },
            arguments_,
            callOptions(item.operation, context, bindingScope),
          );
          if (result.outcome.status === "ok") {
            return toolResult(JsonValueSchema.parse(result.outcome.value));
          }
          return toolError(
            JsonObjectSchema.parse({
              schemaVersion: 1,
              status: result.outcome.status,
              error: result.outcome.error,
            }),
          );
        } catch (error) {
          return toolError(
            JsonObjectSchema.parse({
              schemaVersion: 1,
              status: "invalid",
              error: {
                schemaVersion: 1,
                code: "framework.BINDING_INVALID_REQUEST",
                source: "framework",
                message: error instanceof Error ? error.message : "invalid MCP tool call",
                retryable: false,
                issues: [],
              },
            }),
          );
        }
      },
    );
  }
  return server;
}

function authorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

async function parsedRequestBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) throw new RangeError("request body exceeds 1 MiB");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("request body must be valid JSON");
  }
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
    server.closeAllConnections();
  });
}

function requestHandler(options: {
  readonly handler: McpWorldHandler;
  readonly token: string;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const handleMcp = toNodeHandler(options.handler);
  return async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { schemaVersion: 1, status: "ready" });
      return;
    }
    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { schemaVersion: 1, error: "route not found" });
      return;
    }
    if (!authorized(request.headers.authorization, options.token)) {
      response.setHeader("www-authenticate", 'Bearer realm="Firedrill local world"');
      writeJson(response, 401, { schemaVersion: 1, error: "invalid world token" });
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = request.method === "POST" ? await parsedRequestBody(request) : undefined;
    } catch (error) {
      writeJson(response, error instanceof RangeError ? 413 : 400, {
        schemaVersion: 1,
        error: error instanceof Error ? error.message : "invalid request",
      });
      return;
    }
    // The SDK's structural Node request type declares optional fields without
    // `undefined`, which is not directly assignable from Node's own type when
    // exactOptionalPropertyTypes is enabled. The runtime shapes are identical.
    await handleMcp(
      request as unknown as Parameters<typeof handleMcp>[0],
      response as unknown as Parameters<typeof handleMcp>[1],
      parsedBody,
    );
  };
}

/**
 * Embeds the canonical MCP operation adapter in an existing HTTP server.
 * The caller owns authentication, origin checks, body limits and request-time
 * authorization. Supply only the permitted Tool surface and an actor-bound client.
 */
export function createMcpWorldHandler(options: CreateMcpWorldHandlerOptions): McpWorldHandler {
  if (options.bindingScope.length === 0 || options.bindingScope.length > 1024)
    throw new TypeError("MCP binding scope must contain between 1 and 1024 characters");
  const registered = operations(options.tools);
  const handler = createMcpHandler(() => buildServer(options.client, registered, options.bindingScope));
  return { fetch: handler.fetch, close: handler.close };
}

export async function startMcpWorldBinding(options: StartMcpWorldBindingOptions): Promise<McpWorldBinding> {
  const hostname = options.hostname ?? "127.0.0.1";
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (token.length < 16) throw new TypeError("world token must contain at least 16 characters");
  const bindingScope = createHash("sha256").update(token).digest("hex");
  const handler = createMcpWorldHandler({ client: options.client, tools: options.tools, bindingScope });
  const serve = requestHandler({ handler, token });
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { schemaVersion: 1, error: "binding failed" });
      else response.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  try {
    await listen(server, options.port ?? 0, hostname);
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    await handler.close();
    throw new Error("MCP world binding did not receive a TCP address");
  }
  const displayHost = hostname === "::1" ? "[::1]" : hostname;
  const url = `http://${displayHost}:${address.port}/mcp`;
  let closing: Promise<void> | undefined;
  return {
    kind: "mcp",
    url,
    token,
    environment: Object.freeze({
      FIREDRILL_MCP_URL: url,
      FIREDRILL_MCP_TOKEN: token,
    }),
    close() {
      closing ??= (async () => {
        try {
          // Closing the MCP handler terminates active Streamable HTTP/SSE
          // sessions. The TCP server can then drain instead of waiting forever
          // on a client-held stream.
          await handler.close();
        } finally {
          await closeServer(server);
        }
      })();
      return closing;
    },
  };
}
