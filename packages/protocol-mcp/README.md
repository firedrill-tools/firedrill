# `@firedrill/protocol-mcp`

Authenticated loopback MCP access to one local synthetic world. Every Tool operation granted to the drill's selected actor becomes an MCP tool backed by the same generic kernel used by direct and HTTP bindings.

A command, HTTP, or caller-owned target receives:

- `FIREDRILL_MCP_URL` — the per-trial Streamable HTTP endpoint;
- `FIREDRILL_MCP_TOKEN` — the per-trial bearer credential.

Connect with a standard MCP client using Streamable HTTP and bearer authentication. Tool discovery returns the declared descriptions and input schemas. Each deterministic MCP tool name is `{packageId}.{operationId}`; `mcpToolName()` exports that mapping for clients that need to construct a name directly.

Successful calls return the Tool value as `structuredContent`, including object, array, primitive, and null results; the binding advertises each operation's output schema so MCP clients can project the protocol-version-appropriate wire shape. Denied, provider-error, unsupported, and invalid calls set `isError: true` and return a structured status and error envelope. Operations requiring idempotency receive a request-derived transport key automatically; a caller may provide an explicit semantic key through MCP request metadata at `dev.firedrill/idempotency-key`.

The adapter uses the official Model Context Protocol SDK, binds to loopback, validates Host and Origin, and requires the bearer token before dispatch. It does not expose control authority, hidden world state, assertions, or test-runner behavior.
