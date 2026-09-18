import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  BrowserTestDefinitionInput,
  BrowserTestEvent,
  BrowserTestResult,
  RunBrowserTestOptions,
} from "@firedrill-run/browser-tests";

const BASE = "/api/browser-tests";
type BrowserModule = typeof import("@firedrill-run/browser-tests");
interface BrowserRequest {
  readonly requestId: string;
  status: "running" | "finished" | "failed";
  readonly events: BrowserTestEvent[];
  frame?: { readonly mediaType: "image/jpeg"; readonly base64: string };
  result?: BrowserTestResult;
  error?: { readonly code: string; readonly message: string };
  readonly controller: AbortController;
  completion: Promise<void>;
}
export interface BrowserTestRequestStatus {
  readonly requestId: string;
  readonly status: BrowserRequest["status"];
  readonly events: readonly BrowserTestEvent[];
  readonly frame?: BrowserRequest["frame"];
  readonly result?: BrowserTestResult;
  readonly error?: BrowserRequest["error"];
}
class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function bad(message: string): never {
  throw new RequestError(400, "browser.INVALID_ARGUMENT", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) bad("Request contains unknown fields.");
}
function integer(value: unknown, fallback: number, maximum: number, zero = false): number {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < (zero ? 0 : 1) ||
    number > maximum
  )
    bad("Numeric option is outside its permitted range.");
  return number;
}
function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") bad("Expected a boolean option.");
  return value;
}
function authenticate(request: IncomingMessage, token: string) {
  let host: URL;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`);
  } catch {
    throw new RequestError(421, "framework.LOOPBACK_REQUIRED", "Request host must be loopback.");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) ||
    Number(host.port || 80) !== request.socket.localPort ||
    host.username ||
    host.password ||
    host.pathname !== "/" ||
    host.search ||
    host.hash
  )
    throw new RequestError(
      421,
      "framework.LOOPBACK_REQUIRED",
      "Request host must match this loopback listener.",
    );
  if (
    (request.headers.origin !== undefined && request.headers.origin !== host.origin) ||
    request.headers["sec-fetch-site"] === "cross-site"
  )
    throw new RequestError(
      421,
      "framework.SAME_ORIGIN_REQUIRED",
      "Browser control requires the inspector's exact origin.",
    );
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RequestError(401, "framework.CONTROL_UNAUTHORIZED", "Invalid local inspector token.");
}
function headers(contentType = "application/json; charset=utf-8") {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
function json(response: ServerResponse, status: number, value: unknown) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { ...headers(), "content-length": Buffer.byteLength(body) });
  response.end(body);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "browser.CONTENT_TYPE_REQUIRED", "Use application/json.");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes <= 256 * 1024) chunks.push(buffer);
  }
  if (bytes > 256 * 1024)
    throw new RequestError(413, "browser.REQUEST_TOO_LARGE", "Browser request exceeds 256 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    bad("Request must contain valid JSON.");
  }
  if (!object(parsed)) bad("Request body must be an object.");
  return parsed;
}
function snapshot(request: BrowserRequest): BrowserTestRequestStatus {
  return {
    requestId: request.requestId,
    status: request.status,
    events: request.events,
    ...(request.frame ? { frame: request.frame } : {}),
    ...(request.result ? { result: request.result } : {}),
    ...(request.error ? { error: request.error } : {}),
  };
}

/** The optional browser dependency is resolved only when this additive surface is requested. */
export function createBrowserTestRequestHandler(repositoryRoot: string, token: string) {
  const root = realpathSync(repositoryRoot);
  const requests = new Map<string, BrowserRequest>();
  let closed = false;
  let reserving = false;
  const load = async (): Promise<BrowserModule> => {
    try {
      return await import("@firedrill-run/browser-tests");
    } catch {
      throw new RequestError(
        503,
        "browser.PACKAGE_REQUIRED",
        "Install @firedrill-run/browser-tests in this project, then install its Chromium browser with playwright install chromium.",
      );
    }
  };
  const getRequest = (id: string) => {
    const request = requests.get(id);
    if (!request)
      throw new RequestError(
        404,
        "browser.REQUEST_NOT_FOUND",
        "Browser request was not found in this inspector session. Saved reports remain in the project.",
      );
    return request;
  };
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return false;
      }
      if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
      try {
        authenticate(request, token);
        if (closed) throw new RequestError(503, "browser.INSPECTOR_CLOSING", "Inspector is shutting down.");
        if (request.method === "GET" && url.pathname === BASE) {
          let available = false;
          let agentAvailable = false;
          try {
            await load();
            available = true;
          } catch {
            /* Optional installation. */
          }
          try {
            await import("@firedrill-run/agent/browser");
            agentAvailable = true;
          } catch {
            /* Optional installation. */
          }
          json(response, 200, {
            available,
            agentAvailable,
            apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
            activeRequestId:
              [...requests.values()].find((item) => item.status === "running")?.requestId ?? null,
          });
          return true;
        }
        const browser = await load();
        const paging = {
          root,
          offset: integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, true),
          limit: integer(url.searchParams.get("limit"), 20, 100),
        };
        if (request.method === "GET" && url.pathname === `${BASE}/saved`)
          json(response, 200, browser.listBrowserTests(paging));
        else if (request.method === "GET" && url.pathname === `${BASE}/reports`)
          json(response, 200, browser.listBrowserTestReports(paging));
        else if (request.method === "POST" && url.pathname === `${BASE}/requests`) {
          if (reserving || [...requests.values()].some((item) => item.status === "running"))
            throw new RequestError(
              409,
              "browser.ALREADY_RUNNING",
              "Stop or finish the current browser test before starting another.",
            );
          reserving = true;
          try {
            const input = await body(request);
            exact(input, [
              "definition",
              "path",
              "useAgent",
              "allowModel",
              "allowRemote",
              "allowedOrigins",
              "parameters",
              "capture",
              "headless",
              "timeoutMs",
              "stepTimeoutMs",
              "maxActions",
              "model",
              "maxBudgetUsd",
            ]);
            if ((input.definition === undefined) === (input.path === undefined))
              bad("Provide a definition or a saved path, not both.");
            if (input.path !== undefined && (typeof input.path !== "string" || input.path.length > 2000))
              bad("Saved test path must be a project-relative string.");
            let definition: BrowserTestDefinitionInput;
            try {
              definition =
                input.path === undefined
                  ? browser.BrowserTestDefinitionSchema.parse(input.definition)
                  : browser.loadBrowserTest({ root, path: input.path as string });
            } catch {
              bad("Browser definition is invalid or its project file could not be read.");
            }
            const useAgent = boolean(input.useAgent);
            if (
              input.model !== undefined &&
              (typeof input.model !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(input.model))
            )
              bad("Model must be a valid model name.");
            if (
              input.maxBudgetUsd !== undefined &&
              (typeof input.maxBudgetUsd !== "number" ||
                !Number.isFinite(input.maxBudgetUsd) ||
                input.maxBudgetUsd <= 0 ||
                input.maxBudgetUsd > 100)
            )
              bad("Model budget must be more than $0 and at most $100.");
            if (useAgent && !boolean(input.allowModel))
              bad("Starting the browser agent requires explicit model-use approval (allowModel: true).");
            let driver: RunBrowserTestOptions["driver"];
            if (useAgent) {
              let agent: typeof import("@firedrill-run/agent/browser");
              try {
                agent = await import("@firedrill-run/agent/browser");
              } catch {
                throw new RequestError(
                  503,
                  "browser.AGENT_PACKAGE_REQUIRED",
                  "Install @firedrill-run/agent to use the optional browser agent.",
                );
              }
              if (!process.env.ANTHROPIC_API_KEY)
                bad(
                  "Set ANTHROPIC_API_KEY in the terminal that starts the inspector. Never paste it into a browser request.",
                );
              driver = agent.createBrowserAgentDriver({
                environment: {
                  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
                  PATH: process.env.PATH,
                  LANG: process.env.LANG,
                },
                ...(input.model === undefined ? {} : { model: input.model as string }),
                ...(input.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.maxBudgetUsd as number }),
              });
            }
            let parameters: Record<string, string> | undefined;
            if (input.parameters !== undefined) {
              if (
                !object(input.parameters) ||
                Object.keys(input.parameters).length > 50 ||
                Object.entries(input.parameters).some(
                  ([key, value]) =>
                    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(key) ||
                    typeof value !== "string" ||
                    value.length > 20000,
                )
              )
                bad("Parameters must contain at most 50 named strings.");
              parameters = input.parameters as Record<string, string>;
            }
            let capture: RunBrowserTestOptions["capture"];
            if (input.capture !== undefined) {
              if (!object(input.capture)) bad("Capture must be an object.");
              exact(input.capture, ["screenshot", "video", "trace"]);
              if (
                Object.values(input.capture).some(
                  (value) => !["off", "always", "retain-on-failure"].includes(value as string),
                )
              )
                bad("Invalid capture policy.");
              capture = input.capture as RunBrowserTestOptions["capture"];
            }
            if (
              input.allowedOrigins !== undefined &&
              (!Array.isArray(input.allowedOrigins) ||
                input.allowedOrigins.length > 32 ||
                input.allowedOrigins.some((value) => typeof value !== "string" || value.length > 4000))
            )
              bad("Allowed origins must be a bounded list of URLs.");
            const runOptions: RunBrowserTestOptions = {
              root,
              definition,
              ...(driver ? { driver } : {}),
              ...(parameters ? { parameters } : {}),
              ...(capture ? { capture } : {}),
              allowRemote: boolean(input.allowRemote),
              headless: boolean(input.headless, true),
              timeoutMs: integer(input.timeoutMs, 120000, 1200000),
              stepTimeoutMs: integer(input.stepTimeoutMs, 5000, 60000),
              maxActions: integer(input.maxActions, 100, 500),
              ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins as string[] } : {}),
            };
            if (closed)
              throw new RequestError(503, "browser.INSPECTOR_CLOSING", "Inspector is shutting down.");
            while (requests.size >= 50) {
              const oldest = requests.keys().next().value;
              if (oldest) requests.delete(oldest);
            }
            const current: BrowserRequest = {
              requestId: `request_${randomUUID().replaceAll("-", "")}`,
              status: "running",
              events: [],
              controller: new AbortController(),
              completion: Promise.resolve(),
            };
            requests.set(current.requestId, current);
            current.completion = browser
              .runBrowserTest({
                ...runOptions,
                signal: current.controller.signal,
                onEvent: (event) => {
                  current.events.push(event);
                },
                onFrame: (frame) => {
                  current.frame = frame;
                },
              })
              .then((result) => {
                current.result = result;
                current.status = "finished";
              })
              .catch((error) => {
                current.status = "failed";
                current.error = {
                  code: error instanceof browser.BrowserTestError ? error.code : "browser.EXECUTION_FAILED",
                  message:
                    "The browser test could not start or finish. Check its definition, permissions and installed Chromium browser.",
                };
              })
              .finally(() => {
                delete current.frame;
              });
            json(response, 202, { requestId: current.requestId, status: current.status });
          } finally {
            reserving = false;
          }
        } else {
          const matched = /^\/api\/browser-tests\/requests\/(request_[a-f0-9]{32})(?:\/(cancel|save))?$/.exec(
            url.pathname,
          );
          const artifact =
            /^\/api\/browser-tests\/reports\/(browser_[a-f0-9]{32})\/artifacts\/([A-Za-z0-9._-]+)$/.exec(
              url.pathname,
            );
          const detail = /^\/api\/browser-tests\/reports\/(browser_[a-f0-9]{32})$/.exec(url.pathname);
          const collectionAction =
            /^\/api\/browser-tests\/reports\/(browser_[a-f0-9]{32})\/(bundle|save)$/.exec(url.pathname);
          if (matched) {
            const current = getRequest(matched[1] as string);
            if (request.method === "GET" && !matched[2]) json(response, 200, snapshot(current));
            else if (request.method === "POST" && matched[2] === "cancel") {
              current.controller.abort();
              json(response, 202, { requestId: current.requestId, status: current.status });
            } else if (request.method === "POST" && matched[2] === "save") {
              if (!current.result)
                throw new RequestError(
                  409,
                  "browser.RESULT_REQUIRED",
                  "Wait for the browser test to finish before saving its recorded steps.",
                );
              const input = await body(request);
              exact(input, ["id", "title", "path"]);
              if (input.id !== undefined && typeof input.id !== "string")
                bad("Saved test ID must be a string.");
              if (input.title !== undefined && typeof input.title !== "string")
                bad("Saved test title must be a string.");
              if (input.path !== undefined && typeof input.path !== "string")
                bad("Save path must be a string.");
              let definition: BrowserTestDefinitionInput;
              try {
                definition = browser.browserTestDefinitionFromResult({
                  result: current.result,
                  ...(input.id === undefined ? {} : { id: input.id as string }),
                  ...(input.title === undefined ? {} : { title: input.title as string }),
                });
              } catch (error) {
                if (
                  error instanceof browser.BrowserTestError &&
                  error.code === "browser.REPLAY_REVIEW_REQUIRED"
                )
                  throw new RequestError(409, error.code, error.message);
                bad(
                  "Recorded steps require source review, or the saved test name is invalid. Sensitive values are not saved into source.",
                );
              }
              try {
                const path = browser.saveBrowserTest({
                  root,
                  definition,
                  ...(input.path === undefined ? {} : { path: input.path as string }),
                });
                json(response, 201, { path, definition });
              } catch {
                throw new RequestError(
                  409,
                  "browser.SAVE_FAILED",
                  "Choose a new JSON filename inside the project. Existing source is never overwritten.",
                );
              }
            } else throw new RequestError(405, "browser.METHOD_NOT_ALLOWED", "Method is not supported.");
          } else if (
            (artifact || detail || collectionAction) &&
            (request.method === "GET" || (request.method === "POST" && collectionAction?.[2] === "save"))
          ) {
            const directory = join(
              root,
              ".firedrill",
              "browser",
              (artifact?.[1] ?? detail?.[1] ?? collectionAction?.[1]) as string,
            );
            let result: BrowserTestResult;
            try {
              if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink())
                throw new Error("Unsafe directory");
              result = browser.verifyBrowserTestReport(directory);
            } catch {
              throw new RequestError(
                404,
                "browser.REPORT_INVALID",
                "The saved browser report is missing, incomplete or changed.",
              );
            }
            if (detail) {
              json(response, 200, result);
              return true;
            }
            if (collectionAction?.[2] === "bundle" && request.method === "GET") {
              const bundle = await browser.bundleBrowserTestReport(directory);
              response.writeHead(200, {
                ...headers(bundle.mediaType),
                "content-length": bundle.bytes.length,
                "content-disposition": `attachment; filename="${bundle.filename}"`,
              });
              response.end(bundle.bytes);
              return true;
            }
            if (collectionAction?.[2] === "save" && request.method === "POST") {
              const input = await body(request);
              exact(input, ["id", "title", "path"]);
              if (input.id !== undefined && typeof input.id !== "string")
                bad("Saved test ID must be a string.");
              if (input.title !== undefined && typeof input.title !== "string")
                bad("Saved test title must be a string.");
              if (input.path !== undefined && typeof input.path !== "string")
                bad("Saved test path must be a string.");
              try {
                const definition = browser.browserTestDefinitionFromResult({
                  result,
                  ...(input.id === undefined ? {} : { id: input.id as string }),
                  ...(input.title === undefined ? {} : { title: input.title as string }),
                });
                const path = browser.saveBrowserTest({
                  root,
                  definition,
                  ...(input.path === undefined ? {} : { path: input.path as string }),
                });
                json(response, 201, { path, definition });
                return true;
              } catch (error) {
                if (
                  error instanceof browser.BrowserTestError &&
                  error.code === "browser.REPLAY_REVIEW_REQUIRED"
                )
                  throw new RequestError(409, error.code, error.message);
                throw new RequestError(
                  409,
                  "browser.SAVE_FAILED",
                  "Review recorded source and choose an unused JSON filename. Redacted execution fields need manual repair before reuse.",
                );
              }
            }
            if (!artifact)
              throw new RequestError(404, "browser.ARTIFACT_NOT_FOUND", "Browser artifact was not found.");
            const filename = artifact[2] as string;
            if (
              ![
                "index.html",
                "report.json",
                "test.browser.json",
                "manifest.json",
                ...result.artifacts.map((item) => item.path),
              ].includes(filename)
            )
              throw new RequestError(404, "browser.ARTIFACT_NOT_FOUND", "Browser artifact was not found.");
            const contentTypes: Record<string, string> = {
              "index.html": "text/html; charset=utf-8",
              "report.json": "application/json",
              "test.browser.json": "application/json",
              "manifest.json": "application/json",
              "screenshot.png": "image/png",
              "video.webm": "video/webm",
              "trace.zip": "application/zip",
            };
            const content = readFileSync(join(directory, filename));
            response.writeHead(200, {
              ...headers(contentTypes[filename] ?? "application/octet-stream"),
              "content-length": content.length,
              "content-disposition": `inline; filename="${filename}"`,
            });
            response.end(content);
          } else throw new RequestError(404, "browser.ROUTE_NOT_FOUND", "Browser test route was not found.");
        }
      } catch (error) {
        json(response, error instanceof RequestError ? error.status : 400, {
          error: {
            code: error instanceof RequestError ? error.code : "browser.INVALID_ARGUMENT",
            message:
              error instanceof RequestError
                ? error.message
                : "The browser request could not be completed. Check the selected project source and request values.",
          },
        });
      }
      return true;
    },
    async close(): Promise<void> {
      closed = true;
      for (const request of requests.values()) request.controller.abort();
      await Promise.all([...requests.values()].map((request) => request.completion));
      requests.clear();
    },
  };
}
