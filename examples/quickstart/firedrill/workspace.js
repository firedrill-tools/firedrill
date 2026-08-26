export default {
  operations: {
    "records.set": (input, context) => {
      const value = { value: Number(input.value) };
      context.state.put("records", "primary", value);
      return value;
    },
  },
  http: {
    "set-record": {
      decode(request) {
        if (
          request.body.kind !== "json" ||
          typeof request.body.value !== "object" ||
          request.body.value === null ||
          Array.isArray(request.body.value) ||
          typeof request.body.value.value !== "number"
        ) {
          throw new TypeError("value must be a number");
        }
        const idempotencyKey = request.headers["idempotency-key"]?.[0];
        if (idempotencyKey === undefined) throw new TypeError("idempotency-key is required");
        return { arguments: { value: request.body.value.value }, idempotencyKey };
      },
      encode({ outcome }) {
        return {
          body:
            outcome.status === "ok"
              ? { kind: "json", value: outcome.value }
              : { kind: "json", value: { error: outcome.error?.message ?? "request failed" } },
        };
      },
    },
  },
};
