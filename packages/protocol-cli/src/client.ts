import type { JsonObject, OperationOutcome, ToolPackageManifest } from "@firedrill-run/contracts";
import {
  CallIdSchema,
  CorrelationIdSchema,
  JsonObjectSchema,
  OperationIdSchema,
  OperationOutcomeSchema,
  PackageIdSchema,
} from "@firedrill-run/contracts";
import { FIREDRILL_CLI_TOKEN, FIREDRILL_CLI_URL } from "./binding.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class CliWorldError extends Error {
  readonly code:
    | "framework.CLI_BINDING_MISSING"
    | "framework.CLI_BINDING_INVALID"
    | "framework.CLI_REQUEST_FAILED"
    | "framework.CLI_RESPONSE_INVALID";
  readonly details: Readonly<JsonObject>;

  constructor(code: CliWorldError["code"], message: string, details: JsonObject = {}) {
    super(message);
    this.name = "CliWorldError";
    this.code = code;
    this.details = details;
  }
}

export interface CliWorldConnection {
  readonly baseUrl: string;
  readonly token: string;
}

export interface CliToolOperation {
  readonly id: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly idempotency: "none" | "optional" | "required";
  readonly fidelity: ToolPackageManifest["operations"][number]["fidelity"];
}

export interface CliToolSummary {
  readonly id: string;
  readonly version: string;
  readonly operations: readonly CliToolOperation[];
}

export interface CliOperationResult {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly correlationId: string;
  readonly outcome: OperationOutcome;
}

function loopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliWorldError(
      "framework.CLI_BINDING_INVALID",
      `${FIREDRILL_CLI_URL} must contain a valid loopback HTTP URL`,
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CliWorldError(
      "framework.CLI_BINDING_INVALID",
      `${FIREDRILL_CLI_URL} must be an uncredentialed loopback HTTP origin`,
    );
  }
  return url;
}

export function cliWorldConnection(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CliWorldConnection {
  const baseUrl = environment[FIREDRILL_CLI_URL];
  const token = environment[FIREDRILL_CLI_TOKEN];
  if (baseUrl === undefined || token === undefined) {
    throw new CliWorldError(
      "framework.CLI_BINDING_MISSING",
      "no active CLI world binding; run this command from an agent target whose bindings include cli",
      {
        missing: [
          ...(baseUrl === undefined ? [FIREDRILL_CLI_URL] : []),
          ...(token === undefined ? [FIREDRILL_CLI_TOKEN] : []),
        ],
      },
    );
  }
  if (token.length < 16) {
    throw new CliWorldError(
      "framework.CLI_BINDING_INVALID",
      `${FIREDRILL_CLI_TOKEN} is not a valid world token`,
    );
  }
  return { baseUrl: loopbackUrl(baseUrl).origin, token };
}

async function boundedBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CliWorldError(
      "framework.CLI_RESPONSE_INVALID",
      "world response exceeds the 1 MiB local CLI limit",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new CliWorldError(
      "framework.CLI_RESPONSE_INVALID",
      "world response exceeds the 1 MiB local CLI limit",
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "world response is not valid JSON");
  }
}

async function request(
  path: string,
  options: {
    readonly connection?: CliWorldConnection;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly method?: "GET" | "POST";
    readonly body?: JsonObject;
    /** Operation failures are typed outcomes even when HTTP carries a non-2xx classification. */
    readonly acceptNonOk?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const connection = options.connection ?? cliWorldConnection(options.environment);
  const base = loopbackUrl(connection.baseUrl);
  const url = new URL(path, base);
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${connection.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const body = await boundedBody(response);
  if (!response.ok && options.acceptNonOk !== true) {
    throw new CliWorldError("framework.CLI_REQUEST_FAILED", `world returned HTTP ${response.status}`, {
      status: response.status,
      response: JsonObjectSchema.safeParse(body).success ? (body as JsonObject) : {},
    });
  }
  return { response, body };
}

function toolSummaries(value: unknown): readonly CliToolSummary[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "Tool index response must be an object");
  }
  const tools = (value as { readonly tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "Tool index response has no tools array");
  }
  return tools.map((candidate): CliToolSummary => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "Tool index contains an invalid Tool");
    }
    const record = candidate as Record<string, unknown>;
    const id = PackageIdSchema.safeParse(record.id);
    const version = typeof record.version === "string" ? record.version : undefined;
    if (!id.success || version === undefined || !Array.isArray(record.operations)) {
      throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "Tool index contains an invalid Tool");
    }
    const operations = record.operations.map((operation): CliToolOperation => {
      if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
        throw new CliWorldError("framework.CLI_RESPONSE_INVALID", `Tool ${id.data} has an invalid operation`);
      }
      const item = operation as Record<string, unknown>;
      const operationId = OperationIdSchema.safeParse(item.id);
      const inputSchema = JsonObjectSchema.safeParse(item.inputSchema);
      const outputSchema = JsonObjectSchema.safeParse(item.outputSchema);
      const idempotency = item.idempotency;
      const fidelity = item.fidelity;
      if (
        !operationId.success ||
        !inputSchema.success ||
        !outputSchema.success ||
        !["none", "optional", "required"].includes(String(idempotency)) ||
        !["contract", "stateful", "behavioral", "validated"].includes(String(fidelity))
      ) {
        throw new CliWorldError(
          "framework.CLI_RESPONSE_INVALID",
          `Tool ${id.data} has an invalid operation contract`,
        );
      }
      return {
        id: operationId.data,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        inputSchema: inputSchema.data,
        outputSchema: outputSchema.data,
        idempotency: idempotency as CliToolOperation["idempotency"],
        fidelity: fidelity as CliToolOperation["fidelity"],
      };
    });
    return { id: id.data, version, operations };
  });
}

export async function listCliWorldTools(
  options: {
    readonly connection?: CliWorldConnection;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<readonly CliToolSummary[]> {
  const response = await request("/v1/tools", options);
  return toolSummaries(response.body);
}

export async function invokeCliWorldOperation(options: {
  readonly packageId: string;
  readonly operationId: string;
  readonly arguments?: JsonObject;
  readonly idempotencyKey?: string;
  readonly connection?: CliWorldConnection;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<CliOperationResult> {
  const packageId = PackageIdSchema.parse(options.packageId);
  const operationId = OperationIdSchema.parse(options.operationId);
  const arguments_ = JsonObjectSchema.parse(options.arguments ?? {});
  const body = await request(
    `/v1/operations/${encodeURIComponent(packageId)}/${encodeURIComponent(operationId)}`,
    {
      method: "POST",
      acceptNonOk: true,
      body: {
        arguments: arguments_,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      },
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (typeof body.body !== "object" || body.body === null || Array.isArray(body.body)) {
    throw new CliWorldError("framework.CLI_RESPONSE_INVALID", "operation response must be an object");
  }
  const record = body.body as Record<string, unknown>;
  const callId = CallIdSchema.safeParse(record.callId);
  const correlationId = CorrelationIdSchema.safeParse(record.correlationId);
  const outcome = OperationOutcomeSchema.safeParse(record.outcome);
  if (!callId.success || !correlationId.success || !outcome.success) {
    throw new CliWorldError(
      "framework.CLI_RESPONSE_INVALID",
      "operation response does not match the Firedrill contract",
    );
  }
  return {
    schemaVersion: 1,
    callId: callId.data,
    correlationId: correlationId.data,
    outcome: outcome.data,
  };
}
