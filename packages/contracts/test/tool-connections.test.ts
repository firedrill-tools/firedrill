import { describe, expect, it } from "vitest";
import { McpToolAliasSchema, ToolConnectionRecipeSchema, ToolPackageManifestSchema } from "../src/index.js";

const operation = {
  id: "write",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  idempotency: "none",
  fidelity: "stateful",
};
const manifest = {
  schemaVersion: 1,
  id: "records",
  version: "1.0.0",
  engine: ">=0.1.0",
  capabilities: [],
  operations: [operation],
};
const recipe = {
  id: "client",
  title: "Client connection",
  protocol: "mcp",
  environment: { CLIENT_MCP_URL: "FIREDRILL_MCP_URL", CLIENT_MCP_TOKEN: "FIREDRILL_MCP_TOKEN" },
};

describe("package-owned connections", () => {
  it("leaves optional transport metadata absent on existing manifests", () => {
    const parsed = ToolPackageManifestSchema.parse(manifest);
    expect(parsed).not.toHaveProperty("connections");
    expect(parsed.operations[0]).not.toHaveProperty("mcp");
  });
  it("accepts portable exact MCP names without lowercasing or silently renaming them", () => {
    for (const name of ["getRecord", "RECORD_UPDATE_v2", "admin.tools-list"])
      expect(McpToolAliasSchema.parse({ name }).name).toBe(name);
    for (const name of ["", "two words", "path/name", "é", "x".repeat(129)])
      expect(McpToolAliasSchema.safeParse({ name }).success).toBe(false);
  });
  it("rejects aliases that collide with another canonical name or alias", () => {
    expect(
      ToolPackageManifestSchema.safeParse({
        ...manifest,
        operations: [
          { ...operation, mcp: { name: "records.read" } },
          { ...operation, id: "read" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ToolPackageManifestSchema.safeParse({
        ...manifest,
        operations: [
          { ...operation, mcp: { name: "SAME" } },
          { ...operation, id: "read", mcp: { name: "SAME" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      ToolPackageManifestSchema.safeParse({
        ...manifest,
        operations: [{ ...operation, mcp: { name: "records.write" } }],
      }).success,
    ).toBe(true);
  });
  it("only projects known binding variables from the selected protocol", () => {
    expect(ToolConnectionRecipeSchema.parse(recipe)).toEqual(recipe);
    for (const environment of [
      {},
      { CLIENT_MCP_TOKEN: "ANTHROPIC_API_KEY" },
      { FIREDRILL_MCP_URL: "FIREDRILL_MCP_URL" },
      { CLIENT_MCP_URL: "FIREDRILL_HTTP_URL" },
    ])
      expect(ToolConnectionRecipeSchema.safeParse({ ...recipe, environment }).success).toBe(false);
    expect(ToolConnectionRecipeSchema.safeParse({ ...recipe, command: "eval me" }).success).toBe(false);
    expect(ToolPackageManifestSchema.safeParse({ ...manifest, connections: [recipe, recipe] }).success).toBe(
      false,
    );
  });
});
