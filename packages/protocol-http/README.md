# `@firedrill/protocol-http`

Authenticated loopback HTTP access to one local synthetic world. The adapter exposes only Tool operations granted to the drill's selected actor and delegates every call to the generic kernel.

A command, HTTP, or caller-owned target receives:

- `FIREDRILL_HTTP_URL` — the per-trial loopback base URL;
- `FIREDRILL_HTTP_TOKEN` — the per-trial bearer credential.

The stable agent-facing routes are:

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

This is Firedrill's stable operation protocol. It does not claim wire compatibility with an arbitrary vendor REST API. When an existing agent uses a vendor-shaped client, adapt that client's base transport once at the composition seam or keep a small repository-owned adapter that translates its request into this operation envelope. Vendor behavior still belongs in the Tool, never in protocol core.

The server binds to loopback, validates Host and Origin, requires the bearer token before tool discovery or dispatch, caps request bodies, and never exposes control-plane state, faults, time controls, assertions, or hidden world inspection to the agent.
