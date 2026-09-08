import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalWorld, LocalWorldBinding, LocalWorldCall, LocalWorldDescription } from "@firedrill/sdk";
import { FiredrillProjectError } from "@firedrill/sdk";
import { redactEnvironmentValue } from "./environment-redaction.js";

/** The caller owns this runtime and its listeners; closing the inspector does not stop them. */
export interface LocalInspectorEnvironment {
  readonly world: LocalWorld;
  readonly binding?: LocalWorldBinding;
}

export interface LocalEnvironmentConnection {
  readonly protocol: "http" | "mcp" | "cli";
  readonly url: string;
  readonly actorId: string;
}

export type LocalEnvironmentStatus =
  | { readonly schemaVersion: 1; readonly available: false }
  | {
      readonly schemaVersion: 1;
      readonly available: true;
      readonly metadata: ReturnType<LocalWorld["metadata"]>;
      readonly description: LocalWorldDescription;
      readonly connections: readonly LocalEnvironmentConnection[];
      readonly agentTested: false;
      readonly source: "live_environment";
    };

const BASE = "/api/environment";
const MAX_BODY_BYTES = 64 * 1024;
const PROTOCOLS = ["http", "mcp", "cli"] as const;

class EnvironmentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new EnvironmentRequestError(400, "framework.INVALID_ARGUMENT", message);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("request contains unknown fields");
}

function integer(value: string | null, fallback: number, name: string, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > maximum)
    invalid(`${name} must be an integer from 1 through ${maximum}`);
  return parsed;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function authenticate(request: IncomingMessage, token: string): void {
  let host: URL;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`);
  } catch {
    throw new EnvironmentRequestError(421, "framework.LOOPBACK_REQUIRED", "request host must be loopback");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) ||
    Number(host.port || 80) !== request.socket.localPort ||
    host.username !== "" ||
    host.password !== "" ||
    host.pathname !== "/" ||
    host.search !== "" ||
    host.hash !== ""
  )
    throw new EnvironmentRequestError(
      421,
      "framework.LOOPBACK_REQUIRED",
      "request host must match this loopback listener",
    );
  const origin = request.headers.origin;
  if ((origin !== undefined && origin !== host.origin) || request.headers["sec-fetch-site"] === "cross-site")
    throw new EnvironmentRequestError(
      421,
      "framework.SAME_ORIGIN_REQUIRED",
      "environment control requires the inspector's exact origin",
    );
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new EnvironmentRequestError(401, "framework.CONTROL_UNAUTHORIZED", "invalid local inspector token");
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new EnvironmentRequestError(
      415,
      "framework.INVALID_CONTENT_TYPE",
      "request content-type must be application/json",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    oversized ||= bytes > MAX_BODY_BYTES;
    if (!oversized) chunks.push(buffer);
  }
  if (oversized)
    throw new EnvironmentRequestError(413, "framework.REQUEST_TOO_LARGE", "request body exceeds 64 KiB");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EnvironmentRequestError(400, "framework.INVALID_JSON", "request body must be valid JSON");
  }
  if (!object(value)) invalid("request body must be an object");
  return value;
}

function connections(binding: LocalWorldBinding | undefined): readonly LocalEnvironmentConnection[] {
  if (binding === undefined) return [];
  return PROTOCOLS.flatMap((protocol) => {
    const endpoint = binding[protocol];
    return endpoint === undefined ? [] : [{ protocol, url: endpoint.url, actorId: binding.actorId }];
  });
}

/** Handles only the additive live runtime routes. Source and drill-report routes remain separate. */
export function createLocalEnvironmentRequestHandler(
  environment: LocalInspectorEnvironment | undefined,
  token: string,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    try {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        invalid("request URL is invalid");
      }
      if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
      authenticate(request, token);
      if (request.method === "GET" && url.pathname === BASE && environment === undefined) {
        writeJson(response, 200, { schemaVersion: 1, available: false } satisfies LocalEnvironmentStatus);
        return true;
      }
      if (environment === undefined)
        throw new EnvironmentRequestError(
          404,
          "framework.ENVIRONMENT_NOT_RUNNING",
          "start firedrill serve to inspect a live synthetic environment",
        );
      const { world, binding } = environment;
      const description = world.describe();
      const secrets = [token, ...PROTOCOLS.flatMap((protocol) => binding?.[protocol]?.token ?? [])];
      const redact = (value: unknown) => redactEnvironmentValue(value, description.tools, secrets);
      const metadata = world.metadata();
      const assertCurrentGeneration = () => {
        if (world.describe().generation !== description.generation)
          throw new EnvironmentRequestError(
            409,
            "framework.ENVIRONMENT_RESET",
            "the live environment was reset while this request was uploading; reload before retrying",
          );
      };
      const common = {
        schemaVersion: 1,
        worldInstanceId: metadata.worldInstanceId,
        generation: description.generation,
        source: "live_environment",
      };
      const generation = url.searchParams.get("generation");
      if (generation !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(generation) || !Number.isSafeInteger(Number(generation)))
          invalid("generation must be a non-negative safe integer");
        if (Number(generation) !== description.generation)
          throw new EnvironmentRequestError(
            409,
            "framework.ENVIRONMENT_RESET",
            "the live environment was reset; reload its status and restart pagination",
          );
      }
      if (request.method === "GET" && url.pathname === BASE) {
        writeJson(response, 200, {
          schemaVersion: 1,
          available: true,
          metadata,
          description: { ...description, actors: redact(description.actors) },
          connections: connections(binding),
          agentTested: false,
          source: "live_environment",
        });
      } else if (request.method === "GET" && url.pathname === `${BASE}/connections`) {
        // Deliberate reveal only: credentials never appear in status, activity, or error responses.
        writeJson(response, 200, {
          ...common,
          connections: connections(binding).map((connection) => ({
            ...connection,
            token: binding?.[connection.protocol]?.token,
          })),
          environment: binding?.environment ?? {},
        });
      } else if (request.method === "GET" && url.pathname === `${BASE}/tools`) {
        writeJson(response, 200, { ...common, buildHash: description.buildHash, tools: description.tools });
      } else if (request.method === "GET" && url.pathname === `${BASE}/state`) {
        const packageId = url.searchParams.get("packageId");
        const namespace = url.searchParams.get("namespace");
        if (packageId === null || namespace === null) invalid("packageId and namespace are required");
        if (
          !description.tools.some(
            (tool) => tool.packageId === packageId && tool.stateNamespaces.includes(namespace),
          )
        )
          throw new EnvironmentRequestError(
            404,
            "framework.STATE_NAMESPACE_NOT_FOUND",
            "state namespace is not declared by this running world",
          );
        const limit = integer(url.searchParams.get("limit"), 100, "limit", 1000);
        const afterRowId = url.searchParams.get("afterRowId");
        if (afterRowId !== null && (afterRowId.length < 1 || afterRowId.length > 512))
          invalid("afterRowId must contain from 1 through 512 characters");
        const rows = world.state({
          packageId,
          namespace,
          limit: limit + 1,
          ...(afterRowId === null ? {} : { afterRowId }),
        });
        const records = rows.slice(0, limit);
        writeJson(response, 200, {
          ...common,
          packageId,
          namespace,
          records: redact(records),
          ...(rows.length > limit ? { nextRowId: records.at(-1)?.rowId } : {}),
          redaction: "sensitive_fields",
        });
      } else if (request.method === "GET" && url.pathname === `${BASE}/activity`) {
        const fromSequence = integer(
          url.searchParams.get("fromSequence"),
          1,
          "fromSequence",
          Number.MAX_SAFE_INTEGER,
        );
        const limit = integer(url.searchParams.get("limit"), 200, "limit", 1000);
        const entries = world.evidence({ fromSequence, limit });
        writeJson(response, 200, {
          ...common,
          fromSequence,
          entries: redact(
            entries.map((entry) => ({
              ...entry,
              initiator: entry.correlationId.startsWith("corr_local_operator_")
                ? "operator"
                : entry.kind === "operation"
                  ? "binding"
                  : "world",
            })),
          ),
          nextSequence: (entries.at(-1)?.sequence ?? fromSequence - 1) + 1,
          redaction: "sensitive_fields",
          agentTested: false,
        });
      } else if (request.method === "POST" && url.pathname === `${BASE}/call`) {
        const body = await requestJson(request);
        assertCurrentGeneration();
        exactKeys(body, ["actorId", "packageId", "operationId", "arguments", "idempotencyKey"]);
        if (
          typeof body.actorId !== "string" ||
          typeof body.packageId !== "string" ||
          typeof body.operationId !== "string"
        )
          invalid("actorId, packageId, and operationId are required strings");
        const result = world.call(body as unknown as LocalWorldCall);
        writeJson(response, 200, {
          ...common,
          initiator: "operator",
          result: redact(result),
          agentTested: false,
        });
      } else if (request.method === "POST" && url.pathname === `${BASE}/reset`) {
        const body = await requestJson(request);
        assertCurrentGeneration();
        exactKeys(body, ["worldInstanceId", "packages"]);
        if (body.worldInstanceId !== metadata.worldInstanceId)
          throw new EnvironmentRequestError(
            409,
            "framework.WORLD_CONFIRMATION_REQUIRED",
            "confirm the exact running worldInstanceId before resetting live state",
          );
        if (
          body.packages !== undefined &&
          (!Array.isArray(body.packages) || !body.packages.every((value) => typeof value === "string"))
        )
          invalid("packages must be an array of Tool package ids");
        const result = world.reset(
          body.packages === undefined ? {} : { packages: body.packages as string[] },
        );
        writeJson(response, 200, {
          ...common,
          generation: world.describe().generation,
          initiator: "operator",
          result,
          agentTested: false,
        });
      } else {
        throw new EnvironmentRequestError(
          404,
          "framework.ROUTE_NOT_FOUND",
          "local environment route not found",
        );
      }
    } catch (error) {
      const known = error instanceof EnvironmentRequestError || error instanceof FiredrillProjectError;
      const status =
        error instanceof EnvironmentRequestError
          ? error.status
          : error instanceof FiredrillProjectError
            ? 422
            : 500;
      if (status === 401) response.setHeader("www-authenticate", 'Bearer realm="Firedrill local inspector"');
      const credentials = [
        token,
        ...PROTOCOLS.flatMap((protocol) => environment?.binding?.[protocol]?.token ?? []),
      ];
      writeJson(
        response,
        status,
        redactEnvironmentValue(
          {
            schemaVersion: 1,
            error: {
              schemaVersion: 1,
              source: "framework",
              code: known ? error.code : "framework.INTERNAL_ERROR",
              message: known ? error.message : "local environment request failed",
              retryable: false,
              issues: [],
            },
          },
          [],
          credentials,
        ),
      );
    }
    return true;
  };
}
