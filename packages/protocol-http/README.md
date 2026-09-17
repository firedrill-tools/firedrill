# `@firedrill-tools/protocol-http`

Loopback HTTP access to one local synthetic world. The adapter exposes only Tool operations granted to the drill's selected actor and delegates every call to the generic kernel.

A command, HTTP, or caller-owned target receives:

- `FIREDRILL_HTTP_URL` — the per-trial loopback base URL;
- `FIREDRILL_HTTP_TOKEN` — the per-trial bearer credential.

Every generic HTTP world binding retains Firedrill's operation routes:

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated process readiness only |
| `GET /v1/tools` | Lists available Tool packages, operations, schemas, idempotency, and fidelity |
| `POST /v1/operations/{packageId}/{operationId}` | Calls one operation as the bound scenario actor |

Authenticated requests use `Authorization: Bearer <FIREDRILL_HTTP_TOKEN>`. An operation body contains `arguments` and, when the operation requires it, an `idempotencyKey`:

```json
{
  "arguments": { "value": 7 },
  "idempotencyKey": "set-primary-7"
}
```

Every operation response contains `schemaVersion`, `callId`, `correlationId`, and `outcome`. `outcome.status` is one of `ok`, `denied`, `tool_error`, `unsupported`, or `invalid`; successful values and structured failures use the same public operation contracts regardless of Tool domain.

This is Firedrill's stable generic operation protocol. It does not by itself claim wire compatibility with another REST API. When an existing agent uses a different client shape, point its existing test configuration at a Tool-declared synthetic route or translate through a separate test-only adapter. Production agent logic and Tool-specific protocol core remain unchanged.

## Optional Tool apps

`startToolUiBinding()` serves one Tool's verified build assets on a separate ephemeral `127.0.0.1` origin. The SDK's `world.listen()` composes it automatically for each declared UI. It receives only immutable asset bytes, that Tool's manifest, an actor-bound `invoke` facade, and optional read-only revision metadata. It never reads live source files or exposes generic HTTP, inspector, database, reset, or cross-Tool control routes.

Browser code imports the standard same-origin module from an external JavaScript asset:

```js
import { getContext, invoke } from "/_firedrill/client.js";

const context = await getContext();
// Use an operation declared by this Tool and granted to context.actorId.
const result = await invoke("items.read", { id: "primary" });
if (result.outcome.status === "ok") renderItem(result.outcome.value);
else renderOperationError(result.outcome.error);
```

`getContext()` returns `{ schemaVersion: 1, worldInstanceId, actorId, packageId, title, revision? }`. SDK apps include `revision: { generation, evidenceSequence }`, tracking state changes, events, clock, fault controls and lifecycle changes—not read-only operation receipts. Reading it does not issue a Tool operation or append evidence; compare both fields to detect changes and resets before refreshing displayed data. Evidence sequence can rewind on reset, so never compare that number alone. The hint contains no world state or evidence payload.

`invoke(operationId, arguments, { idempotencyKey? })` returns the same canonical `{ schemaVersion, callId, correlationId, outcome }` envelope as generic HTTP, including denied, invalid and Tool-error outcomes. Transport/authentication failures throw. It does not retry automatically. For operations requiring idempotency, create one key per user intent and retain it after an uncertain transport result; retrying with a fresh key could repeat a committed mutation.

The app URL carries a unique app-scoped token in its fragment. The browser module captures and removes it on first import, then uses origin-local `sessionStorage` for reloads; disabled browser storage retains it only in memory. No cookies, query credentials, generic world tokens, or inspector handles are used. Requests require the exact listener Host, same-origin browser requests, and the app bearer token for APIs. Each invocation is bounded to 1 MiB and may name only an operation declared by that Tool. Static assets use a restrictive CSP: external scripts/styles, inline scripts/styles, frames, workers, remote network calls and forms are not enabled. Put JavaScript and CSS in declared local assets. This is trusted local UI execution, not isolation from malicious local packages or processes.

Closing the listener revokes calls immediately and closes outstanding sockets, including incomplete request bodies. A network failure does not roll back an already committed operation. No account, container or hosted service is involved.

Another transport can serve `createToolUiClientSource()` at the same module path to retain this browser protocol. Its default accepts only the existing 43-character opaque app token. An explicit `{ credentialFormat: "signed", maxCredentialBytes: 4096 }` accepts two- or three-segment base64url app credentials up to that bound (at most 16 KiB). This is browser-side syntax checking, not authentication. The transport must validate signatures, expiry, current actor authority, per-app operation scope and exact origin on every request. It must supply only an app-scoped credential, never a general world or inspector credential. The client continues clearing URL fragments, using only origin-local session storage, making same-origin credential-omitting requests, and exposing no additional API.

An explicit `{ credentialTransport: "cookie" }` uses browser cookie transport
(`credentials: "same-origin"`) without an Authorization header. It never reads a
bearer from a fragment or session storage, clears token fragments and removes
previously stored app bearers. The same `getContext()` and `invoke()` APIs apply.
The serving transport must establish authentication, use appropriately scoped
HttpOnly/Secure/SameSite cookies, and enforce exact Host/Origin and CSRF checks;
this option neither creates cookies nor grants access. The default remains
`"bearer"`, including for existing local listeners. Captures such as browser
traces may contain cookies; disabling or sanitizing those captures remains the
calling application's responsibility.

A Tool may also declare repository-owned `http` routes using an OpenAPI-style path template, one supported credential placement, a JSON/form/text/no-body request shape, and explicit success and Tool-error statuses. Its behavior module supplies pure `decode` and `encode` codecs around one declared semantic operation. The route adapter parses and bounds the wire request, verifies the per-trial credential, invokes the operation as the selected scenario actor, and renders the response. It never owns state or consequences.

The supported credential placements are bearer, named header, query parameter, HTTP Basic username/password token, and explicit `none`. Prefer a credentialed route. `none` is intended only for a deliberately unauthenticated local API and allows any local process that can reach the ephemeral listener to act as that drill actor.

Wire compatibility is explicit per route; Firedrill does not infer or claim complete compatibility with an arbitrary service from a semantic operation alone. JSON and URL-encoded form requests plus JSON, text, byte, or empty responses are supported. Multipart, streaming, transparent DNS/TLS interception, and undocumented provider behavior are not implied.

The server binds to loopback, validates Host and Origin, requires the bearer token before generic discovery or dispatch, enforces each declared synthetic-route credential, caps request and response bodies, and never exposes control state, faults, time controls, assertions, or hidden world inspection to the agent.

## Composing another HTTP transport

`registerWireRoutes(tools)`, `matchWireRoute(routes, method, pathname)`, and `wireMethodsForPath(routes, pathname)` expose the same authored routing used by the loopback binding. `invokeHttpWireRoute({ match, request, authorize, invoke })` accepts a method, standard `URL`, received header pairs, and buffered `Uint8Array` body. It returns the declared status, validated response headers, and bounded response bytes. The existing loopback server delegates to this codec path.

The required `authorize` callback receives the immutable declared operation and route contract and must return `true` before any custom codec or operation runs. `invoke` receives that same operation, decoded arguments, and optional idempotency key, and returns its canonical invocation/outcome, synchronously or asynchronously. It must enforce the host's current actor, world, lifecycle and allowed-operation subset; a successful earlier authorization is not a substitute for invocation fencing. No kernel, state store, credential, listener or network destination is selected by this adapter.

`httpWireCredential(request, auth)` extracts the authored API credential without verifying it. It is separate from any platform routing credential, which may use a different carrier. Both layers may need an `Authorization` header: a host must define an unambiguous routing/authentication envelope, remove its own credential before passing wire data, and retain the authored API's declared auth semantics. The codec path removes only the authored API auth header/query value. An authored `auth.kind: none` still requires the host's `authorize` callback; it never grants unsigned access to a hosted world.

The host owns request/header limits, bounded buffering, cancellation, transport cleanup and error-envelope privacy. This seam retains the 1 MiB codec body limits and existing response-header limits; it does not provide streaming or perform I/O. A failure to authorize runs no codec or operation. An encoder failure can occur after the operation committed, so retries must retain the operation's declared idempotency key rather than assume that no side effect occurred.

An optional `signal` checks cancellation between authorization, decoding,
invocation and encoding. An admitted asynchronous invocation is awaited before
the adapter returns; cancellation skips subsequent encoding but does not roll
back an already committed operation. The host still owns cancellation of its I/O.

This package also delivers Tool-declared callbacks into a developer-supplied loopback receiver. A callback is the opposite direction from an agent-facing API: a committed world event becomes an HTTP request to the application under test. Tool code supplies only a pure event-to-request codec. The framework owns the durable outbox, stable idempotency key, optional HMAC-SHA256 signature, bounded request and response handling, virtual-time retry policy, crash recovery, and evidence. Receiver origins and secrets are runtime inputs and are never persisted in the world or report.
