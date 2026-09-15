import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFiredrillEnvironment } from "../src/environment-check.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function project() {
  const root = mkdtempSync(resolve(tmpdir(), "firedrill-agent-environment-"));
  directories.push(root);
  cpSync(resolve(import.meta.dirname, "../../../templates/minimal"), root, { recursive: true });
  for (const folder of ["drills", "scenarios", "targets", "suites"])
    rmSync(resolve(root, "firedrill", folder), { recursive: true, force: true });
  return root;
}

describe("authoring environment readiness", () => {
  it("loads real tool behavior and starts bindings without requiring an agent test", async () => {
    const root = project();
    const result = await checkFiredrillEnvironment(root);
    expect(result).toMatchObject({ status: "ready", toolCount: 1, agentTested: false });
    expect(result.operationCount).toBeGreaterThan(0);
    expect(result.buildHash).toMatch(/^sha256:/);
    expect(existsSync(resolve(root, ".firedrill/reports"))).toBe(false);
  });

  it("does not execute behavior or produce runtime output in source-only mode", async () => {
    const root = project();
    const path = resolve(root, "firedrill/tools/resource-store/behavior.mjs");
    writeFileSync(path, `throw new Error("must not execute");\n${readFileSync(path, "utf8")}`);
    expect(await checkFiredrillEnvironment(root, false)).toMatchObject({
      status: "source-validated",
      agentTested: false,
    });
    expect(existsSync(resolve(root, ".firedrill"))).toBe(false);
    expect(await checkFiredrillEnvironment(root)).toMatchObject({ status: "failed", agentTested: false });
  });

  it("returns an explicit serve identity when multiple actors are defined", async () => {
    const root = project();
    const path = resolve(root, "firedrill/world.yaml");
    writeFileSync(path, `${readFileSync(path, "utf8")}  - id: observer\n    grants: []\n`);
    expect(await checkFiredrillEnvironment(root)).toMatchObject({
      status: "ready",
      actorId: "operator",
      nextCommand: "firedrill serve --actor operator",
      agentTested: false,
    });
  });

  it("does not call invalid source ready", async () => {
    const root = project();
    writeFileSync(resolve(root, "firedrill.json"), "{broken");
    const result = await checkFiredrillEnvironment(root);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
