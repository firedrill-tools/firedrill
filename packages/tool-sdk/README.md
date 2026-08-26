# @firedrill/tool-sdk

Public authoring contract for deterministic, trusted-local Tool behavior. It does not provide a security sandbox and does not permit ambient network, clock, or randomness through its host API.

Operation handlers receive a narrow context for package-owned state, virtual time, seeded randomness, events, actor/grant inspection, and structured expected failure. Use `context.fail(...)` with a code declared on the operation to return a provider or policy error and roll back that operation. Throwing an ordinary exception is recorded as a handler crash. The context method keeps a plain repository behavior module executable without a runtime import; this package remains useful for TypeScript types and programmatic Tool definitions. When behavior imports `defineToolBehavior` or `ToolFailure`, the compiler embeds the narrow behavior runtime into the content-hashed artifact so an installed Tool pack remains portable without consumer-side dependency hoisting.

One behavior definition can be reached through direct, HTTP, MCP, or CLI bindings and always mutates the same isolated world. An operation may model an internal application action, a third-party service, a database-facing capability, or something with no HTTP endpoint at all. The semantic Tool contract does not assume one transport.

When an existing client expects a particular HTTP shape, the Tool manifest may declare a wire route and the behavior module may provide its matching `decode` and `encode` codec. The decoder maps bounded path/query/header/body input to one semantic operation call. The encoder maps that operation outcome to a response body and headers; the manifest fixes its success and declared-error status codes. Codecs cannot mutate Tool state because they receive no `ToolContext`. Put all authorization decisions, mutations, emitted events, scheduled work, and cross-Tool consequences in the operation handler.

An operation's `idempotency` value is part of its caller contract: `none` rejects any supplied key, `optional` accepts but does not require one, and `required` requires a key on direct/HTTP calls. The MCP adapter derives a stable request key for required operations when the caller does not provide one explicitly.

This package is pre-release. Its public handler contract has been exercised by multiple unrelated worlds and a clean packed-package consumer. Filesystem discovery, source compilation, locked artifact creation, and executable module loading are deliberately owned by `@firedrill/compiler` and `@firedrill/world-build`, not this package.
