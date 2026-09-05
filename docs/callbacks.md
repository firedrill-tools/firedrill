# Callbacks into the application under test

A Firedrill callback models an asynchronous request that the synthetic world sends to the developer's application: for example, a provider event delivered after a Tool operation changes state. It is not an API the agent calls. Agent-facing APIs remain Tool operations exposed through direct, HTTP, MCP, CLI, or a declared wire-compatible HTTP route.

Callback source stays portable. A Tool contract declares an event, an abstract `receiverId`, a static path, delivery policy, and optional signature. The behavior module provides a pure event-to-request codec. At run time, the developer maps the receiver id to a loopback HTTP origin:

```yaml
events:
  - id: payment.completed
    payloadSchema:
      type: object
      required: [paymentId]
      properties:
        paymentId: { type: string }
      additionalProperties: false
callbacks:
  - id: notify-application
    eventId: payment.completed
    receiverId: application
    method: POST
    path: /callbacks/payments
    idempotencyHeader: Idempotency-Key
    signature:
      kind: hmac-sha256
      header: X-Callback-Signature
      prefix: sha256=
    retry:
      delaysUs: [1000000, 5000000]
    timeoutMs: 5000
```

```js
export default {
  operations: {
    "payments.complete": (input, context) => {
      const payment = { paymentId: input.paymentId, status: "completed" };
      context.state.put("payments", input.paymentId, payment);
      context.events.emit("payment.completed", payment);
      return payment;
    },
  },
  callbacks: {
    "notify-application": {
      encode: ({ deliveryId, payload }) => ({
        headers: { "x-event-id": deliveryId },
        body: { kind: "json", value: payload },
      }),
    },
  },
};
```

```sh
export CALLBACK_SECRET='local test secret'
firedrill run payment-completes \
  --callback-receiver application=http://127.0.0.1:4319 \
  --callback-secret-env application=CALLBACK_SECRET
```

The TypeScript API accepts the same runtime mapping as `callbackReceivers`. Origins and secrets are never stored in world source, SQLite, or reports. Local delivery is deliberately limited to credential-free loopback HTTP origins. The contract supplies the path; passing a URL with a path, credentials, query, or fragment is rejected.

The event and callback queue are committed in the same SQLite transaction as the Tool's state changes. Delivery happens only after commit. Attempts, responses, retry scheduling, terminal failure, crash recovery, and stable idempotency identity are durable evidence in that same world. Retry delays use virtual time, so reproduction does not depend on wall-clock sleeps. Reset or snapshot restore moves state, pending callbacks, clock, and evidence together.

Assert delivery as a consequence rather than trusting the agent's output:

```yaml
assertions:
  - id: application-notified-once
    kind: callback.count
    callback:
      packageId: payment-service
      callbackId: notify-application
    phase: delivered
    comparison: { operator: equals, value: 1 }
```

`firedrill tool test` applies the same receiver options and requires every declared callback to be delivered successfully by the selected conformance suite. This prevents a reusable Tool from advertising an unexercised callback surface.

## Explicit transport composition

The ordinary CLI and SDK path remains credential-free loopback HTTP. An advanced caller composing `CallbackDispatcher` from `@firedrill/protocol-http` may provide a caller-owned `transport` with `authorizeOrigin({ receiverId, origin })` and `fetch`. This is an explicit network edge, not a remote-access flag or a Tool capability. No remote transport or allow-all policy is built in.

On every wire attempt, including retries, the dispatcher calls `transport.fetch(input, init, context)` with a frozen `{ receiverId }` context taken from the durable delivery. It is separate from codec-controlled headers and body, so transports can authorize individual receivers even when they share an origin. The exported `CallbackTransportContext` argument is optional for compatibility with ordinary fetch implementations; a transport that requires receiver identity must reject direct calls without it. Default local delivery and the test-only `fetch` option still use the ordinary two-argument fetch call.

Origin authorization must return `true` for the exact receiver and canonical origin on every attempt. The transport must independently enforce its destination/network policy on every connection, including DNS resolution, honor the supplied abort signal, and refuse redirects. Fetch rejection and response-body completion/cancellation must await cleanup of active I/O. Origin selection alone does not prevent DNS rebinding or provide network isolation. The dispatcher still rejects credentials, base paths, queries, fragments, escaping callback paths, codec-selected destinations, and overrides of delivery/signature headers. The same request/header/response bounds, timeout, HMAC signing, durable outbox, and virtual-time retry policy apply.

An explicit transport requires an immutable `idempotencyScope`: a nonempty execution identity of at most 1024 UTF-8 bytes, containing no secrets. Persist and reuse that scope across retries and process recovery; create a new scope for every full-world reset or fork execution generation. World-local callback IDs may repeat after reset. The transmitted key is `sha256:` followed by the hexadecimal SHA-256 of the UTF-8 JSON array `[idempotencyScope, deliveryId]`. A caller may also supply the scope with the default local transport. Without one, the existing local delivery ID remains the transmitted key.

For partial package resets, keep the base scope and unrelated package scopes stable, and supply new identities for the reset packages through `idempotencyScopeByPackage`. This optional readonly package-ID-to-scope record requires a base `idempotencyScope`; each key must name an installed Tool supplied in `tools` and each value has the same nonempty, 1024 UTF-8 byte bound. The dispatcher validates and copies the record at construction. Recreate the dispatcher with the persisted scopes after reset or process recovery. An override applies when its package owns either the callback or the source event, matching SQLite's package-reset boundary. Applicable `[packageId, scope]` pairs are unique and sorted by package ID; when any apply, the transmitted key hashes the UTF-8 JSON array `[idempotencyScope, deliveryId, sortedApplicableOverrides]`. With no applicable override, the existing two-element hash is unchanged, so an unrelated retry retains its key.

Callback evidence keeps its top-level `idempotencyKey` as the world-local logical delivery identity for every phase. An `attempt_started` record's `request.idempotencyKey` records the actual transmitted key; older evidence may omit that optional request field. Origins and signing secrets remain outside the durable evidence.

`dispatchDue(signal?)` supports caller cancellation. An already-aborted signal starts no attempt. An in-flight interruption records a retryable `framework.CALLBACK_ABORTED` error and the receiver's outcome may be unknown; retry scheduling and exhaustion still use the declared delivery policy. No later delivery starts in that drain. Await rejection before resetting or closing the world, so network cleanup and durable settlement finish first. Concurrent calls join the active drain and do not replace its owner's signal.
