import { existsSync } from "node:fs";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...original, query: mocked.query };
});

import { type FiredrillAgentError, runFiredrillAgent } from "../src/run-agent.js";

function stream(messages: readonly SDKMessage[]): Query {
  const iterable = (async function* () {
    for (const message of messages) yield message;
  })();
  return iterable as Query;
}

beforeEach(() => {
  mocked.query.mockReset();
  mocked.calls.length = 0;
});

describe("Firedrill Agent runtime", () => {
  it("removes repository execution from SDK permissions and describes the authoring-only handoff", async () => {
    mocked.query.mockImplementationOnce((call: Record<string, unknown>) => {
      mocked.calls.push(call);
      return stream([
        {
          type: "result",
          subtype: "success",
          session_id: "session_source_only",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          total_cost_usd: 0,
          result: "Source compiled; execution remains with the caller.",
        } as unknown as SDKMessage,
      ]);
    });
    const result = await runFiredrillAgent({
      root: process.cwd(),
      environment: { ANTHROPIC_API_KEY: "test-key" },
      allowRepositoryExecution: false,
    });
    expect(result.status).toBe("completed");
    const call = mocked.calls.at(-1) as {
      options: { allowedTools: string[]; disallowedTools: string[]; systemPrompt: { append: string } };
    };
    expect(call.options.allowedTools).not.toContain("mcp__firedrill__run");
    expect(call.options.disallowedTools).toContain("mcp__firedrill__run");
    expect(call.options.allowedTools).toContain("mcp__firedrill__validate");
    expect(call.options.systemPrompt.append).toContain("Repository execution is disabled");
    expect(call.options.systemPrompt.append).toContain("never claim a runtime result");
  });

  it("requires an explicit Anthropic API key before starting the SDK", async () => {
    await expect(runFiredrillAgent({ root: process.cwd(), environment: {} })).rejects.toMatchObject({
      name: "FiredrillAgentError",
      code: "agent.API_KEY_MISSING",
    } satisfies Partial<FiredrillAgentError>);
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled session without starting the SDK", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFiredrillAgent({
        root: process.cwd(),
        environment: { ANTHROPIC_API_KEY: "test-key" },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "agent.CANCELLED" });
    expect(mocked.query).not.toHaveBeenCalled();
  });

  it("honors cancellation when the SDK races and emits a late result", async () => {
    const controller = new AbortController();
    mocked.query.mockImplementationOnce(() => {
      const iterable = (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "session_late",
          model: "claude-sonnet-5",
        } as unknown as SDKMessage;
        controller.abort();
        yield {
          type: "result",
          subtype: "success",
          session_id: "session_late",
          is_error: false,
          num_turns: 1,
          duration_ms: 10,
          total_cost_usd: 0.001,
          result: "late result",
        } as unknown as SDKMessage;
      })();
      return iterable as Query;
    });

    await expect(
      runFiredrillAgent({
        root: process.cwd(),
        environment: { ANTHROPIC_API_KEY: "test-key" },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "agent.CANCELLED" });
  });

  it("runs Claude Agent SDK with bounded tools and a minimal environment", async () => {
    mocked.query.mockImplementationOnce((call: Record<string, unknown>) => {
      mocked.calls.push(call);
      return stream([
        {
          type: "system",
          subtype: "init",
          session_id: "session_test",
          model: "claude-sonnet-5",
        } as unknown as SDKMessage,
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "World validated." }] },
          session_id: "session_test",
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "session_test",
          is_error: false,
          num_turns: 3,
          duration_ms: 1200,
          total_cost_usd: 0.04,
          result: "World validated.",
        } as unknown as SDKMessage,
      ]);
    });
    const events: unknown[] = [];
    const result = await runFiredrillAgent({
      root: process.cwd(),
      prompt: "Validate this repository.",
      model: "sonnet",
      environment: {
        ANTHROPIC_API_KEY: "test-key",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.example.test:3128",
        SHOULD_NOT_REACH_AGENT: "private",
      },
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "session_test",
      turns: 3,
      result: "World validated.",
    });
    expect(events).toEqual([
      { type: "session", sessionId: "session_test", model: "claude-sonnet-5" },
      { type: "text", text: "World validated." },
    ]);
    const call = mocked.calls.at(-1) as {
      prompt: string;
      options: {
        tools: string[];
        allowedTools: string[];
        disallowedTools: string[];
        settingSources: string[];
        strictMcpConfig: boolean;
        persistSession: boolean;
        maxBudgetUsd: number;
        env: Record<string, string | undefined>;
      };
    };
    expect(call.prompt).toBe("Validate this repository.");
    expect(call.options.tools).toEqual(["Read", "Edit", "Write"]);
    expect(call.options.allowedTools).toContain("mcp__firedrill__repository_search");
    expect(call.options.allowedTools).not.toContain("Grep");
    expect(call.options.disallowedTools).toContain("Bash");
    expect(call.options.disallowedTools).toContain("Grep");
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.strictMcpConfig).toBe(true);
    expect(call.options.persistSession).toBe(false);
    expect(call.options.maxBudgetUsd).toBe(2);
    expect(call.options.env).toMatchObject({ ANTHROPIC_API_KEY: "test-key", PATH: "/usr/bin" });
    expect(call.options.env).toMatchObject({
      HTTPS_PROXY: "http://proxy.example.test:3128",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
    expect(call.options.env.HOME).toContain("firedrill-agent-home-");
    expect(call.options.env.CLAUDE_CONFIG_DIR).toContain("firedrill-agent-home-");
    expect(existsSync(call.options.env.HOME ?? "")).toBe(false);
    expect(call.options.env).not.toHaveProperty("SHOULD_NOT_REACH_AGENT");
  });
});
