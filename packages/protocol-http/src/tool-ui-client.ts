/** Browser-side syntax checking only. The serving transport must authenticate every request. */
export interface ToolUiClientOptions {
  readonly credentialFormat?: "opaque" | "signed";
  readonly maxCredentialBytes?: number;
}

/** Same-origin browser module for the canonical Tool app protocol. Contains no credentials. */
export function createToolUiClientSource(options: ToolUiClientOptions = {}): string {
  const format = options.credentialFormat ?? "opaque";
  const maximum = options.maxCredentialBytes ?? (format === "opaque" ? 43 : 4096);
  if (
    !["opaque", "signed"].includes(format) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 43 ||
    maximum > 16384
  )
    throw new TypeError("Tool app credential format or byte bound is invalid");
  const pattern = format === "opaque" ? "^[A-Za-z0-9_-]{43}$" : "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+){1,2}$";
  return `
const credentialPattern = new RegExp(${JSON.stringify(pattern)});
function validToken(value) {
  return typeof value === "string" && value.length >= 43 && value.length <= ${maximum} && credentialPattern.test(value);
}
const storageKey = "firedrill.tool-ui.token.v1";
const fragment = new URLSearchParams(location.hash.slice(1));
let token;
if (fragment.has("token")) {
  const candidate = fragment.get("token");
  // Clear even invalid credentials before any request or application rendering.
  history.replaceState(history.state, "", location.pathname + location.search);
  if (validToken(candidate)) {
    token = candidate;
    try { sessionStorage.setItem(storageKey, token); } catch { /* Memory-only when storage is disabled. */ }
  } else {
    try { sessionStorage.removeItem(storageKey); } catch { /* No persistent credential. */ }
  }
} else {
  try { token = sessionStorage.getItem(storageKey); } catch { /* Reopen the original app link. */ }
}

async function request(path, body) {
  if (!validToken(token)) {
    throw new Error("Open this Tool app from its local Firedrill app link to connect.");
  }
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    mode: "same-origin",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (value?.schemaVersion !== 1) throw new Error("Invalid local Tool response.");
  return { response, value };
}

/** Read-only connection metadata. Checking revision never writes world evidence. */
export async function getContext() {
  const { response, value } = await request("/_firedrill/context");
  if (!response.ok || typeof value.packageId !== "string" || typeof value.actorId !== "string" ||
      typeof value.worldInstanceId !== "string" || typeof value.title !== "string") {
    throw new Error("Local Tool connection is unavailable. Reopen the app from Firedrill.");
  }
  return value;
}

/** No automatic retry. Reuse the same idempotencyKey when reconciling one uncertain mutation. */
export async function invoke(operationId, arguments_, options = {}) {
  if (typeof operationId !== "string" || typeof arguments_ !== "object" || arguments_ === null ||
      Array.isArray(arguments_) || typeof options !== "object" || options === null ||
      Array.isArray(options) || Object.keys(options).some(key => key !== "idempotencyKey") ||
      (options.idempotencyKey !== undefined && typeof options.idempotencyKey !== "string")) {
    throw new TypeError("invoke accepts an operation id, argument object, and optional idempotencyKey.");
  }
  const { value } = await request("/_firedrill/invoke", {
    operationId, arguments: arguments_,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  });
  if (typeof value.callId !== "string" || typeof value.correlationId !== "string" ||
      !["ok", "denied", "unsupported", "invalid", "tool_error"].includes(value.outcome?.status)) {
    throw new Error("Local Tool invocation failed before returning an operation outcome.");
  }
  return value;
}
`;
}

/** Default local opaque credential behavior, retained for existing listeners. */
export const TOOL_UI_CLIENT_SOURCE = createToolUiClientSource();
