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
