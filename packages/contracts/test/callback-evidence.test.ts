import { describe, expect, it } from "vitest";
import { CallbackRequestEvidenceSchema } from "../src/index.js";

const request = {
  method: "POST",
  path: "/hooks/complete",
  bodyHash: `sha256:${"a".repeat(64)}`,
  bodyBytes: 0,
  signature: { kind: "none" },
};

describe("callback request evidence", () => {
  it("reads existing request evidence without a transport key", () => {
    expect(CallbackRequestEvidenceSchema.parse(request)).toEqual(request);
  });

  it("retains a bounded actual transport key without admitting credentials or unknown fields", () => {
    const idempotencyKey = `sha256:${"b".repeat(64)}`;
    expect(CallbackRequestEvidenceSchema.parse({ ...request, idempotencyKey })).toEqual({
      ...request,
      idempotencyKey,
    });
    expect(CallbackRequestEvidenceSchema.safeParse({ ...request, idempotencyKey: "" }).success).toBe(false);
    expect(
      CallbackRequestEvidenceSchema.safeParse({ ...request, idempotencyKey: "x".repeat(129) }).success,
    ).toBe(false);
    expect(CallbackRequestEvidenceSchema.safeParse({ ...request, secret: "not-evidence" }).success).toBe(
      false,
    );
  });
});
