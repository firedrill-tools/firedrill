import { canonicalJson, JsonValueSchema, ToolPackageManifestSchema } from "@firedrill-run/contracts";
import { describe, expect, it } from "vitest";
import { normalizeManifest } from "../src/normalize.js";

const manifest = {
  schemaVersion: 1,
  id: "records",
  version: "1.0.0",
  engine: ">=0.1.0",
  capabilities: [],
  operations: [
    {
      id: "write",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      idempotency: "none",
      fidelity: "stateful",
    },
  ],
};
describe("connection metadata normalization", () => {
  it("does not inject new fields into older normalized manifests", () => {
    const normalized = normalizeManifest(ToolPackageManifestSchema.parse(manifest));
    expect(normalized).toEqual({
      ...manifest,
      state: [],
      events: [],
      faults: [],
      subscriptions: [],
      http: [],
      callbacks: [],
      compatibility: [],
      operations: [{ ...manifest.operations[0], declaredErrors: [] }],
    });
    expect(canonicalJson(JsonValueSchema.parse(normalized))).not.toContain("connections");
    expect(canonicalJson(JsonValueSchema.parse(normalized))).not.toContain("mcp");
  });
  it("sorts equivalent connection definitions while preserving case-sensitive MCP names", () => {
    const connections = [
      { id: "z-http", title: "HTTP", protocol: "http", environment: { CLIENT_URL: "FIREDRILL_HTTP_URL" } },
      {
        id: "a-mcp",
        title: "MCP",
        protocol: "mcp",
        environment: { CLIENT_TOKEN: "FIREDRILL_MCP_TOKEN", CLIENT_URL: "FIREDRILL_MCP_URL" },
      },
    ];
    const operation = { ...manifest.operations[0], mcp: { name: "WRITE_Record" } };
    const left = normalizeManifest(
      ToolPackageManifestSchema.parse({ ...manifest, operations: [operation], connections }),
    );
    const right = normalizeManifest(
      ToolPackageManifestSchema.parse({
        ...manifest,
        operations: [operation],
        connections: [...connections].reverse(),
      }),
    );
    expect(canonicalJson(JsonValueSchema.parse(left))).toEqual(canonicalJson(JsonValueSchema.parse(right)));
    expect(left.operations[0]?.mcp?.name).toBe("WRITE_Record");
  });
});
