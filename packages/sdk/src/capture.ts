import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CaptureDriver,
  CaptureDriverContext,
  CaptureFileInput,
  CaptureKind,
  CapturePolicies,
  CapturePolicy,
  RunCapture,
  RunCaptureHandle,
  RunId,
  RunResult,
  StableId,
  TargetResult,
} from "@firedrill-run/contracts";
import {
  CapturePolicySchema,
  RunCaptureSchema,
  RunIdSchema,
  TargetFileAttachmentSchema,
} from "@firedrill-run/contracts";
import type { LocalReportAttachmentSource } from "@firedrill-run/reporters";
import { FiredrillProjectError } from "./project-error.js";

export type {
  CaptureDriver,
  CaptureDriverContext,
  CaptureFileInput,
  CapturePolicies,
  CapturePolicy,
  RunCaptureHandle,
} from "@firedrill-run/contracts";
export interface RunCaptureOptions {
  readonly logs?: CapturePolicy;
  readonly screenshots?: CapturePolicy;
  readonly video?: CapturePolicy;
  readonly files?: CapturePolicy;
  /** Per driver callback, including cleanup. Defaults to 5000; maximum 60000 milliseconds. */
  readonly driverTimeoutMs?: number;
}

const MAX_FILES = 32;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RUN_BYTES = 128 * 1024 * 1024;
const MAX_STAGE_BYTES = 256 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_MESSAGE_BYTES = 16 * 1024;
const MEDIA_TYPES = new Set([
  "application/json",
  "application/zip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/html",
  "text/plain",
  "video/webm",
]);
const OFF_POLICIES = Object.freeze({ logs: "off", screenshots: "off", video: "off", files: "off" } as const);
type Usage = { readonly count: number; readonly bytes: number };
type CaptureAttachment = RunCapture["attachments"][number];
interface StagedCapture {
  readonly item: CaptureAttachment;
  readonly path: string;
}
interface RegisteredDriver {
  readonly driver: CaptureDriver;
  readonly interactionId?: StableId;
  start?: Promise<void>;
}
interface CaptureSession {
  phase: "open" | "closing" | "closed";
  readonly files: StagedCapture[];
  readonly errors: RunCapture["errors"];
  readonly discarded: RunCapture["discarded"];
  readonly drivers: RegisteredDriver[];
  logs: string[];
  logBytes: number;
}

class CaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function category(kind: CaptureKind): keyof CapturePolicies {
  return kind === "log"
    ? "logs"
    : kind === "screenshot"
      ? "screenshots"
      : kind === "file"
        ? "files"
        : "video";
}
function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function keep(policy: CapturePolicy, result: RunResult): boolean {
  return (
    policy === "always" ||
    (policy === "retain-on-failure" && (result.status !== "sealed" || result.verdict !== "passed"))
  );
}

export function validateCaptureOptions(value: RunCaptureOptions | undefined): void {
  if (value === undefined) return;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["logs", "screenshots", "video", "files", "driverTimeoutMs"].includes(key),
    )
  ) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "capture must contain supported capture policies and an optional driver timeout",
    );
  }
  for (const key of ["logs", "screenshots", "video", "files"] as const) {
    if (value[key] !== undefined && !CapturePolicySchema.safeParse(value[key]).success)
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `capture.${key} must be off, always, or retain-on-failure`,
      );
  }
  if (
    value.driverTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.driverTimeoutMs) ||
      value.driverTimeoutMs < 1 ||
      value.driverTimeoutMs > 60_000)
  )
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "capture.driverTimeoutMs must be an integer from 1 through 60000",
    );
}

/** Supporting artifacts only: never writes the world, interactions, or causal evidence. */
export class LocalCaptureManager {
  readonly policies: Readonly<CapturePolicies>;
  readonly #root: string;
  readonly #sessions = new Map<RunId, CaptureSession>();
  readonly #timeoutMs: number;
  readonly #enabled: boolean;
  readonly #legacyUsage: (runId: RunId) => Usage;
  #stageRoot: string | undefined;
  #stageBytes = 0;
  #disposed = false;

  constructor(root: string, options: RunCaptureOptions | undefined, legacyUsage: (runId: RunId) => Usage) {
    validateCaptureOptions(options);
    this.#root = realpathSync(root);
    this.#enabled = options !== undefined;
    this.policies = Object.freeze({
      ...OFF_POLICIES,
      ...Object.fromEntries(
        Object.entries(options ?? {}).filter(
          ([key, value]) => key !== "driverTimeoutMs" && value !== undefined,
        ),
      ),
    });
    this.#timeoutMs = options?.driverTimeoutMs ?? 5_000;
    this.#legacyUsage = legacyUsage;
  }

  #session(runId: RunId): CaptureSession {
    RunIdSchema.parse(runId);
    let session = this.#sessions.get(runId);
    if (session === undefined) {
      session = {
        phase: "open",
        files: [],
        errors: [],
        discarded: { logs: 0, screenshots: 0, video: 0, files: 0 },
        drivers: [],
        logs: [],
        logBytes: 0,
      };
      this.#sessions.set(runId, session);
    }
    return session;
  }

  usage(runId: RunId): Usage {
    const session = this.#sessions.get(runId);
    return {
      count: (session?.files.length ?? 0) + ((session?.logBytes ?? 0) > 0 ? 1 : 0),
      bytes:
        (session?.files.reduce((sum, file) => sum + file.item.attachment.bytes, 0) ?? 0) +
        (session?.logBytes ?? 0),
    };
  }

  /** Existing attach() evidence has priority over optional captures. */
  reserveLegacy(runId: RunId, bytes: number): void {
    const session = this.#sessions.get(runId);
    if (session === undefined || session.phase !== "open") return;
    const legacy = this.#legacyUsage(runId);
    const exceeds = () => {
      const usage = this.usage(runId);
      return legacy.count + usage.count + 1 > MAX_FILES || legacy.bytes + usage.bytes + bytes > MAX_RUN_BYTES;
    };
    if (exceeds() && session.logBytes > 0) {
      this.#stageBytes -= session.logBytes;
      session.logBytes = 0;
      session.logs = [];
      this.#error(
        session,
        new CaptureError(
          "capture.LIMIT_EXCEEDED",
          "Optional logs were dropped to preserve an explicitly attached file.",
        ),
        "log",
      );
    }
    while (exceeds() && session.files.length > 0) {
      const file = session.files.pop();
      if (file === undefined) break;
      try {
        rmSync(file.path);
        this.#stageBytes -= file.item.attachment.bytes;
      } catch (error) {
        this.#error(session, error, file.item.kind, file.item.interactionId);
      }
      this.#error(
        session,
        new CaptureError(
          "capture.LIMIT_EXCEEDED",
          "An optional capture was dropped to preserve an explicitly attached file.",
        ),
        file.item.kind,
        file.item.interactionId,
      );
    }
  }

  #error(session: CaptureSession, error: unknown, kind?: CaptureKind, interactionId?: StableId): void {
    if (session.phase === "closed" || session.errors.length >= 256) return;
    session.errors.push({
      code:
        session.errors.length === 255
          ? "capture.ERROR_LIMIT_EXCEEDED"
          : error instanceof CaptureError
            ? error.code
            : "capture.UNAVAILABLE",
      message:
        session.errors.length === 255
          ? "Additional capture errors were omitted."
          : error instanceof CaptureError
            ? error.message
            : "Capture could not be completed. Check the caller-owned file or driver; raw error details are not retained.",
      ...(kind === undefined ? {} : { kind }),
      ...(interactionId === undefined ? {} : { interactionId }),
    });
  }

  #checkBudget(runId: RunId, bytes: number, extraCount = 1): void {
    const usage = this.usage(runId);
    const legacy = this.#legacyUsage(runId);
    if (
      usage.count + legacy.count + extraCount > MAX_FILES ||
      usage.bytes + legacy.bytes + bytes > MAX_RUN_BYTES ||
      this.#stageBytes + bytes > MAX_STAGE_BYTES
    ) {
      throw new CaptureError(
        "capture.LIMIT_EXCEEDED",
        "Capture and attachments exceeded their bounded file count or byte budget.",
      );
    }
  }

  #read(input: CaptureFileInput, kind: CaptureKind): Buffer {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof input.path !== "string" ||
      input.path.length < 1 ||
      input.path.length > 4096 ||
      isAbsolute(input.path)
    )
      throw new CaptureError("capture.INVALID_FILE", "Capture requires a repository-relative file path.");
    const name = input.name ?? basename(input.path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name))
      throw new CaptureError("capture.INVALID_FILE", "Capture names must be portable file names.");
    if (
      !MEDIA_TYPES.has(input.mediaType) ||
      (kind === "screenshot" && !["image/png", "image/jpeg", "image/webp"].includes(input.mediaType)) ||
      (kind === "video" && input.mediaType !== "video/webm")
    )
      throw new CaptureError(
        "capture.MEDIA_TYPE_UNSUPPORTED",
        "Capture media type is unsupported for this kind of artifact.",
      );
    if (
      input.redaction !== undefined &&
      (!["not_applied", "applied_by_caller"].includes(input.redaction.status) ||
        (input.redaction.note !== undefined &&
          (typeof input.redaction.note !== "string" ||
            input.redaction.note.length < 1 ||
            input.redaction.note.length > 500)))
    )
      throw new CaptureError("capture.INVALID_FILE", "Capture redaction metadata is invalid.");
    const path = resolve(this.#root, input.path);
    if (!contained(this.#root, path))
      throw new CaptureError(
        "capture.PATH_OUTSIDE_REPOSITORY",
        "Capture files must stay inside the consumer repository.",
      );
    let current = this.#root;
    for (const part of relative(this.#root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink())
        throw new CaptureError("capture.SYMLINK_FORBIDDEN", "Capture paths cannot contain symbolic links.");
    }
    if (!contained(this.#root, realpathSync(path)))
      throw new CaptureError(
        "capture.PATH_OUTSIDE_REPOSITORY",
        "Capture files must stay inside the consumer repository.",
      );
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1)
        throw new CaptureError(
          "capture.INVALID_FILE",
          "Capture requires a regular file without additional hard links.",
        );
      if (before.size > MAX_FILE_BYTES)
        throw new CaptureError("capture.FILE_TOO_LARGE", "A capture file cannot exceed 64 MiB.");
      const body = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < body.length) {
        const count = readSync(fd, body, offset, body.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        offset !== body.length ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        readSync(fd, Buffer.alloc(1), 0, 1, before.size) !== 0
      )
        throw new CaptureError("capture.FILE_CHANGED", "Capture file changed while it was copied.");
      return body;
    } finally {
      closeSync(fd);
    }
  }

  #stage(
    runId: RunId,
    kind: CaptureKind,
    input: CaptureFileInput,
    body: Buffer,
    interactionId?: StableId,
  ): void {
    const policy = this.policies[category(kind)];
    if (policy === "off") return;
    this.#checkBudget(runId, body.byteLength);
    const attachment = TargetFileAttachmentSchema.parse({
      schemaVersion: 1,
      kind: "file",
      id: `capture-${randomUUID().replaceAll("-", "")}`,
      name: input.name ?? basename(input.path),
      mediaType: input.mediaType,
      bytes: body.byteLength,
      hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      redaction: input.redaction ?? { status: "not_applied" },
    });
    this.#stageRoot ??= mkdtempSync(join(tmpdir(), "firedrill-capture-stage-"));
    const runRoot = join(this.#stageRoot, runId);
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const path = join(runRoot, attachment.id);
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      try {
        rmSync(path, { force: true });
      } catch {
        this.#stageBytes += body.byteLength;
      }
      throw error;
    }
    this.#stageBytes += body.byteLength;
    this.#session(runId).files.push({
      item: { kind, policy, ...(interactionId === undefined ? {} : { interactionId }), attachment },
      path,
    });
  }

  #file(runId: RunId, kind: CaptureKind, input: CaptureFileInput, interactionId?: StableId): void {
    const session = this.#session(runId);
    if (this.#disposed || session.phase === "closed" || this.policies[category(kind)] === "off") return;
    try {
      this.#checkBudget(runId, 0);
      this.#stage(runId, kind, input, this.#read(input, kind), interactionId);
    } catch (error) {
      this.#error(session, error, kind, interactionId);
    }
  }

  #log(runId: RunId, message: string, interactionId?: StableId): void {
    const session = this.#session(runId);
    if (this.#disposed || session.phase !== "open" || this.policies.logs === "off") return;
    try {
      if (typeof message !== "string" || Buffer.byteLength(message) > MAX_LOG_MESSAGE_BYTES)
        throw new CaptureError("capture.LOG_TOO_LARGE", "One captured log message cannot exceed 16 KiB.");
      const line = `${JSON.stringify({ ...(interactionId === undefined ? {} : { interactionId }), message })}\n`;
      const bytes = Buffer.byteLength(line);
      if (session.logBytes + bytes > MAX_LOG_BYTES || session.logs.length >= 4096)
        throw new CaptureError(
          "capture.LOG_LIMIT_EXCEEDED",
          "Captured logs for one run cannot exceed 1 MiB or 4096 messages.",
        );
      this.#checkBudget(runId, bytes, session.logBytes === 0 ? 1 : 0);
      session.logs.push(line);
      session.logBytes += bytes;
      this.#stageBytes += bytes;
    } catch (error) {
      this.#error(session, error, "log", interactionId);
    }
  }

  async #driverCall<T>(
    runId: RunId,
    registered: RegisteredDriver,
    method: (context: CaptureDriverContext) => T | Promise<T>,
    kind?: CaptureKind,
    parentSignal?: AbortSignal,
  ): Promise<T | undefined> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new CaptureError("capture.DRIVER_CANCELLED", "Capture driver startup was cancelled."));
        };
        if (parentSignal?.aborted) {
          onAbort();
          return;
        }
        parentSignal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new CaptureError("capture.DRIVER_TIMEOUT", "Capture driver exceeded its callback deadline."),
          );
        }, this.#timeoutMs);
      });
      return await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) return undefined as T;
          return method({
            runId,
            ...(registered.interactionId === undefined ? {} : { interactionId: registered.interactionId }),
            signal: controller.signal,
          });
        }),
        deadline,
      ]);
    } catch (error) {
      this.#error(this.#session(runId), error, kind, registered.interactionId);
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) parentSignal?.removeEventListener("abort", onAbort);
    }
  }

  handle(runId: RunId, interactionId?: StableId, signal?: AbortSignal): RunCaptureHandle {
    const session = this.#session(runId);
    const usable = () => !this.#disposed && session.phase === "open" && !signal?.aborted;
    return Object.freeze({
      policies: this.policies,
      log: (message: string) => {
        if (usable()) this.#log(runId, message, interactionId);
      },
      file: (input: CaptureFileInput) => {
        if (usable()) this.#file(runId, "file", input, interactionId);
      },
      screenshot: (input: CaptureFileInput) => {
        if (usable()) this.#file(runId, "screenshot", input, interactionId);
      },
      video: (input: CaptureFileInput) => {
        if (usable()) this.#file(runId, "video", input, interactionId);
      },
      registerDriver: async (driver: CaptureDriver) => {
        if (!usable() || Object.values(this.policies).every((policy) => policy === "off")) return;
        try {
          const invalidDriver = () =>
            new CaptureError(
              "capture.DRIVER_INVALID",
              "Capture driver requires supported lifecycle functions; startVideo requires stopVideo.",
            );
          if (typeof driver !== "object" || driver === null) throw invalidDriver();
          const prototype = Object.getPrototypeOf(driver);
          // Plain configuration objects get a typo guard; class instances may carry caller-owned state.
          if (
            (prototype === Object.prototype || prototype === null) &&
            Reflect.ownKeys(driver).some(
              (key) => !["screenshot", "startVideo", "stopVideo", "dispose"].includes(String(key)),
            )
          )
            throw invalidDriver();
          // Read each supported member once, including prototype methods or accessors, before binding.
          const supplied = {
            screenshot: driver.screenshot,
            startVideo: driver.startVideo,
            stopVideo: driver.stopVideo,
            dispose: driver.dispose,
          };
          if (
            Object.values(supplied).every((value) => value === undefined) ||
            Object.values(supplied).some((value) => value !== undefined && typeof value !== "function") ||
            (supplied.startVideo !== undefined && supplied.stopVideo === undefined)
          ) {
            this.#error(
              session,
              new CaptureError(
                "capture.DRIVER_INVALID",
                "Capture driver must contain supported lifecycle callbacks; startVideo requires stopVideo.",
              ),
              undefined,
              interactionId,
            );
            return;
          }
          if (session.drivers.length >= 8) {
            this.#error(
              session,
              new CaptureError(
                "capture.DRIVER_LIMIT_EXCEEDED",
                "One run supports at most eight capture drivers.",
              ),
              undefined,
              interactionId,
            );
            return;
          }
          const methods = Object.fromEntries(
            Object.entries(supplied).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value.bind(driver)]],
            ),
          ) as CaptureDriver;
          const registered: RegisteredDriver = {
            driver: methods,
            ...(interactionId === undefined ? {} : { interactionId }),
          };
          session.drivers.push(registered);
          if (this.policies.video !== "off" && methods.startVideo !== undefined) {
            registered.start = this.#driverCall(runId, registered, methods.startVideo, "video", signal);
            await registered.start;
          }
        } catch (error) {
          this.#error(session, error, undefined, interactionId);
        }
      },
    });
  }

  async finish(result: RunResult): Promise<RunResult> {
    if (!this.#enabled) return result;
    const capture = await this.#finish(result.identity.runId, result.interactions, (policy) =>
      keep(policy, result),
    );
    return { ...result, capture };
  }

  /**
   * Drain supporting capture before a verdict exists. Enabled policies are retained;
   * the embedding runtime must apply final-verdict retention before publishing a report.
   * This method does not create a RunResult or evaluate any assertion.
   */
  async finishPending(
    runId: RunId,
    interactions: readonly { readonly interactionId: StableId; readonly targetResult: TargetResult }[] = [],
  ): Promise<RunCapture | undefined> {
    if (!this.#enabled) return undefined;
    return this.#finish(runId, interactions, (policy) => policy !== "off");
  }

  async #finish(
    runId: RunId,
    interactions: readonly { readonly interactionId: StableId; readonly targetResult: TargetResult }[],
    retain: (policy: CapturePolicy) => boolean,
  ): Promise<RunCapture> {
    const session = this.#session(runId);
    // Existing command stderr remains causal evidence. This policy controls only its optional copy.
    for (const interaction of interactions)
      for (const attachment of interaction.targetResult.attachments) {
        if (attachment.kind === "process.stderr" && typeof attachment.text === "string") {
          for (let offset = 0; offset < attachment.text.length; ) {
            let end = Math.min(offset + 4096, attachment.text.length);
            const last = attachment.text.charCodeAt(end - 1);
            if (end < attachment.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
            this.#log(runId, attachment.text.slice(offset, end), interaction.interactionId);
            offset = end;
          }
          if (attachment.truncated === true)
            this.#log(
              runId,
              "[Target stderr was truncated by the command runner.]",
              interaction.interactionId,
            );
        }
      }
    session.phase = "closing";
    for (const registered of session.drivers) {
      await registered.start;
      if (retain(this.policies.screenshots) && registered.driver.screenshot !== undefined) {
        const input = await this.#driverCall(runId, registered, registered.driver.screenshot, "screenshot");
        if (input !== undefined) this.#file(runId, "screenshot", input, registered.interactionId);
      }
      if (this.policies.video !== "off" && registered.driver.stopVideo !== undefined) {
        const input = await this.#driverCall(runId, registered, registered.driver.stopVideo, "video");
        if (input !== undefined) {
          if (retain(this.policies.video)) this.#file(runId, "video", input, registered.interactionId);
          else session.discarded.video += 1;
        }
      }
      if (registered.driver.dispose !== undefined)
        await this.#driverCall(runId, registered, registered.driver.dispose);
    }
    if (session.logBytes > 0) {
      const body = Buffer.from(session.logs.join(""));
      this.#stageBytes -= session.logBytes;
      session.logs = [];
      session.logBytes = 0;
      if (retain(this.policies.logs)) {
        try {
          this.#stage(runId, "log", { path: "capture-logs.txt", mediaType: "text/plain" }, body);
        } catch (error) {
          this.#error(session, error, "log");
        }
      } else session.discarded.logs += 1;
    }
    for (let index = session.files.length - 1; index >= 0; index -= 1) {
      const file = session.files[index];
      if (file === undefined || retain(file.item.policy)) continue;
      session.discarded[category(file.item.kind)] += 1;
      try {
        rmSync(file.path);
        this.#stageBytes -= file.item.attachment.bytes;
      } catch (error) {
        this.#error(session, error, file.item.kind, file.item.interactionId);
      }
      session.files.splice(index, 1);
    }
    const capture = RunCaptureSchema.parse({
      schemaVersion: 1,
      policies: this.policies,
      attachments: session.files.map((file) => file.item),
      errors: [...session.errors],
      discarded: { ...session.discarded },
    });
    session.drivers.splice(0);
    session.phase = "closed";
    return capture;
  }

  sources(runId: RunId): readonly LocalReportAttachmentSource[] {
    return (this.#sessions.get(runId)?.files ?? []).map(({ item, path }) => ({
      attachmentId: item.attachment.id,
      path,
    }));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const [runId, session] of this.#sessions) {
      if (session.phase === "closed") continue;
      session.phase = "closing";
      for (const registered of session.drivers) {
        await registered.start;
        if (this.policies.video !== "off" && registered.driver.stopVideo !== undefined)
          await this.#driverCall(runId, registered, registered.driver.stopVideo, "video");
        if (registered.driver.dispose !== undefined)
          await this.#driverCall(runId, registered, registered.driver.dispose);
      }
      session.phase = "closed";
    }
    if (this.#stageRoot !== undefined) {
      try {
        rmSync(this.#stageRoot, { recursive: true, force: true });
      } catch {
        process.emitWarning(
          "Firedrill could not remove its private capture staging files. The saved drill verdict is unchanged; inspect local temporary-directory permissions.",
          { code: "FIREDRILL_CAPTURE_CLEANUP_FAILED" },
        );
      }
      this.#stageRoot = undefined;
    }
    this.#sessions.clear();
    this.#stageBytes = 0;
  }
}
