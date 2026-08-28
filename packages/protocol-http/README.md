# `@firedrill/protocol-http`

Loopback HTTP access to one local synthetic world. The adapter exposes only Tool operations granted to the drill's selected actor and delegates every call to the generic kernel.

A command, HTTP, or caller-owned target receives:

- `FIREDRILL_HTTP_URL` — the per-trial loopback base URL;
- `FIREDRILL_HTTP_TOKEN` — the per-trial bearer credential.

Every binding retains Firedrill's generic operation routes:

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

A Tool may also declare repository-owned `http` routes using an OpenAPI-style path template, one supported credential placement, a JSON/form/text/no-body request shape, and explicit success and Tool-error statuses. Its behavior module supplies pure `decode` and `encode` codecs around one declared semantic operation. The route adapter parses and bounds the wire request, verifies the per-trial credential, invokes the operation as the selected scenario actor, and renders the response. It never owns state or consequences.

The supported credential placements are bearer, named header, query parameter, HTTP Basic username/password token, and explicit `none`. Prefer a credentialed route. `none` is intended only for a deliberately unauthenticated local API and allows any local process that can reach the ephemeral listener to act as that drill actor.

Wire compatibility is explicit per route; Firedrill does not infer or claim complete compatibility with an arbitrary service from a semantic operation alone. JSON and URL-encoded form requests plus JSON, text, byte, or empty responses are supported. Multipart, streaming, transparent DNS/TLS interception, and undocumented provider behavior are not implied.

The server binds to loopback, validates Host and Origin, requires the bearer token before generic discovery or dispatch, enforces each declared synthetic-route credential, caps request and response bodies, and never exposes control state, faults, time controls, assertions, or hidden world inspection to the agent.

This package also delivers Tool-declared callbacks into a developer-supplied loopback receiver. A callback is the opposite direction from an agent-facing API: a committed world event becomes an HTTP request to the application under test. Tool code supplies only a pure event-to-request codec. The framework owns the durable outbox, stable idempotency key, optional HMAC-SHA256 signature, bounded request and response handling, virtual-time retry policy, crash recovery, and evidence. Receiver origins and secrets are runtime inputs and are never persisted in the world or report.
