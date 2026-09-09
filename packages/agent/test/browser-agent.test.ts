import { existsSync } from "node:fs";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: mocked.query,
}));

import { createBrowserAgentDriver } from "../src/browser.js";

function result(subtype = "success", is_error = false): Query {
  return (async function* () {
    yield { type: "result", subtype, is_error, result: "Everything passed" } as unknown as SDKMessage;
  })() as Query;
}
const context = () => ({
  task: "Click the test button",
  signal: new AbortController().signal,
  parameterNames: ["testUser"],
  observe: async () => ({ url: "http://127.0.0.1:3000", snapshot: "button Test" }),
  step: async () => {},
});
beforeEach(() => {
  mocked.query.mockReset();
});
describe("optional browser Agent SDK driver", () => {
  it("uses the SDK user-message stream for bounded interactive follow-ups", async () => {
    const received: string[] = [];
    mocked.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      (async function* () {
        for await (const message of prompt) received.push(String(message.message.content));
        yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
      })(),
    );
    await createBrowserAgentDriver({
      environment: { ANTHROPIC_API_KEY: "test" },
      messages: (async function* () {
        yield "Now open the receipt";
        yield "Check the confirmation";
      })(),
    })(context());
    expect(received).toEqual(["Click the test button", "Now open the receipt", "Check the confirmation"]);
    await expect(
      createBrowserAgentDriver({
        environment: { ANTHROPIC_API_KEY: "test" },
        messages: (async function* () {
          yield "x".repeat(20001);
        })(),
      })(context()),
    ).rejects.toMatchObject({ code: "agent.INVALID_MESSAGE" });
  });
  it("requires BYOK and valid limits before calling the model", () => {
    expect(() => createBrowserAgentDriver({ environment: {} })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      createBrowserAgentDriver({ environment: { ANTHROPIC_API_KEY: "test" }, maxBudgetUsd: 0 }),
    ).toThrow();
    expect(() =>
      createBrowserAgentDriver({ environment: { ANTHROPIC_API_KEY: "test" }, maxTurns: Infinity }),
    ).toThrow();
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("isolates configuration, limits tools, cleans temporary home, and does not return a model verdict", async () => {
    mocked.query.mockReturnValue(result());
    const output = await createBrowserAgentDriver({
      environment: {
        ANTHROPIC_API_KEY: "test-key",
        PATH: process.env.PATH,
        UNRELATED_SECRET: "do-not-forward",
      },
    })(context());
    expect(output).toBeUndefined();
    const call = mocked.query.mock.calls[0]?.[0] as {
      options: {
        cwd: string;
        tools: string[];
        allowedTools: string[];
        settingSources: string[];
        persistSession: boolean;
        strictMcpConfig: boolean;
        env: Record<string, string>;
        maxTurns: number;
        maxBudgetUsd: number;
        canUseTool: (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>;
      };
    };
    expect(call.options.tools).toEqual([]);
    expect(call.options.allowedTools).toEqual([]);
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.persistSession).toBe(false);
    expect(call.options.strictMcpConfig).toBe(true);
    expect(call.options.env.UNRELATED_SECRET).toBeUndefined();
    expect(call.options.maxTurns).toBe(40);
    expect(call.options.maxBudgetUsd).toBe(2);
    expect((await call.options.canUseTool("Bash", {})).behavior).toBe("deny");
    expect((await call.options.canUseTool("mcp__browser_test__act", {})).behavior).toBe("allow");
    expect(existsSync(call.options.cwd)).toBe(false);
  });
  it("rejects taskless, cancelled and model-budget-failed executions", async () => {
    const driver = createBrowserAgentDriver({ environment: { ANTHROPIC_API_KEY: "test" } });
    await expect(driver({ ...context(), task: "" })).rejects.toMatchObject({ code: "browser.TASK_REQUIRED" });
    const controller = new AbortController();
    controller.abort();
    await expect(driver({ ...context(), signal: controller.signal })).rejects.toBeDefined();
    expect(mocked.query).not.toHaveBeenCalled();
    mocked.query.mockReturnValue(result("error_max_budget_usd", true));
    await expect(driver(context())).rejects.toMatchObject({ code: "agent.BROWSER_EXECUTION_FAILED" });
  });
});
