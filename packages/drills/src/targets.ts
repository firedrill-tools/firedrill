import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ErrorEnvelope,
  JsonObject,
  JsonValue,
  TargetDescriptor,
  TargetInvocation,
  TargetResult,
} from "@firedrill/contracts";
import {
  JsonValueSchema,
  TargetDescriptorSchema,
  TargetInvocationSchema,
  TargetResultSchema,
} from "@firedrill/contracts";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { tsImport } from "tsx/esm/api";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface TargetExecutionContext {
  readonly signal: AbortSignal;
  /** Present only when the target explicitly declares the direct binding. */
  readonly world?: BoundWorldClient;
}

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
  /** Defaults to process.env. Only explicitly mapped values are exposed to the target. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Remote agent triggers can receive world credentials, so local execution denies them by default. */
  readonly allowRemoteHttp?: boolean;
  /** Cancels the customer-owned target without converting the run into an internal failure. */
  readonly signal?: AbortSignal;
}

class TargetExecutionError extends Error {
  readonly code: string;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = "TargetExecutionError";
    this.code = code;
    this.details = details;
  }
}

class TargetTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`target did not complete within ${timeoutMs} ms`);
    this.name = "TargetTimeoutError";
  }
}

class TargetCancelledError extends Error {
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

function failure(invocation: TargetInvocation, error: unknown): TargetResult {
  if (error instanceof TargetCancelledError) {
    return TargetResultSchema.parse({
      schemaVersion: 1,
      status: "cancelled",
      attachments: [],
      error: errorEnvelope(invocation, "target.CANCELLED", error.message),
    });
  }
  if (error instanceof TargetTimeoutError) {
    return TargetResultSchema.parse({
      schemaVersion: 1,
      status: "timed_out",
      attachments: [],
      error: errorEnvelope(invocation, "target.TIMEOUT", error.message),
    });
  }
  const executionError =
    error instanceof TargetExecutionError
      ? error
      : new TargetExecutionError(
          "target.EXECUTION_FAILED",
          "target execution failed",
          error instanceof Error ? { errorName: error.name } : undefined,
        );
  return TargetResultSchema.parse({
    schemaVersion: 1,
    status: "failed",
    attachments: [],
    error: errorEnvelope(invocation, executionError.code, executionError.message, executionError.details),
  });
}

function completed(invocation: TargetInvocation, output: unknown): TargetResult {
  if (output === undefined) {
    return TargetResultSchema.parse({ schemaVersion: 1, status: "completed", attachments: [] });
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
    );
  }
  if (serialized === undefined) {
    return failure(
      invocation,
      new TargetExecutionError("target.INVALID_OUTPUT", "target output must be JSON serializable"),
    );
  }
  const parsed = JsonValueSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) {
    return failure(
      invocation,
      new TargetExecutionError("target.INVALID_OUTPUT", "target output must be JSON serializable", {
        validation: parsed.error.issues.map((issue) => issue.message).join("; "),
      }),
    );
  }
  return TargetResultSchema.parse({
    schemaVersion: 1,
    status: "completed",
    output: parsed.data,
    attachments: [],
  });
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
): TargetExecutionContext {
  const bindings: readonly string[] = descriptor.bindings;
  if (!bindings.includes("direct")) return { signal };
  if (worldClient === undefined) {
    throw new TargetExecutionError(
      "target.DIRECT_BINDING_UNAVAILABLE",
      `target ${descriptor.id} declares a direct binding, but the runner did not supply one`,
    );
  }
  return { signal, world: worldClient };
}

async function invokeModule(
  descriptor: Extract<TargetDescriptor, { kind: "module" }>,
  invocation: TargetInvocation,
  options: InvokeTargetOptions,
  signal: AbortSignal,
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
  return handler(invocation, executionContext(descriptor, signal, options.worldClient));
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
    ...invocation.bindingEnvironment,
    ...mappedEnvironment(descriptor.environmentFromHost, host),
  };
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "ComSpec"]) {
    if (host[name] !== undefined) environment[name] = host[name];
  }
  return environment;
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
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
    const append = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        fail(new TargetExecutionError("target.OUTPUT_TOO_LARGE", `${stream} exceeds 1 MiB`));
        return;
      }
      chunks.push(chunk);
    };
    const abort = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKill.unref();
    };

    input.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => fail(error));
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
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
): Promise<JsonValue | undefined> {
  const result = await executeCommand({
    descriptor,
    invocation,
    repositoryRoot: options.repositoryRoot,
    hostEnvironment: options.hostEnvironment ?? process.env,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new TargetExecutionError(
      "target.COMMAND_FAILED",
      `target command exited ${result.exitCode === null ? `after signal ${String(result.signal)}` : `with code ${result.exitCode}`}`,
      { stderrAvailable: result.stderr.length > 0, stderrBytes: Buffer.byteLength(result.stderr) },
    );
  }
  const value = result.stdout.trim();
  if (value.length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown as JsonValue;
  } catch {
    throw new TargetExecutionError(
      "target.INVALID_OUTPUT",
      "target command stdout must contain one JSON value; write logs to stderr",
      { stderrAvailable: result.stderr.length > 0, stderrBytes: Buffer.byteLength(result.stderr) },
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
  signal: AbortSignal,
): Promise<unknown> {
  if (options.externalHandler === undefined) {
    throw new TargetExecutionError(
      "target.EXTERNAL_HANDLER_REQUIRED",
      `external target ${descriptor.id} requires a handler from the embedding test process`,
    );
  }
  return options.externalHandler(invocation, executionContext(descriptor, signal, options.worldClient));
}

/**
 * Invokes one agent target without granting it hidden world-control access.
 * Command, HTTP, and MCP agents receive only the bindings they declared.
 */
export async function invokeTarget(options: InvokeTargetOptions): Promise<TargetResult> {
  const descriptor = TargetDescriptorSchema.parse(options.descriptor);
  const invocation = TargetInvocationSchema.parse(options.invocation);
  try {
    const output = await withinTimeout(
      descriptor.timeoutMs,
      async (signal) => {
        if (descriptor.kind === "module") return invokeModule(descriptor, invocation, options, signal);
        if (descriptor.kind === "command") return invokeCommand(descriptor, invocation, options, signal);
        if (descriptor.kind === "http") return invokeHttp(descriptor, invocation, options, signal);
        return invokeExternal(descriptor, invocation, options, signal);
      },
      options.signal,
      () => options.worldClient?.revoke(),
    );
    return completed(invocation, output);
  } catch (error) {
    return failure(invocation, error);
  } finally {
    options.worldClient?.revoke();
  }
}
