/** Served as a same-origin ES module. It contains no world or inspector credential. */
export const TOOL_UI_CLIENT_SOURCE = `
const storageKey = "firedrill.tool-ui.token.v1";
const fragment = new URLSearchParams(location.hash.slice(1));
let token;
if (fragment.has("token")) {
  const candidate = fragment.get("token");
  // Clear even invalid credentials before any request or application rendering.
  history.replaceState(history.state, "", location.pathname + location.search);
  if (/^[A-Za-z0-9_-]{43}$/.test(candidate ?? "")) {
    token = candidate;
    try { sessionStorage.setItem(storageKey, token); } catch { /* Memory-only when storage is disabled. */ }
  } else {
    try { sessionStorage.removeItem(storageKey); } catch { /* No persistent credential. */ }
  }
} else {
  try { token = sessionStorage.getItem(storageKey); } catch { /* Reopen the original app link. */ }
}

async function request(path, body) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) {
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
