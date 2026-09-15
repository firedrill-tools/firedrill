import type { CliIo } from "./program.js";

export interface AgentCommandInput {
  readonly root: string;
  readonly json: boolean;
  readonly agentWorkflow?: "environment" | "drill";
  readonly agentPrompt?: string;
  readonly agentModel?: string;
  readonly agentEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly agentMaxTurns?: number;
  readonly agentMaxBudgetUsd?: number;
  readonly agentTimeoutMs?: number;
  readonly onResult?: (result: import("@firedrill/agent").FiredrillAgentResult) => void;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function executeAgentCommand(parsed: AgentCommandInput, io: CliIo): Promise<number> {
  let agentPackage: typeof import("@firedrill/agent");
  try {
    agentPackage = await import("@firedrill/agent");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND"
        ? "Install the optional authoring package beside the CLI: pnpm add -D @firedrill/agent"
        : "The optional Firedrill Agent package could not be loaded.";
    if (parsed.json) {
      writeJson(io, {
        schemaVersion: 1,
        command: "agent",
        status: "failed",
        code: "agent.NOT_AVAILABLE",
        message,
      });
    } else io.stderr.write(`agent.NOT_AVAILABLE ${message}\n`);
    return 2;
  }

  let wroteText = false;
  try {
    const result = await agentPackage.runFiredrillAgent({
      root: parsed.root,
      ...(parsed.agentWorkflow === undefined ? {} : { workflow: parsed.agentWorkflow }),
      ...(parsed.agentPrompt === undefined ? {} : { prompt: parsed.agentPrompt }),
      ...(parsed.agentModel === undefined ? {} : { model: parsed.agentModel }),
      ...(parsed.agentEffort === undefined ? {} : { effort: parsed.agentEffort }),
      ...(parsed.agentMaxTurns === undefined ? {} : { maxTurns: parsed.agentMaxTurns }),
      ...(parsed.agentMaxBudgetUsd === undefined ? {} : { maxBudgetUsd: parsed.agentMaxBudgetUsd }),
      ...(parsed.agentTimeoutMs === undefined ? {} : { timeoutMs: parsed.agentTimeoutMs }),
      ...(io.environment === undefined ? {} : { environment: io.environment }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(parsed.json
        ? {}
        : {
            onEvent: (event: import("@firedrill/agent").FiredrillAgentEvent) => {
              if (event.type === "session") {
                io.stdout.write(`Firedrill Agent · ${event.model}\n\n`);
              } else if (event.type === "text") {
                wroteText = true;
                io.stdout.write(`${event.text}${event.text.endsWith("\n") ? "" : "\n"}`);
              } else if (event.type === "tool") {
                io.stdout.write(`  → ${event.name.replace(/^mcp__firedrill__/, "firedrill ")}\n`);
              } else io.stderr.write(`${event.message}\n`);
            },
          }),
    });
    const status =
      result.status === "completed" && result.readiness?.status !== "failed" ? "completed" : "failed";
    parsed.onResult?.(result);
    if (parsed.json) writeJson(io, { command: "agent", ...result, status });
    else {
      if (!wroteText && result.result !== undefined) io.stdout.write(`${result.result}\n`);
      io.stdout.write(
        `\nAgent ${status} · ${result.turns} turn${result.turns === 1 ? "" : "s"} · $${result.estimatedCostUsd.toFixed(4)} estimated\n`,
      );
      const readiness = result.readiness;
      if (readiness !== undefined) {
        const label =
          readiness.status === "ready"
            ? "Local Tools ready"
            : readiness.status === "source-validated"
              ? "Source validated; runtime not checked"
              : "Local environment not ready";
        io.stdout.write(
          `${label} · ${readiness.toolCount} Tools · ${readiness.operationCount} operations · agent not tested\n`,
        );
        if (readiness.nextCommand !== undefined) io.stdout.write(`Next: ${readiness.nextCommand}\n`);
        for (const diagnostic of readiness.diagnostics) {
          io.stderr.write(`${diagnostic.code} ${diagnostic.message}\n`);
        }
      }
      for (const error of result.errors) io.stderr.write(`${error}\n`);
    }
    return status === "completed" ? 0 : 1;
  } catch (error) {
    const known = error instanceof agentPackage.FiredrillAgentError;
    const code = known ? error.code : "agent.EXECUTION_FAILED";
    const message = known ? error.message : "Firedrill Agent failed before producing a result.";
    if (parsed.json) {
      writeJson(io, { schemaVersion: 1, command: "agent", status: "failed", code, message });
    } else io.stderr.write(`${code} ${message}\n`);
    return code === "agent.API_KEY_MISSING" || code === "agent.INVALID_OPTIONS" ? 2 : 1;
  }
}
