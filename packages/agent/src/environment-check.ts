import { compileWorld } from "@firedrill/compiler";
import { createLocalWorld, FiredrillProjectError } from "@firedrill/sdk";

export interface FiredrillEnvironmentCheck {
  readonly status: "ready" | "source-validated" | "failed";
  readonly toolCount: number;
  readonly operationCount: number;
  readonly buildHash?: string;
  /** Identity used by the startup check; required when resuming a multi-actor world. */
  readonly actorId?: string;
  readonly nextCommand?: string;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  /** Starting a backend does not exercise the customer's agent. */
  readonly agentTested: false;
}

/** Authoring completion is checked independently of the model's response. */
export async function checkFiredrillEnvironment(
  root: string,
  allowRepositoryExecution = true,
): Promise<FiredrillEnvironmentCheck> {
  let toolCount = 0;
  let operationCount = 0;
  try {
    const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
    if (compiled.status === "failed") {
      return {
        status: "failed",
        toolCount,
        operationCount,
        diagnostics: compiled.diagnostics,
        agentTested: false,
      };
    }
    const tools = compiled.build.worldIr.tools;
    toolCount = tools.length;
    operationCount = tools.reduce((count, item) => count + item.operations.length, 0);
    if (operationCount === 0) {
      return {
        status: "failed",
        toolCount,
        operationCount,
        diagnostics: [
          {
            code: "agent.NO_TOOL_OPERATIONS",
            message: "Select or define a tool with at least one operation before starting the environment.",
          },
        ],
        agentTested: false,
      };
    }
    const summary = {
      toolCount,
      operationCount,
      buildHash: compiled.build.manifest.buildHash,
      diagnostics: compiled.diagnostics,
      agentTested: false as const,
    };
    if (!allowRepositoryExecution) return { ...summary, status: "source-validated" };
    const world = await createLocalWorld({ root });
    try {
      // Exercise listener startup against the immutable build, without making up
      // arguments or performing a mutation the user did not request.
      const actor = world.describe().actors.find((item) => item.grants.length > 0);
      if (actor === undefined) {
        return {
          ...summary,
          status: "failed",
          diagnostics: [
            {
              code: "agent.NO_TOOL_ACCESS",
              message: "Give a world actor explicit access to the selected tools before connecting an agent.",
            },
          ],
        };
      }
      const binding = await world.listen({ actorId: actor.actorId });
      await binding.close();
      return {
        ...summary,
        status: "ready",
        actorId: actor.actorId,
        nextCommand: `firedrill serve --actor ${actor.actorId}`,
      };
    } finally {
      world.close();
    }
  } catch (error) {
    return {
      status: "failed",
      toolCount,
      operationCount,
      diagnostics: [
        {
          code: error instanceof FiredrillProjectError ? error.code : "agent.ENVIRONMENT_CHECK_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      agentTested: false,
    };
  }
}
