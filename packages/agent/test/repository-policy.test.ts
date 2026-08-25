import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeRepositoryTool } from "../src/repository-policy.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function repository() {
  const parent = mkdtempSync(join(tmpdir(), "firedrill-agent-policy-"));
  const root = join(parent, "repository");
  const outside = join(parent, "outside");
  directories.push(parent);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "agent.ts"), "export const agent = true;\n");
  writeFileSync(join(root, ".env.local"), "ANTHROPIC_API_KEY=not-real\n");
  writeFileSync(join(outside, "private.txt"), "outside\n");
  symlinkSync(outside, join(root, "linked-outside"));
  return root;
}

describe("Firedrill Agent repository policy", () => {
  it("allows normal repository authoring and searches", () => {
    const root = repository();
    expect(authorizeRepositoryTool(root, "Read", { file_path: "src/agent.ts" })).toEqual({
      allowed: true,
    });
    expect(authorizeRepositoryTool(root, "Write", { file_path: "firedrill/world.yaml" })).toEqual({
      allowed: true,
    });
    expect(authorizeRepositoryTool(root, "Glob", { pattern: "**/*.ts" })).toMatchObject({
      allowed: false,
    });
  });

  it("denies secrets, generated evidence, traversal, absolute patterns, and escaping symlinks", () => {
    const root = repository();
    for (const [toolName, input] of [
      ["Read", { file_path: ".env.local" }],
      ["Read", { file_path: ".firedrill/reports/run.json" }],
      ["Write", { file_path: "../outside.txt" }],
      ["Read", { file_path: "linked-outside/private.txt" }],
      ["Glob", { pattern: "../**/*" }],
      ["Grep", { path: "/tmp", pattern: "token" }],
    ] as const) {
      expect(authorizeRepositoryTool(root, toolName, input).allowed).toBe(false);
    }
  });
});
