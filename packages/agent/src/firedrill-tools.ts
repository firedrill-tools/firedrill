import { compileWorld, formatWorldSources } from "@firedrill/compiler";
import { FIREDRILL_FRAMEWORK_VERSION } from "@firedrill/contracts";
import { FiredrillProjectError, inspectTool, runDrills, testTool, validateTool } from "@firedrill/sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listRepositoryFiles, searchRepository } from "./repository-inspection.js";

const MAX_TOOL_TEXT = 120_000;

function textResult(value: unknown, isError = false) {
  const serialized = JSON.stringify(value, null, 2);
  const text =
    serialized.length <= MAX_TOOL_TEXT
      ? serialized
      : `${serialized.slice(0, MAX_TOOL_TEXT)}\n… output truncated by Firedrill Agent`;
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown) {
  if (error instanceof FiredrillProjectError) {
    return textResult(
      {
        status: "failed",
        code: error.code,
        message: error.message,
        diagnostics: error.diagnostics,
        details: error.details,
      },
      true,
    );
  }
  return textResult(
    {
      status: "failed",
      code: "agent.COMMAND_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
    true,
  );
}

function planSummary(build: Awaited<ReturnType<typeof compileWorld>>) {
  if (build.status === "failed") return { status: "failed", diagnostics: build.diagnostics };
  return {
    status: "success",
    diagnostics: build.diagnostics,
    buildHash: build.build.manifest.buildHash,
    world: build.build.worldIr.world.id,
    tools: build.build.worldIr.tools.map((item) => ({
      id: item.id,
      version: item.version,
      operations: item.operations.map((operation) => ({
        id: operation.id,
        fidelity: operation.fidelity,
      })),
    })),
    scenarios: build.build.worldIr.scenarios.map((item) => item.id),
    targets: build.build.worldIr.targets.map((item) => ({
      id: item.id,
      kind: item.kind,
      bindings: item.bindings,
    })),
    drills: build.build.worldIr.drills.map((item) => ({
      id: item.id,
      targetId: item.targetId,
      scenarioId: item.scenarioId,
      assertions: item.assertions.length,
    })),
    suites: build.build.worldIr.suites.map((item) => item.id),
  };
}

export function createFiredrillAuthoringTools(repositoryRoot: string) {
  return [
    tool(
      "repository_files",
      "List ordinary repository files without traversing secrets, generated evidence, dependencies, or symlinks.",
      {
        path: z.string().optional().describe("Optional repository-relative directory"),
        contains: z.string().optional().describe("Optional case-insensitive substring filter for paths"),
        limit: z.number().int().min(1).max(5_000).optional(),
      },
      async ({ path, contains, limit }) => {
        try {
          return textResult({
            status: "success",
            ...listRepositoryFiles({
              repositoryRoot,
              ...(path === undefined ? {} : { path }),
              ...(contains === undefined ? {} : { contains }),
              ...(limit === undefined ? {} : { limit }),
            }),
          });
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "repository_search",
      "Search literal text in ordinary repository files without reading secrets, generated evidence, dependencies, large files, or symlinks.",
      {
        query: z.string().min(1).max(500),
        path: z.string().optional().describe("Optional repository-relative directory"),
        caseSensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      async ({ query, path, caseSensitive, limit }) => {
        try {
          return textResult({
            status: "success",
            ...searchRepository({
              repositoryRoot,
              query,
              ...(path === undefined ? {} : { path }),
              ...(caseSensitive === undefined ? {} : { caseSensitive }),
              ...(limit === undefined ? {} : { limit }),
            }),
          });
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "validate",
      "Compile and validate this repository's Firedrill source without executing Tool behavior.",
      {},
      async () => {
        try {
          const result = await compileWorld({ repositoryRoot, materialize: false });
          return textResult(
            result.status === "success"
              ? {
                  status: "success",
                  diagnostics: result.diagnostics,
                  buildHash: result.build.manifest.buildHash,
                }
              : result,
            result.status === "failed",
          );
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "format",
      "Canonicalize typed Firedrill YAML and JSON source, or check it without writing.",
      { check: z.boolean().optional().describe("Use true to report pending changes without writing") },
      async ({ check }) => {
        try {
          const result = await formatWorldSources({ repositoryRoot, check: check ?? false });
          const pending =
            result.status === "success" && check === true
              ? result.files.filter((file) => file.changed).map((file) => file.path)
              : [];
          return textResult(
            pending.length === 0
              ? result
              : { status: "changes_required", changed: pending, diagnostics: result.diagnostics },
            result.status === "failed" || pending.length > 0,
          );
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "plan",
      "Show the resolved world, Tools, scenarios, targets, drills, suites, and build identity.",
      {},
      async () => {
        try {
          const result = planSummary(await compileWorld({ repositoryRoot, materialize: false }));
          return textResult(result, result.status === "failed");
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "run",
      "Run one drill or suite through the real local runner and return verdicts plus report paths.",
      {
        drill: z.string().min(1).optional(),
        suite: z.string().min(1).optional(),
        trials: z.number().int().min(1).max(20).optional(),
        seed: z.string().min(1).optional(),
      },
      async ({ drill, suite, trials, seed }) => {
        try {
          if (drill !== undefined && suite !== undefined) {
            return textResult(
              {
                status: "failed",
                code: "agent.INVALID_ARGUMENT",
                message: "choose either drill or suite, not both",
              },
              true,
            );
          }
          const result = await runDrills({
            root: repositoryRoot,
            ...(drill === undefined ? {} : { drill }),
            ...(suite === undefined ? {} : { suite }),
            ...(trials === undefined ? {} : { trials }),
            ...(seed === undefined ? {} : { seed }),
          });
          return textResult({
            status: "completed",
            verdict: result.verdict,
            buildHash: result.buildHash,
            drills: result.drills.map((item) => ({
              id: item.drillId,
              verdict: item.verdict,
              trials: item.trials.map((trial) => ({
                trial: trial.trial,
                seed: trial.seed,
                verdict: trial.verdict,
                htmlReport: trial.report.files.html,
                jsonReport: trial.report.files.json,
              })),
            })),
          });
        } catch (error) {
          return failure(error);
        }
      },
    ),
    tool(
      "tool_check",
      "Inspect, load-validate, or conformance-test one selected Firedrill Tool.",
      {
        toolId: z.string().min(1),
        check: z.enum(["inspect", "validate", "test"]),
        suite: z.string().min(1).optional(),
        seed: z.string().min(1).optional(),
      },
      async ({ toolId, check, suite, seed }) => {
        try {
          if (check === "inspect") return textResult(await inspectTool({ root: repositoryRoot, toolId }));
          if (check === "validate") {
            return textResult(await validateTool({ root: repositoryRoot, toolId }));
          }
          const result = await testTool({
            root: repositoryRoot,
            toolId,
            ...(suite === undefined ? {} : { suite }),
            ...(seed === undefined ? {} : { seed }),
          });
          return textResult(result, result.status !== "passed");
        } catch (error) {
          return failure(error);
        }
      },
    ),
  ];
}

export function createFiredrillAuthoringServer(repositoryRoot: string) {
  return createSdkMcpServer({
    name: "firedrill",
    version: FIREDRILL_FRAMEWORK_VERSION,
    instructions:
      "Use these tools instead of a shell for Firedrill validation, formatting, planning, Tool checks, and drill execution. Treat their structured results as authoritative.",
    alwaysLoad: true,
    tools: createFiredrillAuthoringTools(repositoryRoot),
  });
}
