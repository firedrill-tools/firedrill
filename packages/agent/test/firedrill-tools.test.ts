import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFiredrillAuthoringTools } from "../src/firedrill-tools.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), "firedrill-agent-tools-"));
  directories.push(root);
  cpSync(resolve(import.meta.dirname, "../../../templates/minimal"), root, { recursive: true });
  return root;
}

function parsedText(result: Awaited<ReturnType<ToolDefinition["handler"]>>) {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("expected text Tool result");
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

interface ToolDefinition {
  readonly name: string;
  readonly handler: (
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly isError?: boolean;
  }>;
}

function selected(root: string, name: string): ToolDefinition {
  const candidate = createFiredrillAuthoringTools(root).find((item) => item.name === name);
  if (candidate === undefined) throw new Error(`missing authoring Tool ${name}`);
  return candidate as unknown as ToolDefinition;
}

describe("Firedrill Agent authoring Tools", () => {
  it("removes execution tools and refuses executable Tool checks in source-only sessions", async () => {
    const root = project();
    const behavior = resolve(root, "firedrill", "resource.mjs");
    writeFileSync(
      behavior,
      `throw new Error("Repository Tool code must never execute");\n${readFileSync(behavior, "utf8")}`,
    );
    const target = resolve(root, "firedrill", "example-agent.mjs");
    writeFileSync(
      target,
      `throw new Error("Customer agent must never execute");\n${readFileSync(target, "utf8")}`,
    );
    const tools = createFiredrillAuthoringTools(root, {
      allowRepositoryExecution: false,
    }) as unknown as ToolDefinition[];
    expect(tools.map((item) => item.name)).not.toContain("run");
    const inspect = tools.find((item) => item.name === "tool_check");
    if (inspect === undefined) throw new Error("missing source inspection tool");
    for (const check of ["validate", "test"]) {
      const denied = await inspect.handler({ toolId: "resource-store", check }, {});
      expect(denied.isError).toBe(true);
    }
    const inspected = await inspect.handler({ toolId: "resource-store", check: "inspect" }, {});
    expect(inspected.isError).not.toBe(true);
    expect(parsedText(inspected)).toMatchObject({ toolId: "resource-store" });
    for (const name of ["validate", "plan", "format"]) {
      const selected = tools.find((item) => item.name === name);
      if (selected === undefined) throw new Error(`missing source tool ${name}`);
      expect((await selected.handler({}, {})).isError).not.toBe(true);
    }
    expect(existsSync(resolve(root, ".firedrill"))).toBe(false);
  });

  it("provides bounded repository discovery and literal search", async () => {
    const root = project();
    writeFileSync(resolve(root, ".env.local"), "ANTHROPIC_API_KEY=must-not-leak\n");
    const files = await selected(root, "repository_files").handler({ contains: "agent" }, {});
    const search = await selected(root, "repository_search").handler({ query: "changes-resource" }, {});
    expect(files.isError).not.toBe(true);
    expect(parsedText(files)).toMatchObject({
      status: "success",
      files: ["firedrill/example-agent.mjs", "firedrill/local-agent.target.yaml"],
    });
    expect(search.isError).not.toBe(true);
    expect(JSON.stringify(parsedText(search))).toContain("changes-resource.drill.yaml");
    expect(JSON.stringify(parsedText(search))).not.toContain("must-not-leak");
  });

  it("validates and plans a real repository through compiler seams", async () => {
    const root = project();
    const validate = await selected(root, "validate").handler({}, {});
    const plan = await selected(root, "plan").handler({}, {});
    expect(validate.isError).not.toBe(true);
    expect(parsedText(validate)).toMatchObject({ status: "success" });
    expect(parsedText(plan)).toMatchObject({
      status: "success",
      world: "starter-world",
      tools: [{ id: "resource-store" }],
      drills: [{ id: "changes-resource" }],
    });
  });

  it("runs a real drill and returns local evidence paths", async () => {
    const root = project();
    const result = await selected(root, "run").handler({ drill: "changes-resource", trials: 1 }, {});
    expect(result.isError).not.toBe(true);
    const output = parsedText(result);
    expect(output).toMatchObject({
      status: "completed",
      verdict: "passed",
      drills: [{ id: "changes-resource", verdict: "passed" }],
    });
    expect(JSON.stringify(output)).toContain(`${root}/.firedrill/reports/`);
  });

  it("treats pending canonical formatting as an actionable Tool error", async () => {
    const root = project();
    const source = resolve(root, "firedrill", "changes-resource.drill.yaml");
    writeFileSync(source, readFileSync(source, "utf8").replace("tags:\n  - smoke", "tags: [smoke]"));

    const check = await selected(root, "format").handler({ check: true }, {});
    expect(check.isError).toBe(true);
    expect(parsedText(check)).toMatchObject({
      status: "changes_required",
      changed: ["firedrill/changes-resource.drill.yaml"],
    });

    const formatted = await selected(root, "format").handler({ check: false }, {});
    expect(formatted.isError).not.toBe(true);
    const repeated = await selected(root, "format").handler({ check: true }, {});
    expect(repeated.isError).not.toBe(true);
    expect(parsedText(repeated)).toMatchObject({ status: "success" });
  });
});
