import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ErrorEnvelope,
  JsonObject,
  JsonValue,
  RunCaptureHandle,
  TargetDescriptor,
  TargetFileAttachment,
  TargetInvocation,
  TargetResult,
} from "@firedrill/contracts";
import {
  JsonValueSchema,
  TargetDescriptorSchema,
  TargetFileAttachmentSchema,
  TargetInvocationSchema,
  TargetResultSchema,
} from "@firedrill/contracts";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { tsImport } from "tsx/esm/api";
import { boundedDiagnosticMessage } from "./diagnostics.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface DrillToolApp {
  readonly packageId: string;
  readonly title: string;
  /** Ephemeral actor- and package-scoped credential. Do not persist or share this link. */
  readonly url: string;
}

export interface DrillExecutionBinding {
  /** Optional Tool apps owned by this interaction. Always an array when supplied by the drill runner. */
  readonly apps: readonly DrillToolApp[];
}

export interface TargetExecutionContext {
  readonly signal: AbortSignal;
  readonly binding?: DrillExecutionBinding;
  /** Present only when the target explicitly declares the direct binding. */
  readonly world?: BoundWorldClient;
  /** Copies one caller-owned file into the eventual report bundle. */
  readonly attach?: (input: TargetFileAttachmentInput) => TargetFileAttachment;
  /** Optional supporting capture supplied by the embedding runner. */
  readonly capture?: RunCaptureHandle;
}

export interface TargetFileAttachmentInput {
  /** Repository-relative path to an existing regular file. */
  readonly path: string;
  /** Portable report file name. Defaults to the source basename. */
  readonly name?: string;
  readonly mediaType: string;
  /** Firedrill copies bytes verbatim. Redaction, when needed, is caller-owned. */
  readonly redaction?: {
    readonly status: "not_applied" | "applied_by_caller";
    readonly note?: string;
  };
}

export interface TargetAttachmentSinkInput {
  readonly invocation: TargetInvocation;
  readonly attachment: TargetFileAttachmentInput;
}

export type TargetAttachmentSink = (input: TargetAttachmentSinkInput) => TargetFileAttachment;

export type TargetHandler = (
  invocation: TargetInvocation,
  context: TargetExecutionContext,
) => unknown | Promise<unknown>;

export interface InvokeTargetOptions {
  readonly descriptor: TargetDescriptor;
  readonly invocation: TargetInvocation;
  readonly repositoryRoot: string;
  /** Required for an external target. Ignored for descriptors with their own launcher. */
  readonly externalHandler?: TargetHandler;
  /** Invocation-scoped client. Exposed only for a declared direct binding and revoked when the target ends. */
  readonly worldClient?: BoundWorldClient;
  /** Runtime-owned app links; no world-control capability is included. */
  readonly binding?: DrillExecutionBinding;
  /** Defaults to process.env. Only explicitly mapped values are exposed to the target. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Remote agent triggers can receive world credentials, so local execution denies them by default. */
  readonly allowRemoteHttp?: boolean;
  /** Cancels the customer-owned target without converting the run into an internal failure. */
  readonly signal?: AbortSignal;
  /** Runtime-owned sink used to stage portable report files. */
  readonly attachmentSink?: TargetAttachmentSink;
  readonly captureFactory?: (invocation: TargetInvocation, signal: AbortSignal) => RunCaptureHandle;
}

export class TargetAttachmentError extends Error {
  readonly code: string;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = "TargetAttachmentError";
    this.code = code;
    this.details = details;
  }
}

class TargetExecutionError extends Error {
  readonly code: string;
  readonly details: JsonObject | undefined;
  readonly attachments: readonly JsonObject[];

  constructor(code: string, message: string, details?: JsonObject, attachments: readonly JsonObject[] = []) {
    super(message);
    this.name = "TargetExecutionError";
    this.code = code;
    this.details = details;
    this.attachments = attachments;
  }
}

class TargetTimeoutError extends Error {
  readonly timeoutMs: number;
  attachments: readonly JsonObject[] = [];

  constructor(timeoutMs: number) {
    super(`target did not complete within ${timeoutMs} ms`);
    this.name = "TargetTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class TargetCancelledError extends Error {
  attachments: readonly JsonObject[] = [];

  constructor() {
    super("target execution was cancelled");
    this.name = "TargetCancelledError";
  }
}

function contained(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function repositoryPath(repositoryRoot: string, candidate: string, purpose: string): string {
  const root = realpathSync(repositoryRoot);
  const unresolved = resolve(root, candidate);
  if (!contained(root, unresolved)) {
    throw new TargetExecutionError(
      "target.PATH_OUTSIDE_REPOSITORY",
      `${purpose} resolves outside the consumer repository`,
    );
  }
  let path: string;
  try {
    path = realpathSync(unresolved);
  } catch (error) {
    const filesystemCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "UNKNOWN";
    if (filesystemCode === "ENOENT") {
      throw new TargetExecutionError("target.PATH_NOT_FOUND", `${purpose} ${candidate} does not exist`, {
        path: candidate,
        purpose,
      });
    }
    throw new TargetExecutionError("target.PATH_UNAVAILABLE", `${purpose} ${candidate} cannot be accessed`, {
      path: candidate,
      purpose,
      filesystemCode,
    });
  }
  if (!contained(root, path)) {
    throw new TargetExecutionError(
      "target.PATH_OUTSIDE_REPOSITORY",
      `${purpose} resolves outside the consumer repository`,
    );
  }
  return path;
}

function errorEnvelope(
  invocation: TargetInvocation,
  code: string,
  message: string,
  details?: JsonObject,
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    source: "target",
    message,
    retryable: false,
    issues: [],
    ...(details === undefined ? {} : { details }),
    evidence: { runId: invocation.runId },
  };
}

function failure(
  invocation: TargetInvocation,
  error: unknown,
  registeredAttachments: readonly JsonObject[] = [],
): TargetResult {
  const errorAttachments =
    error instanceof TargetExecutionError ||
    error instanceof TargetTimeoutError ||
    error instanceof TargetCancelledError
      ? error.attachments
      : [];
  const attachments = [...registeredAttachments, ...errorAttachments];
  if (error instanceof TargetCancelledError) {
    return TargetResultSchema.parse({
      schemaVersion: 1,
      status: "cancelled",
      attachments,
      error: errorEnvelope(invocation, "target.CANCELLED", error.message),
    });
  }
  if (error instanceof TargetTimeoutError) {
    return TargetResultSchema.parse({
      schemaVersion: 1,
      status: "timed_out",
      attachments,
      error: errorEnvelope(invocation, "target.TIMEOUT", error.message, {
        timeoutMs: error.timeoutMs,
        clock: "wall",
      }),
    });
  }
  const executionError =
    error instanceof TargetExecutionError
      ? error
      : error instanceof TargetAttachmentError
        ? new TargetExecutionError(error.code, error.message, error.details)
        : new TargetExecutionError(
            "target.EXECUTION_FAILED",
            `target execution failed: ${boundedDiagnosticMessage(error, "unknown target error")}`,
            error instanceof Error ? { errorName: error.name } : undefined,
          );
  return TargetResultSchema.parse({
    schemaVersion: 1,
    status: "failed",
    attachments,
    error: errorEnvelope(invocation, executionError.code, executionError.message, executionError.details),
  });
}

interface TargetCompletion {
  readonly output?: unknown;
  readonly attachments: readonly JsonObject[];
}

function completed(invocation: TargetInvocation, completion: TargetCompletion): TargetResult {
  const output = completion.output;
  if (output === undefined) {
    return TargetResultSchema.parse({
      schemaVersion: 1,
      status: "completed",
      attachments: completion.attachments,
    });
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("non-finite numbers are not JSON values");
      }
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(`${typeof value} values are not JSON serializable`);
      }
      return value;
    });
  } catch (error) {
    return failure(
      invocation,
      new TargetExecutionError("target.INVALID_OUTPUT", "target output must be JSON serializable", {
        validation: error instanceof Error ? error.message : "serialization failed",
      }),
      completion.attachments,
    );
  }
  if (serialized === undefined) {
    return failure(
      invocation,
      new TargetExecutionError("target.INVALID_OUTPUT", "target output must be JSON serializable"),
      completion.attachments,
    );
  }
  const parsed = JsonValueSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) {
    return failure(
      invocation,
      new TargetExecutionError("target.INVALID_OUTPUT", "target output must be JSON serializable", {
        validation: parsed.error.issues.map((issue) => issue.message).join("; "),
      }),
      completion.attachments,
    );
  }
  return TargetResultSchema.parse({
    schemaVersion: 1,
    status: "completed",
    output: parsed.data,
    attachments: completion.attachments,
  });
}

/** Remove issued credentials before target output or inline diagnostics enter durable run evidence. */
function redactBindingCredentials(
  result: TargetResult,
  invocation: TargetInvocation,
  binding: DrillExecutionBinding | undefined,
): TargetResult {
  const secrets = new Set<string>();
  const addApp = (url: string) => {
    if (url.length === 0) return;
    secrets.add(url);
    try {
      const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
      if (token !== null && token.length > 0) secrets.add(token);
    } catch {
      // Only the complete opaque value can be redacted when the input is not a URL.
    }
  };
  for (const app of binding?.apps ?? []) addApp(app.url);
  for (const [name, value] of Object.entries(invocation.bindingEnvironment)) {
    if (/^FIREDRILL_(?:HTTP|MCP|CLI)_TOKEN$/.test(name) && value.length > 0) secrets.add(value);
  }
  const serializedApps = invocation.bindingEnvironment.FIREDRILL_TOOL_APPS;
  if (serializedApps !== undefined && serializedApps !== "[]") {
    secrets.add(serializedApps);
    try {
      const apps: unknown = JSON.parse(serializedApps);
      if (Array.isArray(apps)) {
        for (const app of apps) {
          if (typeof app === "object" && app !== null && "url" in app && typeof app.url === "string")
            addApp(app.url);
        }
      }
    } catch {
      // A standalone invokeTarget caller can supply opaque environment values.
    }
  }
  if (secrets.size === 0) return result;
  const values = [...secrets].sort((left, right) => right.length - left.length);
  const redactText = (value: string): string => {
    let redacted = value;
    for (const secret of values) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), redact(item)]));
    return value;
  };
  return TargetResultSchema.parse(redact(result));
}

async function withinTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  beforeAbort?: () => void,
): Promise<T> {
  if (externalSignal?.aborted) throw new TargetCancelledError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TargetTimeoutError(timeoutMs);
      beforeAbort?.();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref();
  });
  let cancel: Promise<never> | undefined;
  let onCancel: (() => void) | undefined;
  if (externalSignal !== undefined) {
    cancel = new Promise<never>((_resolve, reject) => {
      onCancel = () => {
        const error = new TargetCancelledError();
        beforeAbort?.();
        controller.abort(error);
        reject(error);
      };
      externalSignal.addEventListener("abort", onCancel, { once: true });
    });
  }
  try {
    return await Promise.race(
      cancel === undefined ? [work(controller.signal), timeout] : [work(controller.signal), timeout, cancel],
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal !== undefined && onCancel !== undefined) {
      externalSignal.removeEventListener("abort", onCancel);
    }
  }
}

function executionContext(
  descriptor: TargetDescriptor,
  signal: AbortSignal,
  worldClient: BoundWorldClient | undefined,
  attach: TargetExecutionContext["attach"],
): TargetExecutionContext {
  const bindings: readonly string[] = descriptor.bindings;
  const attachmentContext = attach === undefined ? {} : { attach };
  if (!bindings.includes("direct")) return { signal, ...attachmentContext };
  if (worldClient === undefined) {
    throw new TargetExecutionError(
      "target.DIRECT_BINDING_UNAVAILABLE",
      `target ${descriptor.id} declares a direct binding, but the runner did not supply one`,
    );
  }
  return { signal, world: worldClient, ...attachmentContext };
}

async function invokeModule(
  descriptor: Extract<TargetDescriptor, { kind: "module" }>,
  invocation: TargetInvocation,
  options: InvokeTargetOptions,
  context: TargetExecutionContext,
): Promise<unknown> {
  const modulePath = repositoryPath(options.repositoryRoot, descriptor.module, "target module");
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("firedrill_run", invocation.runId);
  const imported = (await tsImport(moduleUrl.href, import.meta.url)) as Record<string, unknown>;
  let candidate = imported[descriptor.export];
  // tsx exposes a nested default when a TypeScript file lives in a repository
  // without an ESM package boundary. Treat that standard CJS/ESM interop shape
  // exactly like a native default export.
  if (
    descriptor.export === "default" &&
    typeof candidate !== "function" &&
    typeof candidate === "object" &&
    candidate !== null &&
    "default" in candidate
  ) {
    candidate = candidate.default;
  }
  if (typeof candidate !== "function") {
    throw new TargetExecutionError(
      "target.EXPORT_NOT_CALLABLE",
      `target module export ${descriptor.export} is not a function`,
    );
  }
  const handler = candidate as TargetHandler;
  return handler(invocation, context);
}

function mappedEnvironment(
  mapping: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [targetName, hostName] of Object.entries(mapping)) {
    const value = host[hostName];
    if (value === undefined) {
      throw new TargetExecutionError(
        "target.MISSING_ENVIRONMENT",
        `required host environment variable ${hostName} is not set`,
        { hostName, targetName },
      );
    }
    result[targetName] = value;
  }
  return result;
}

function commandEnvironment(
  descriptor: Extract<TargetDescriptor, { kind: "command" }>,
  invocation: TargetInvocation,
  host: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...mappedEnvironment(descriptor.environmentFromHost, host),
    // Issued synthetic bindings cannot be replaced by an ambient host value.
    ...invocation.bindingEnvironment,
  };
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "ComSpec"]) {
    if (host[name] !== undefined) environment[name] = host[name];
  }
  return environment;
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function processStderrAttachment(input: {
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
}): readonly JsonObject[] {
  if (input.stderr.length === 0 && !input.stderrTruncated) return [];
  return [
    {
      schemaVersion: 1,
      kind: "process.stderr",
      mediaType: "text/plain; charset=utf-8",
      text: input.stderr,
      bytes: input.stderrBytes,
      capturedBytes: Buffer.byteLength(input.stderr),
      truncated: input.stderrTruncated,
    },
  ];
}

function executeCommand(input: {
  readonly descriptor: Extract<TargetDescriptor, { kind: "command" }>;
  readonly invocation: TargetInvocation;
  readonly repositoryRoot: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}): Promise<CommandOutput> {
  const cwd = repositoryPath(
    input.repositoryRoot,
    input.descriptor.workingDirectory ?? ".",
    "target working directory",
  );
  const stdin = `${JSON.stringify(input.invocation)}\n`;
  if (Buffer.byteLength(stdin) > MAX_INPUT_BYTES) {
    throw new TargetExecutionError("target.INPUT_TOO_LARGE", "target invocation exceeds 1 MiB");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.descriptor.executable, input.descriptor.arguments, {
      cwd,
      env: commandEnvironment(input.descriptor, input.invocation, input.hostEnvironment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrCapturedBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      input.signal.removeEventListener("abort", abort);
      if (forceKill !== undefined) clearTimeout(forceKill);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail(new TargetExecutionError("target.OUTPUT_TOO_LARGE", "stdout exceeds 1 MiB"));
        return;
      }
      stdout.push(chunk);
    };
    const appendStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      const remaining = MAX_OUTPUT_BYTES - stderrCapturedBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stderr.push(captured);
        stderrCapturedBytes += captured.length;
      }
      if (chunk.length > remaining) stderrTruncated = true;
    };
    const abort = () => {
      const reason = input.signal.reason;
      if (reason instanceof TargetTimeoutError || reason instanceof TargetCancelledError) {
        reason.attachments = processStderrAttachment({
          stderr: Buffer.concat(stderr).toString("utf8"),
          stderrBytes,
          stderrTruncated,
        });
      }
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKill.unref();
    };

    input.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      const filesystemCode = (error as NodeJS.ErrnoException).code;
      fail(
        new TargetExecutionError(
          "target.COMMAND_START_FAILED",
          `could not start target command ${input.descriptor.executable}: ${error.message}`,
          {
            executable: input.descriptor.executable,
            ...(filesystemCode === undefined ? {} : { filesystemCode }),
          },
        ),
      );
    });
    child.stdout.on("data", appendStdout);
    child.stderr.on("data", appendStderr);
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stderrBytes,
        stderrTruncated,
        exitCode,
        signal,
      });
    });
    child.stdin.end(stdin);
  });
}

async function invokeCommand(
  descriptor: Extract<TargetDescriptor, { kind: "command" }>,
  invocation: TargetInvocation,
  options: InvokeTargetOptions,
  signal: AbortSignal,
): Promise<TargetCompletion> {
  const result = await executeCommand({
    descriptor,
    invocation,
    repositoryRoot: options.repositoryRoot,
    hostEnvironment: options.hostEnvironment ?? process.env,
    signal,
  });
  const attachments = processStderrAttachment(result);
  const stderrLines = result.stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const stderrSummary = stderrLines.at(-1)?.slice(0, 500);
  if (result.exitCode !== 0) {
    throw new TargetExecutionError(
      "target.COMMAND_FAILED",
      `target command ${descriptor.executable} exited ${result.exitCode === null ? `after signal ${String(result.signal)}` : `with code ${result.exitCode}`}${stderrSummary === undefined ? "" : `: ${stderrSummary}`}`,
      {
        executable: descriptor.executable,
        stderrAvailable: result.stderr.length > 0,
        stderrBytes: result.stderrBytes,
        stderrTruncated: result.stderrTruncated,
      },
      attachments,
    );
  }
  const value = result.stdout.trim();
  if (value.length === 0) return { attachments };
  try {
    return { output: JSON.parse(value) as unknown as JsonValue, attachments };
  } catch {
    throw new TargetExecutionError(
      "target.INVALID_OUTPUT",
      "target command stdout must contain one JSON value; write logs to stderr",
      {
        stderrAvailable: result.stderr.length > 0,
        stderrBytes: result.stderrBytes,
        stderrTruncated: result.stderrTruncated,
      },
      attachments,
    );
  }
}

function loopbackTarget(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

async function responseBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) {
    throw new TargetExecutionError("target.OUTPUT_TOO_LARGE", "target response exceeds 1 MiB");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TargetCancelledError();
    }
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      throw new TargetExecutionError("target.OUTPUT_TOO_LARGE", "target response exceeds 1 MiB");
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

async function invokeHttp(
  descriptor: Extract<TargetDescriptor, { kind: "http" }>,
  invocation: TargetInvocation,
  options: InvokeTargetOptions,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const url = new URL(descriptor.url);
  if (url.username !== "" || url.password !== "") {
    throw new TargetExecutionError(
      "target.URL_CREDENTIALS_FORBIDDEN",
      "target URL cannot contain credentials",
    );
  }
  if (!options.allowRemoteHttp && !loopbackTarget(url)) {
    throw new TargetExecutionError(
      "target.REMOTE_HTTP_FORBIDDEN",
      "local runs do not send world credentials to a remote HTTP target without explicit opt-in",
      { hostname: url.hostname },
    );
  }
  const mappedHeaders = mappedEnvironment(
    descriptor.headersFromEnvironment,
    options.hostEnvironment ?? process.env,
  );
  const body = JSON.stringify(invocation);
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
    throw new TargetExecutionError("target.INPUT_TOO_LARGE", "target invocation exceeds 1 MiB");
  }
  const response = await fetch(url, {
    method: descriptor.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...mappedHeaders,
    },
    body,
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new TargetExecutionError(
      "target.HTTP_REDIRECT_FORBIDDEN",
      "target endpoint redirects are not followed because an invocation contains world credentials",
      { status: response.status },
    );
  }
  const responseText = await responseBody(response, signal);
  if (!response.ok) {
    throw new TargetExecutionError("target.HTTP_FAILED", `target endpoint returned HTTP ${response.status}`, {
      status: response.status,
      bodyBytes: Buffer.byteLength(responseText),
    });
  }
  if (responseText.trim().length === 0) return undefined;
  try {
    return JSON.parse(responseText) as unknown as JsonValue;
  } catch {
    throw new TargetExecutionError("target.INVALID_OUTPUT", "target HTTP response must be valid JSON");
  }
}

async function invokeExternal(
  descriptor: Extract<TargetDescriptor, { kind: "external" }>,
  invocation: TargetInvocation,
  options: InvokeTargetOptions,
  context: TargetExecutionContext,
): Promise<unknown> {
  if (options.externalHandler === undefined) {
    throw new TargetExecutionError(
      "target.EXTERNAL_HANDLER_REQUIRED",
      `external target ${descriptor.id} requires a handler from the embedding test process`,
    );
  }
  return options.externalHandler(invocation, context);
}

/**
 * Invokes one agent target without granting it hidden world-control access.
 * Command, HTTP, and MCP agents receive only the bindings they declared.
 */
export async function invokeTarget(options: InvokeTargetOptions): Promise<TargetResult> {
  const descriptor = TargetDescriptorSchema.parse(options.descriptor);
  const invocation = TargetInvocationSchema.parse(options.invocation);
  const registeredAttachments: TargetFileAttachment[] = [];
  const attach =
    options.attachmentSink === undefined
      ? undefined
      : (input: TargetFileAttachmentInput) => {
          const attachment = TargetFileAttachmentSchema.parse(
            options.attachmentSink?.({ invocation, attachment: input }),
          );
          if (registeredAttachments.some((candidate) => candidate.id === attachment.id)) {
            throw new TargetAttachmentError(
              "target.ATTACHMENT_DUPLICATE",
              `target attachment id ${attachment.id} was registered more than once`,
            );
          }
          registeredAttachments.push(attachment);
          return attachment;
        };
  try {
    const completion = await withinTimeout(
      descriptor.timeoutMs,
      async (signal) => {
        const context = {
          ...executionContext(descriptor, signal, options.worldClient, attach),
          ...(options.binding === undefined ? {} : { binding: options.binding }),
          ...(options.captureFactory === undefined
            ? {}
            : { capture: options.captureFactory(invocation, signal) }),
        };
        if (descriptor.kind === "module") {
          return {
            output: await invokeModule(descriptor, invocation, options, context),
            attachments: registeredAttachments,
          };
        }
        if (descriptor.kind === "command") return invokeCommand(descriptor, invocation, options, signal);
        if (descriptor.kind === "http") {
          return { output: await invokeHttp(descriptor, invocation, options, signal), attachments: [] };
        }
        return {
          output: await invokeExternal(descriptor, invocation, options, context),
          attachments: registeredAttachments,
        };
      },
      options.signal,
      () => options.worldClient?.revoke(),
    );
    return redactBindingCredentials(completed(invocation, completion), invocation, options.binding);
  } catch (error) {
    return redactBindingCredentials(
      failure(invocation, error, registeredAttachments),
      invocation,
      options.binding,
    );
  } finally {
    options.worldClient?.revoke();
  }
}
