import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  JsonObjectSchema,
  MAX_TOOL_UI_ASSETS,
  MAX_TOOL_UI_ASSET_BYTES,
  MAX_TOOL_UI_BYTES,
  ToolUiPathSchema,
  toolUiMediaType,
  type OperationOutcome,
} from "@firedrill-tools/contracts";
import type { ToolDefinition } from "@firedrill-tools/tool-sdk";
import type { BoundWorldClient } from "@firedrill-tools/world-kernel";
import { TOOL_UI_CLIENT_SOURCE } from "./tool-ui-client.js";

export interface ToolUiRevision {
  readonly generation: number;
  readonly evidenceSequence: number;
}

export interface StartToolUiBindingOptions {
  /** Only this actor-bound invocation facade is available to the app. */
  readonly client: Pick<BoundWorldClient, "invoke">;
  readonly tool: ToolDefinition;
  /** Verified immutable build bytes, never paths to a source directory. */
  readonly ui: {
    readonly packageId: string;
    readonly entry: string;
    readonly assets: readonly {
      readonly path: string;
      readonly mediaType: string;
      readonly artifactHash: string;
      readonly bytes: Uint8Array;
    }[];
  };
  readonly worldInstanceId: string;
  readonly actorId: string;
  /** Read-only revision hint; no state or evidence payload is exposed. */
  readonly getRevision?: () => ToolUiRevision;
}

export interface ToolUiBinding {
  readonly kind: "tool-ui";
  readonly packageId: string;
  readonly title: string;
  /** A separate ephemeral loopback origin with an app-scoped token in its fragment. */
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  connection: "close",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES)
    return Promise.reject(new RequestError(413, "request body exceeds 1 MiB"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
      request.off("aborted", aborted);
      request.setTimeout(0);
    };
    const fail = (reason: Error) => {
      cleanup();
      request.pause();
      reject(reason);
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) fail(new RequestError(413, "request body exceeds 1 MiB"));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const error = () => fail(new RequestError(400, "request body could not be read"));
    const aborted = () => fail(new RequestError(400, "request was aborted"));
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    request.once("aborted", aborted);
    request.setTimeout(10_000, () => fail(new RequestError(408, "request body timed out")));
  });
}

function outcomeStatus(outcome: OperationOutcome): number {
  if (outcome.status === "ok") return 200;
  if (outcome.status === "denied") return 403;
  if (outcome.status === "unsupported") return 404;
  if (outcome.status === "invalid") return 400;
  return 422;
}

/** Own origin and own credential per app. This is trusted local UI code, not a process sandbox. */
export async function startToolUiBinding(options: StartToolUiBindingOptions): Promise<ToolUiBinding> {
  const packageId = options.tool.manifest.id;
  const title = packageId;
  if (options.ui.packageId !== packageId) throw new TypeError("Tool UI package does not match its Tool");
  const entry = ToolUiPathSchema.parse(options.ui.entry);
  if (toolUiMediaType(entry) !== "text/html; charset=utf-8")
    throw new TypeError("Tool UI entry must be HTML");
  if (options.ui.assets.length === 0 || options.ui.assets.length > MAX_TOOL_UI_ASSETS)
    throw new TypeError("Tool UI asset count exceeds its bound");
  const assets = new Map<string, { bytes: Buffer; mediaType: string }>();
  let total = 0;
  for (const asset of options.ui.assets) {
    const path = ToolUiPathSchema.parse(asset.path);
    const mediaType = toolUiMediaType(path);
    if (mediaType === undefined || mediaType !== asset.mediaType || assets.has(path))
      throw new TypeError("Tool UI asset type or path is invalid");
    if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength > MAX_TOOL_UI_ASSET_BYTES)
      throw new TypeError("Tool UI asset exceeds its byte bound");
    total += asset.bytes.byteLength;
    if (total > MAX_TOOL_UI_BYTES) throw new TypeError("Tool UI exceeds its total byte bound");
    // Copy once: mutating a caller-owned Uint8Array cannot replace served reviewed bytes.
    const bytes = Buffer.from(asset.bytes);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.artifactHash)
      throw new TypeError("Tool UI asset integrity mismatch");
    assets.set(path, { bytes, mediaType });
  }
  if (!assets.has(entry)) throw new TypeError("Tool UI entry asset is missing");
  const operations = new Set(options.tool.manifest.operations.map((operation) => operation.id));
  const token = randomBytes(32).toString("base64url");
  const credential = Buffer.from(`Bearer ${token}`);
  let origin = "";
  let authority = "";
  let closed = false;
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closed) {
      json(response, 410, { schemaVersion: 1, error: "Tool app is closed" });
      return;
    }
    // The inspector may open an app in a new top-level tab. This grants no API access.
    const raw = request.url ?? "/";
    const path = raw.split("?")[0] ?? "";
    const topLevelHtmlNavigation =
      request.method === "GET" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document" &&
      assets.get(path === "/" ? entry : path.slice(1))?.mediaType === "text/html; charset=utf-8";
    const site = request.headers["sec-fetch-site"];
    if (
      request.headers.host !== authority ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (site !== undefined && site !== "same-origin" && site !== "none" && !topLevelHtmlNavigation)
    ) {
      json(response, 421, { schemaVersion: 1, error: "request host or origin does not match this Tool app" });
      return;
    }
    // Match immutable asset keys directly. URL normalization must not hide traversal attempts.
    if (
      raw.length > 4096 ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[%\\]/.test(path) ||
      Array.from(path).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      json(response, 400, { schemaVersion: 1, error: "invalid app path" });
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && path === "/_firedrill/client.js") {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/javascript; charset=utf-8",
        "content-length": Buffer.byteLength(TOOL_UI_CLIENT_SOURCE),
      });
      response.end(request.method === "HEAD" ? undefined : TOOL_UI_CLIENT_SOURCE);
      return;
    }
    if (path === "/_firedrill/context" || path === "/_firedrill/invoke") {
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== credential.length || !timingSafeEqual(actual, credential)) {
        json(response, 401, { schemaVersion: 1, error: "invalid Tool app token" });
        return;
      }
      if (request.method === "GET" && path === "/_firedrill/context") {
        const revision = options.getRevision?.();
        json(response, 200, {
          schemaVersion: 1,
          worldInstanceId: options.worldInstanceId,
          actorId: options.actorId,
          packageId,
          title,
          ...(revision === undefined ? {} : { revision }),
        });
        return;
      }
      if (request.method !== "POST" || path !== "/_firedrill/invoke") {
        json(response, 405, { schemaVersion: 1, error: "method not allowed" });
        return;
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
        request.headers["content-encoding"] !== undefined
      )
        throw new RequestError(415, "Tool invocation requires uncompressed application/json");
      let value: unknown;
      try {
        value = JSON.parse((await readBody(request)).toString("utf8"));
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(400, "request body must be valid JSON");
      }
      if (closed) throw new RequestError(410, "Tool app is closed");
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new RequestError(400, "request body must be an object");
      const body = value as Record<string, unknown>;
      if (
        Object.keys(body).some((key) => !["operationId", "arguments", "idempotencyKey"].includes(key)) ||
        typeof body.operationId !== "string" ||
        (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string")
      )
        throw new RequestError(
          400,
          "request accepts only operationId, arguments and optional idempotencyKey",
        );
      const arguments_ = JsonObjectSchema.safeParse(body.arguments);
      if (!arguments_.success) throw new RequestError(400, "arguments must be a JSON object");
      if (!operations.has(body.operationId))
        throw new RequestError(404, "operation is not declared by this Tool");
      const result = options.client.invoke(
        { packageId, operationId: body.operationId },
        arguments_.data,
        body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey },
      );
      json(response, outcomeStatus(result.outcome), {
        schemaVersion: 1,
        callId: result.invocation.callId,
        correlationId: result.invocation.correlationId,
        outcome: result.outcome,
      });
      return;
    }
    const asset = assets.get(path === "/" ? entry : path.slice(1));
    if (asset === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
      json(response, 404, { schemaVersion: 1, error: "app route not found" });
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": asset.mediaType,
      "content-length": asset.bytes.length,
    });
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  };
  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 15_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void route(request, response).catch((error: unknown) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        json(response, error instanceof RequestError ? error.status : 500, {
          schemaVersion: 1,
          error: error instanceof RequestError ? error.message : "Tool app request failed",
        });
      });
    },
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Tool app did not receive a loopback address");
  }
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    kind: "tool-ui",
    packageId,
    title,
    url: `${origin}/${entry}#token=${token}`,
    close() {
      closed = true;
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
      return closing;
    },
  });
}
