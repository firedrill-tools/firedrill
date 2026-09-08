import type { LocalWorldTool } from "@firedrill/sdk";
import { describe, expect, it } from "vitest";
import { redactEnvironmentValue } from "../src/environment-redaction.js";

const tools: readonly LocalWorldTool[] = [
  {
    packageId: "counter",
    version: "1.0.0",
    operations: [],
    operationContracts: [],
    stateNamespaces: ["private-records"],
    stateContracts: [
      {
        namespace: "private-records",
        schema: {
          type: "object",
          properties: {
            namespace: { type: "string", writeOnly: true },
          },
        },
      },
    ],
    events: [],
    faults: [],
  },
];

describe("live environment presentation redaction", () => {
  it("redacts sensitive payload names and propagation without replacing journal identities", () => {
    const value = {
      namespace: "private-records",
      rowId: "password-value",
      sequence: 4,
      value: {
        namespace: "private-records",
        password: "password-value",
        repeated: "password-value",
        count: 2,
      },
      message: "private-records password-value",
    };
    expect(redactEnvironmentValue(value, tools, [])).toEqual({
      namespace: "private-records",
      rowId: "password-value",
      sequence: 4,
      value: { namespace: "[REDACTED]", password: "[REDACTED]", repeated: "[REDACTED]", count: 2 },
      message: "[REDACTED] [REDACTED]",
    });
    expect(value.value.password).toBe("password-value");
  });

  it("never reflects known connection credentials even in unrelated strings or errors", () => {
    expect(
      redactEnvironmentValue(
        { message: "request included local-credential", value: { arbitrary: "local-credential" } },
        [],
        ["local-credential"],
      ),
    ).toEqual({
      message: "request included [REDACTED]",
      value: { arbitrary: "[REDACTED]" },
    });
  });
});
