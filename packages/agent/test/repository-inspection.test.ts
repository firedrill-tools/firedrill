import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRepositoryFiles, searchRepository } from "../src/repository-inspection.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function repository() {
  const parent = mkdtempSync(join(tmpdir(), "firedrill-agent-inspection-"));
  directories.push(parent);
  const root = join(parent, "repository");
  const outside = join(parent, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
  mkdirSync(join(root, ".firedrill", "reports"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "agent.ts"), "export const reserveInventory = true;\n");
  writeFileSync(join(root, "README.md"), "Inventory agent\n");
  writeFileSync(join(root, ".env.local"), "ANTHROPIC_API_KEY=must-not-leak\n");
  writeFileSync(join(root, ".npmrc"), "//registry.example/:_authToken=must-not-leak\n");
  writeFileSync(join(root, "node_modules", "dependency", "index.js"), "must-not-leak\n");
  writeFileSync(join(root, ".firedrill", "reports", "run.json"), "must-not-leak\n");
  writeFileSync(join(outside, "private.txt"), "must-not-leak\n");
  symlinkSync(outside, join(root, "linked-outside"));
  return root;
}

describe("Firedrill Agent repository inspection", () => {
  it("lists only ordinary contained source files", () => {
    const root = repository();
    expect(listRepositoryFiles({ repositoryRoot: root })).toEqual({
      files: ["README.md", "src/agent.ts"],
      truncated: false,
    });
  });

  it("searches literal source text without reading secrets or generated trees", () => {
    const root = repository();
    expect(searchRepository({ repositoryRoot: root, query: "inventory" })).toMatchObject({
      matches: [
        { path: "README.md", line: 1, column: 1 },
        { path: "src/agent.ts", line: 1, column: 21 },
      ],
      filesExamined: 2,
      truncated: false,
    });
    expect(searchRepository({ repositoryRoot: root, query: "must-not-leak" }).matches).toEqual([]);
  });

  it("rejects absolute, escaping, secret, and non-directory scopes", () => {
    const root = repository();
    for (const path of ["/tmp", "../outside", ".firedrill", ".env.local", "linked-outside"]) {
      expect(() => listRepositoryFiles({ repositoryRoot: root, path })).toThrow();
    }
  });
});
