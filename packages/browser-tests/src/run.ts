import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import {
  ASSERTION_DIAGNOSTIC_LIMIT,
  type BrowserAssertion,
  type BrowserAssertionResult,
  type BrowserSelector,
  type BrowserStep,
  BrowserStepSchema,
  type BrowserTestArtifact,
  type BrowserTestDefinitionInput,
  BrowserTestDefinitionSchema,
  BrowserTestError,
  type BrowserTestEvent,
  type BrowserTestResult,
} from "./contracts.js";
import { digest, inside } from "./files.js";
import { type BrowserProxy, startBrowserProxy } from "./proxy.js";
import { recordedReplayIssues } from "./replay.js";
import { writeBrowserReport } from "./report.js";

export interface BrowserTestDriverContext {
  readonly task: string;
  readonly signal: AbortSignal;
  readonly parameterNames: readonly string[];
  observe(): Promise<{ readonly url: string; readonly snapshot: string }>;
  step(step: BrowserStep): Promise<void>;
}
export type BrowserTestDriver = (context: BrowserTestDriverContext) => Promise<void>;
export interface RunBrowserTestOptions {
  readonly root?: string;
  readonly definition: BrowserTestDefinitionInput;
  /** Runtime-only values. Never included in saved definitions or text reports. */
  readonly parameters?: Readonly<Record<string, string>>;
  readonly driver?: BrowserTestDriver;
  readonly signal?: AbortSignal;
  readonly headless?: boolean;
  /** Browser application origins only. Model-provider traffic belongs to the optional driver. */
  readonly allowedOrigins?: readonly string[];
  readonly allowRemote?: boolean;
  readonly timeoutMs?: number;
  readonly stepTimeoutMs?: number;
  readonly maxActions?: number;
  readonly reportDirectory?: string;
  readonly capture?: {
    readonly screenshot?: "off" | "always" | "retain-on-failure";
    readonly video?: "off" | "always" | "retain-on-failure";
    readonly trace?: "off" | "always" | "retain-on-failure";
  };
  readonly mask?: readonly BrowserSelector[];
  readonly onEvent?: (event: BrowserTestEvent) => void;
  /** Ephemeral JPEG preview. Opt-in; no frames retained in event history. */
  readonly onFrame?: (frame: { readonly mediaType: "image/jpeg"; readonly base64: string }) => void;
}

function locator(page: Page, selector: BrowserSelector): Locator {
  switch (selector.by) {
    case "role":
      return page.getByRole(selector.role, { name: selector.name, exact: true });
    case "label":
      return page.getByLabel(selector.value, { exact: true });
    case "text":
      return page.getByText(selector.value, { exact: true });
    case "testId":
      return page.getByTestId(selector.value);
    case "css":
      return page.locator(selector.value);
  }
}
function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
    throw new BrowserTestError(
      "browser.INVALID_OPTIONS",
      `${name} must be an integer from 1 through ${maximum}.`,
    );
  return selected;
}
function local(url: URL) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
function targetUrl(value: string, allowRemote: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserTestError("browser.INVALID_URL", "Browser tests require an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new BrowserTestError("browser.INVALID_URL", "Use HTTP or HTTPS without credentials in the URL.");
  if (!allowRemote && !local(parsed))
    throw new BrowserTestError(
      "browser.REMOTE_ORIGIN_REQUIRES_OPT_IN",
      "Testing a remote application requires allowRemote: true and permission to exercise that application.",
    );
  return parsed;
}
function keep(policy: "off" | "always" | "retain-on-failure", status: BrowserTestResult["status"]) {
  return (
    policy === "always" || (policy === "retain-on-failure" && (status === "failed" || status === "cancelled"))
  );
}
function selectorLabel(selector: BrowserSelector) {
  return selector.by === "role"
    ? `${selector.role} “${selector.name}”`
    : `${selector.by} “${selector.value}”`;
}
function stepLabel(step: BrowserStep) {
  switch (step.action) {
    case "navigate":
      return "Navigate to the configured page";
    case "fill":
      return `Fill ${selectorLabel(step.selector)}`;
    case "click":
      return `Click ${selectorLabel(step.selector)}`;
    case "press":
      return `Press ${step.key} on ${selectorLabel(step.selector)}`;
    case "wait":
      return `Wait ${step.milliseconds} ms`;
  }
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new BrowserTestError("browser.CANCELLED", "Browser test stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new BrowserTestError("browser.CANCELLED", "Browser test stopped."));
    // Attach rejection handling even when the deadline races the driver's startup.
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
function captureOnlyError(code: string) {
  return code === "browser.CAPTURE_LIMIT" || code === "browser.CAPTURE_UNAVAILABLE";
}
async function readAssertion(page: Page, assertion: BrowserAssertion, base: URL) {
  if (assertion.kind === "url")
    return { actual: page.url(), expected: new URL(assertion.expected, base).href };
  const element = locator(page, assertion.selector);
  if (assertion.kind === "visible")
    return { actual: await element.isVisible(), expected: assertion.expected };
  if (assertion.kind === "text")
    return {
      actual: ((await element.textContent({ timeout: 100 })) ?? "").trim(),
      expected: assertion.expected,
    };
  return { actual: await element.inputValue({ timeout: 100 }), expected: assertion.expected };
}

/** Owns only an optional browser test driver. The application/agent under test stays caller-owned. */
export async function runBrowserTest(options: RunBrowserTestOptions): Promise<BrowserTestResult> {
  const definition = BrowserTestDefinitionSchema.parse(options.definition);
  const root = realpathSync(options.root ?? process.cwd());
  const start = targetUrl(definition.startUrl, options.allowRemote === true);
  const origins = new Set([
    start.origin,
    ...(options.allowedOrigins ?? []).map((value) => targetUrl(value, options.allowRemote === true).origin),
  ]);
  if (origins.size > 32)
    throw new BrowserTestError(
      "browser.INVALID_OPTIONS",
      "A browser test can allow at most 32 application origins.",
    );
  const timeoutMs = boundedInteger(options.timeoutMs, 120000, 1200000, "timeoutMs");
  const stepTimeoutMs = boundedInteger(options.stepTimeoutMs, 5000, 60000, "stepTimeoutMs");
  const maxActions = boundedInteger(options.maxActions, 100, 500, "maxActions");
  if (definition.task && options.driver === undefined && definition.steps.length === 0)
    throw new BrowserTestError(
      "browser.DRIVER_REQUIRED",
      "This test has a task but no recorded steps. Use the optional browser agent or provide a browser driver.",
    );
  const policies = {
    screenshot: "always" as const,
    video: "off" as const,
    trace: "off" as const,
    ...options.capture,
  };
  for (const value of Object.values(policies))
    if (!["off", "always", "retain-on-failure"].includes(value))
      throw new BrowserTestError(
        "browser.INVALID_OPTIONS",
        "Capture policy must be off, always or retain-on-failure.",
      );
  const parameters = options.parameters ?? {};
  if (
    Object.entries(parameters).some(
      ([key, value]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(key) || typeof value !== "string" || value.length > 20000,
    )
  )
    throw new BrowserTestError(
      "browser.INVALID_OPTIONS",
      "Runtime parameters must be named bounded strings.",
    );
  for (const step of definition.steps)
    if (step.action === "fill" && step.parameter !== undefined && parameters[step.parameter] === undefined)
      throw new BrowserTestError(
        "browser.PARAMETER_MISSING",
        `Provide the runtime parameter ${step.parameter}.`,
      );
  options.signal?.throwIfAborted();
  const runId = `browser_${randomUUID().replaceAll("-", "")}`;
  const reportDirectory = inside(root, `${options.reportDirectory ?? ".firedrill/browser"}/${runId}`);
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const privateCapture = mkdtempSync(join(tmpdir(), "firedrill-browser-capture-"));
  const sensitive = new Set(Object.values(parameters).filter(Boolean));
  for (const step of definition.steps) if (step.action === "fill" && step.value) sensitive.add(step.value);
  const redact = (value: string) =>
    [...sensitive]
      .sort((a, b) => b.length - a.length)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const events: BrowserTestEvent[] = [];
  const errors: { code: string; message: string }[] = [];
  const steps: BrowserStep[] = [];
  const assertions: BrowserAssertionResult[] = [];
  const artifacts: BrowserTestArtifact[] = [];
  const emit = (type: BrowserTestEvent["type"], message: string) => {
    if (events.length >= 2000) return;
    const event = {
      sequence: events.length + 1,
      type,
      message: redact(message).slice(0, 4000),
      elapsedMs: Date.now() - started,
    };
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      /* An observer must not break browser cleanup or verdicts. */
    }
  };
  let browser: Browser | undefined;
  let proxy: BrowserProxy | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let framePending = false;
  let status: BrowserTestResult["status"] = "completed";
  let attemptedActions = 0;
  const abortBrowser = () => {
    void context?.close().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", abortBrowser, { once: true });
  const masks: BrowserSelector[] = [...(options.mask ?? [])];
  const addArtifact = (name: string, mediaType: string) => {
    const path = join(reportDirectory, name);
    const bytes = statSync(path).size;
    if (
      bytes > 64 * 1024 * 1024 ||
      artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) + bytes > 120 * 1024 * 1024
    ) {
      rmSync(path);
      errors.push({
        code: "browser.CAPTURE_LIMIT",
        message: "A capture exceeded the report size limit and was not retained.",
      });
      return;
    }
    artifacts.push({ path: name, mediaType, bytes, sha256: digest(readFileSync(path)) });
  };
  const permitted = (url: string) => {
    try {
      const parsed = new URL(url);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        origins.has(parsed.origin)
      );
    } catch {
      return false;
    }
  };
  try {
    emit("started", "Starting an isolated browser context");
    proxy = await startBrowserProxy({
      origins,
      timeoutMs,
      blocked: (message) => {
        if (errors.length < 50) errors.push({ code: "browser.ORIGIN_BLOCKED", message });
        emit("blocked-request", message);
      },
    });
    browser = await chromium.launch({
      headless: options.headless !== false,
      timeout: Math.min(timeoutMs, 30000),
      proxy: { server: proxy.url, username: proxy.username, password: proxy.password, bypass: "<-loopback>" },
      args: [
        "--disable-background-networking",
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        // Prevent HTTP/2 connection coalescing across origins inside one CONNECT tunnel.
        "--disable-http2",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    controller.signal.throwIfAborted();
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(policies.video === "off" ? {} : { recordVideo: { dir: privateCapture } }),
    });
    context.setDefaultTimeout(stepTimeoutMs);
    context.setDefaultNavigationTimeout(stepTimeoutMs);
    context.on("page", (extra) => {
      if (page !== undefined && extra !== page) {
        emit("log", "Closed an unsupported popup; this browser test uses one page");
        void extra.close().catch(() => undefined);
      }
    });
    page = await context.newPage();
    page.on("framenavigated", (frame) => {
      const url = frame.url();
      if (url !== "about:blank" && url !== "about:srcdoc" && !permitted(url)) {
        if (errors.length < 50)
          errors.push({
            code: "browser.ORIGIN_BLOCKED",
            message: "A browser frame navigated outside the approved HTTP application origins.",
          });
        emit("blocked-request", "Stopped an unapproved frame navigation");
        void page?.close().catch(() => undefined);
      }
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
      emit("log", "Dismissed a browser dialog");
    });
    page.on("pageerror", () =>
      emit("log", "The application reported a JavaScript error; inspect an opt-in trace for details"),
    );
    if (policies.trace !== "off")
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    if (options.onFrame)
      frameTimer = setInterval(() => {
        if (!page || page.isClosed() || framePending || controller.signal.aborted) return;
        framePending = true;
        void page
          .screenshot({
            type: "jpeg",
            quality: 55,
            timeout: 1000,
            mask: [
              ...masks.map((item) => locator(page as Page, item)),
              page.locator('input[type="password"]'),
            ],
          })
          .then((body) => options.onFrame?.({ mediaType: "image/jpeg", base64: body.toString("base64") }))
          .catch(() => undefined)
          .finally(() => {
            framePending = false;
          });
      }, 1000);
    const initialResponse = await page.goto(start.href, { waitUntil: "domcontentloaded" });
    if (initialResponse && initialResponse.status() >= 400)
      throw new BrowserTestError(
        "browser.HTTP_ERROR",
        `The start page returned HTTP ${initialResponse.status()}.`,
      );
    const activePage = page;
    const perform = async (raw: BrowserStep) => {
      controller.signal.throwIfAborted();
      const step = BrowserStepSchema.parse(raw);
      if (attemptedActions++ >= maxActions) {
        if (!errors.some((error) => error.code === "browser.ACTION_LIMIT"))
          errors.push({
            code: "browser.ACTION_LIMIT",
            message: `Browser test exceeded ${maxActions} actions.`,
          });
        throw new BrowserTestError("browser.ACTION_LIMIT", `Browser test exceeded ${maxActions} actions.`);
      }
      const recorded =
        step.action === "fill" && step.value !== undefined
          ? { action: "fill" as const, selector: step.selector, parameter: `fill-${steps.length + 1}` }
          : step;
      if (step.action === "fill") {
        const value = step.parameter === undefined ? step.value : parameters[step.parameter];
        if (value === undefined)
          throw new BrowserTestError(
            "browser.PARAMETER_MISSING",
            `Provide runtime parameter ${step.parameter}.`,
          );
        if (value) sensitive.add(value);
        masks.push(step.selector);
        await locator(activePage, step.selector).fill(value);
      } else if (step.action === "navigate") {
        const url = new URL(step.url, start).href;
        if (!permitted(url))
          throw new BrowserTestError("browser.ORIGIN_BLOCKED", "Navigation requested an unapproved origin.");
        const response = await activePage.goto(url, { waitUntil: "domcontentloaded" });
        if (response && response.status() >= 400)
          throw new BrowserTestError("browser.HTTP_ERROR", `The page returned HTTP ${response.status()}.`);
      } else if (step.action === "click") await locator(activePage, step.selector).click();
      else if (step.action === "press") await locator(activePage, step.selector).press(step.key);
      else await pause(step.milliseconds, controller.signal);
      steps.push(recorded);
      emit("step", stepLabel(recorded));
    };
    for (const step of definition.steps) await perform(step);
    if (options.driver)
      await abortable(
        options.driver({
          task: definition.task ?? "",
          signal: controller.signal,
          parameterNames: Object.keys(parameters),
          step: perform,
          observe: async () => {
            controller.signal.throwIfAborted();
            return {
              url: redact(activePage.url()),
              snapshot: redact(
                (await activePage.locator("body").ariaSnapshot({ timeout: stepTimeoutMs })).slice(0, 30000),
              ),
            };
          },
        }),
        controller.signal,
      );
    for (const assertion of definition.assertions) {
      controller.signal.throwIfAborted();
      const until = Date.now() + stepTimeoutMs;
      let actual: string | boolean | null = null;
      let expected: string | boolean = assertion.expected;
      let passed = false;
      do {
        try {
          const observed = await readAssertion(activePage, assertion, start);
          actual = observed.actual;
          expected = observed.expected;
          passed =
            assertion.kind === "text" && assertion.contains && typeof actual === "string"
              ? actual.includes(String(expected))
              : actual === expected;
        } catch {
          actual = null;
        }
        if (passed || Date.now() >= until) break;
        await pause(50, controller.signal);
      } while (!controller.signal.aborted);
      // Evaluate complete values above, then bound only the retained diagnostics.
      const safeExpected = typeof expected === "string" ? redact(expected) : expected;
      const safeActual = typeof actual === "string" ? redact(actual) : actual;
      assertions.push({
        id: assertion.id,
        kind: assertion.kind,
        passed,
        expected:
          typeof safeExpected === "string" ? safeExpected.slice(0, ASSERTION_DIAGNOSTIC_LIMIT) : safeExpected,
        actual: typeof safeActual === "string" ? safeActual.slice(0, ASSERTION_DIAGNOSTIC_LIMIT) : safeActual,
        ...(typeof safeExpected === "string" && safeExpected.length > ASSERTION_DIAGNOSTIC_LIMIT
          ? { expectedTruncation: { fullLength: safeExpected.length } }
          : {}),
        ...(typeof safeActual === "string" && safeActual.length > ASSERTION_DIAGNOSTIC_LIMIT
          ? { actualTruncation: { fullLength: safeActual.length } }
          : {}),
      });
      emit("assertion", `${assertion.id}: ${passed ? "passed" : "failed"}`);
    }
    status =
      errors.length || assertions.some((item) => !item.passed)
        ? "failed"
        : assertions.length
          ? "passed"
          : "completed";
  } catch (error) {
    status = controller.signal.aborted && !timedOut ? "cancelled" : "failed";
    errors.push({
      code: timedOut
        ? "browser.TIMEOUT"
        : controller.signal.aborted
          ? "browser.CANCELLED"
          : error instanceof BrowserTestError
            ? error.code
            : "browser.EXECUTION_FAILED",
      message: timedOut
        ? "Browser test exceeded its wall-clock deadline."
        : controller.signal.aborted
          ? "Browser test was cancelled."
          : error instanceof BrowserTestError
            ? redact(error.message)
            : "The browser operation failed. Check the application URL, selectors, or installed Playwright browser. Run playwright install chromium if the browser is missing.",
    });
  } finally {
    if (frameTimer) clearInterval(frameTimer);
    try {
      if (page && !page.isClosed() && keep(policies.screenshot, status)) {
        await page.screenshot({
          path: join(reportDirectory, "screenshot.png"),
          timeout: 3000,
          mask: [...masks.map((item) => locator(page as Page, item)), page.locator('input[type="password"]')],
        });
        addArtifact("screenshot.png", "image/png");
      }
      if (context && policies.trace !== "off") {
        if (keep(policies.trace, status)) {
          await context.tracing.stop({ path: join(reportDirectory, "trace.zip") });
          addArtifact("trace.zip", "application/zip");
        } else await context.tracing.stop();
      }
    } catch {
      errors.push({
        code: "browser.CAPTURE_UNAVAILABLE",
        message: "A browser capture could not be completed. The browser assertion result is unchanged.",
      });
    }
    const video = page?.video();
    await context?.close().catch(() => undefined);
    if (video && keep(policies.video, status)) {
      try {
        copyFileSync(await video.path(), join(reportDirectory, "video.webm"));
        addArtifact("video.webm", "video/webm");
      } catch {
        errors.push({ code: "browser.CAPTURE_UNAVAILABLE", message: "Browser video was not available." });
      }
    }
    await browser?.close().catch(() => undefined);
    await proxy?.close();
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", abortBrowser);
    options.signal?.removeEventListener("abort", cancel);
    rmSync(privateCapture, { recursive: true, force: true });
  }
  if (status !== "cancelled" && errors.some((error) => !captureOnlyError(error.code))) status = "failed";
  emit(
    "finished",
    status === "completed"
      ? "Browser flow completed without independent assertions"
      : `Browser test ${status}`,
  );
  const schemaKeys = new Set(["id", "action", "by", "role", "parameter", "kind"]);
  const redactUrl = (value: string) => {
    try {
      const url = new URL(value);
      url.pathname = redact(url.pathname);
      url.search = redact(url.search);
      url.hash = redact(url.hash);
      return url.href;
    } catch {
      return redact(value);
    }
  };
  const safeDefinition = JSON.parse(
    JSON.stringify({ ...definition, steps }, (key, value: unknown) =>
      typeof value === "string" && !schemaKeys.has(key)
        ? ["startUrl", "url"].includes(key)
          ? redactUrl(value)
          : redact(value)
        : value,
    ),
  ) as BrowserTestResult["definition"];
  const replayIssues = [...recordedReplayIssues({ ...definition, steps }, safeDefinition)];
  if (status === "cancelled" || errors.some((error) => !captureOnlyError(error.code)))
    replayIssues.push(
      "steps: execution stopped before a complete flow was recorded; review the observed actions before reuse.",
    );
  const result: BrowserTestResult = {
    schemaVersion: 1,
    kind: "browser-test",
    runId,
    definition: safeDefinition,
    status,
    worldVerified: false,
    replayable: replayIssues.length === 0,
    replayIssues,
    durationMs: Date.now() - started,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: safeDefinition.steps,
    assertions,
    events,
    errors,
    artifacts,
    reportDirectory,
    reportPath: join(reportDirectory, "index.html"),
  };
  writeBrowserReport(result);
  return result;
}
