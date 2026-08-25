# @firedrill/protocol-cli

The local CLI adapter for a running Firedrill world. A drill that declares a
`cli` binding exposes the same Tool operations and state consequences as the
HTTP, MCP, and direct bindings. The public `firedrill world` command is the
normal entry point; this package exposes the typed client and binding primitives
for advanced composition.

The adapter listens only on loopback, uses a per-interaction bearer token, and
does not start or host an AI agent.
