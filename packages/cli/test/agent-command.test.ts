import { afterEach, describe, expect, it, vi } from "vitest";
import { runFiredrillAgent } from "@firedrill-tools/agent";
import { runCli } from "../src/index.js";

vi.mock("@firedrill-tools/agent", () => ({
  runFiredrillAgent: vi.fn(),
  FiredrillAgentError: class FiredrillAgentError extends Error {},
}));

afterEach(() => vi.clearAllMocks());

async function invoke() {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["agent", "--workflow", "environment"], {
    cwd: process.cwd(),
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
  });
  return { code, stdout, stderr };
}

describe("Agent environment outcome", () => {
  it("prints verified readiness and exact next action without claiming the agent was tested", async () => {
    vi.mocked(runFiredrillAgent).mockResolvedValue({
      schemaVersion: 1,
      status: "completed",
      turns: 1,
      durationMs: 10,
      estimatedCostUsd: 0,
      result: "Source authored.",
      errors: [],
      readiness: {
        status: "ready",
        toolCount: 2,
        operationCount: 3,
        diagnostics: [],
        agentTested: false,
        actorId: "operator",
        nextCommand: "firedrill serve --actor operator",
      },
    });
    const result = await invoke();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Local Tools ready · 2 Tools · 3 operations · agent not tested");
    expect(result.stdout).toContain("Next: firedrill serve --actor operator");
  });

  it("shows readiness diagnostics and fails even if model prose claims completion", async () => {
    vi.mocked(runFiredrillAgent).mockResolvedValue({
      schemaVersion: 1,
      status: "completed",
      turns: 1,
      durationMs: 10,
      estimatedCostUsd: 0,
      result: "Everything completed!",
      errors: ["Listener verification failed."],
      readiness: {
        status: "failed",
        toolCount: 1,
        operationCount: 1,
        diagnostics: [
          {
            code: "FD1402",
            message: "Invalid Tool state. Correct the starter row.",
          },
        ],
        agentTested: false,
      },
    });
    const result = await invoke();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Local environment not ready");
    expect(result.stderr).toContain("FD1402 Invalid Tool state");
    expect(result.stderr).toContain("Correct the starter row.");
    expect(result.stderr).toContain("Listener verification failed.");
  });
});
