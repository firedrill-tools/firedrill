import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { compileWorld } from "@firedrill-run/compiler";
import { FIREDRILL_FRAMEWORK_VERSION, JsonObjectSchema } from "@firedrill-run/contracts";
import type { LocalWorld, LocalWorldBinding } from "@firedrill-run/sdk";
import { createLocalWorld, FiredrillProjectError, inspectTool, runDrills } from "@firedrill-run/sdk";
import type { BaseContext, CallToolResult, JsonSchemaType } from "@modelcontextprotocol/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { CliIo } from "./program.js";
import { readyTools } from "./tool-catalog.js";

const HELP = `Firedrill MCP — let a coding agent inspect and operate this project's test environment

Usage:
  firedrill mcp [--root <path>] [--allow-execution]

Starts a local stdio MCP server. Configure your coding agent to launch this command;
stdout is reserved for the MCP protocol. No account, model key, or automatic install.

Default: inspect source, validate, preview the build, and browse the Tool catalog.
--allow-execution also permits trusted repository Tool code, local servers, resets,
and drill targets. A drill target may contact a model provider using its declared
environment variables and incur charges. This flag is permission, not a sandbox.

The server is scoped to one root, never changes production agent configuration,
and closes every environment it owns on disconnect or interrupt. Credentials are
only returned by environment_connect. Reports remain in the project .firedrill/.
Guide: docs/control-mcp.md in the installed Firedrill documentation.
`;

const MAX_RESULT_BYTES = 1_000_000;
const MAX_ENVIRONMENTS = 4;
const MAX_PENDING = 32;
const idSchema = { type: "string", minLength: 1, maxLength: 200 } as const;
const textSchema = { type: "string", maxLength: 500 } as const;
const pageProperties = {
  offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
} as const;
const environmentProperties = { environmentId: idSchema };

type Arguments = Record<string, unknown>;
interface OwnedEnvironment {
  readonly world: LocalWorld;
  readonly binding: LocalWorldBinding;
}

class McpCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function string(input: Arguments, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined;
}

function requiredString(input: Arguments, key: string): string {
  const value = string(input, key);
  if (value === undefined) throw new McpCommandError("framework.INVALID_ARGUMENT", `${key} must be a string`);
  return value;
}

function number(input: Arguments, key: string, fallback: number): number {
  return typeof input[key] === "number" ? input[key] : fallback;
}

function page<T>(items: readonly T[], input: Arguments) {
  const offset = number(input, "offset", 0);
  const limit = number(input, "limit", 25);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
  };
}

function result(value: unknown, isError = false): CallToolResult {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > MAX_RESULT_BYTES) {
    return result(
      {
        status: "failed",
        code: "framework.MCP_RESULT_TOO_LARGE",
        message: "Result exceeds 1 MB. Request fewer items or inspect the saved report locally.",
      },
      true,
    );
  }
  const structuredContent = JSON.parse(content) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: content }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function failure(error: unknown): CallToolResult {
  if (error instanceof McpCommandError)
    return result({ status: "failed", code: error.code, message: error.message }, true);
  return error instanceof FiredrillProjectError
    ? result(
        { status: "failed", code: error.code, message: error.message, diagnostics: error.diagnostics },
        true,
      )
    : result(
        {
          status: "failed",
          code: "framework.MCP_OPERATION_FAILED",
          message:
            "The operation did not finish. Validate the project and inspect local diagnostics before retrying.",
        },
        true,
      );
}

/** Independent of the synthetic Tool MCP endpoint: this server is for the test author. */
export async function executeMcpCommand(arguments_: readonly string[], io: CliIo): Promise<number> {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    io.stdout.write(HELP);
    return 0;
  }
  let root = io.cwd;
  let allowExecution = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--allow-execution") allowExecution = true;
    else if (argument === "--root" && next !== undefined && !next.startsWith("--")) {
      root = resolve(io.cwd, next);
      index += 1;
    } else {
      io.stderr.write("Invalid MCP option. Use firedrill mcp --help.\n");
      return 2;
    }
  }
  const input = io.stdio?.input ?? process.stdin;
  const output = io.stdio?.output ?? process.stdout;
  const cancellation = new AbortController();
  const environments = new Map<string, OwnedEnvironment>();
  const server = new McpServer({ name: "firedrill", version: FIREDRILL_FRAMEWORK_VERSION });
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let stop = () => {};
  const stopped = new Promise<void>((done) => {
    stop = () => {
      cancellation.abort();
      done();
    };
  });

  function environment(input: Arguments): OwnedEnvironment {
    const item = environments.get(string(input, "environmentId") ?? "");
    if (item === undefined)
      throw new McpCommandError(
        "framework.MCP_ENVIRONMENT_NOT_FOUND",
        "This server does not own that environment. Start one or list active environments.",
      );
    return item;
  }
  function status(environmentId: string, owned: OwnedEnvironment) {
    const description = owned.world.describe();
    return {
      environmentId,
      worldId: description.worldId,
      ...(description.scenarioId === undefined ? {} : { scenarioId: description.scenarioId }),
      generation: description.generation,
      buildHash: description.buildHash,
      actorId: owned.binding.actorId,
      toolCount: description.tools.length,
      metadata: owned.world.metadata(),
    };
  }
  function tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: readonly string[],
    execute: (input: Arguments, signal: AbortSignal) => unknown | Promise<unknown>,
    execution = false,
    readOnly = !execution,
  ) {
    if (execution && !allowExecution) return;
    const inputSchema = fromJsonSchema({
      type: "object",
      properties,
      required: [...required],
      additionalProperties: false,
    } as JsonSchemaType);
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: execution && !readOnly,
        },
      },
      async (value: unknown, context: BaseContext) => {
        if (pending >= MAX_PENDING)
          return result(
            {
              status: "failed",
              code: "framework.MCP_BUSY",
              message: "Too many pending operations; wait for the current operation to finish.",
            },
            true,
          );
        pending += 1;
        const signal = AbortSignal.any([cancellation.signal, context.mcpReq.signal]);
        let response: CallToolResult = result({ status: "cancelled" }, true);
        const operation = tail
          .then(async () => {
            if (signal.aborted) return;
            try {
              const output = await execute(value as Arguments, signal);
              response = result(
                output,
                typeof output === "object" &&
                  output !== null &&
                  "status" in output &&
                  output.status === "failed",
              );
            } catch (error) {
              response = failure(error);
            }
          })
          .finally(() => {
            pending -= 1;
          });
        tail = operation.catch(() => {});
        await operation;
        return response;
      },
    );
  }

  tool(
    "project_validate",
    "Validate repository world definitions without executing Tool behavior or writing build files.",
    {},
    [],
    async () => {
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      return compiled.status === "failed"
        ? compiled
        : {
            status: "success",
            buildHash: compiled.build.manifest.buildHash,
            diagnostics: compiled.diagnostics,
          };
    },
  );
  tool(
    "project_plan",
    "Summarize the world, resource counts, and source locations without running code. Use project_inspect for a specific resource.",
    {},
    [],
    async () => {
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      if (compiled.status === "failed") return compiled;
      const ir = compiled.build.worldIr;
      return {
        status: "success",
        root,
        executionAllowed: allowExecution,
        worldId: ir.world.id,
        buildHash: compiled.build.manifest.buildHash,
        counts: {
          tools: ir.tools.length,
          scenarios: ir.scenarios.length,
          drills: ir.drills.length,
          targets: ir.targets.length,
          suites: ir.suites.length,
        },
        diagnostics: compiled.diagnostics,
      };
    },
  );
  tool(
    "project_inspect",
    "Read a paginated compiled resource collection or one resource by id. Reads test definitions, not application files or secrets.",
    {
      kind: { type: "string", enum: ["world", "tools", "scenarios", "drills", "targets", "suites"] },
      id: idSchema,
      ...pageProperties,
    },
    ["kind"],
    async (input) => {
      const compiled = await compileWorld({ repositoryRoot: root, materialize: false });
      if (compiled.status === "failed") return compiled;
      const ir = compiled.build.worldIr;
      const kind = string(input, "kind") as "world" | "tools" | "scenarios" | "drills" | "targets" | "suites";
      const collection: readonly { readonly id: string }[] = kind === "world" ? [ir.world] : ir[kind];
      const selected = string(input, "id");
      return {
        status: "success",
        kind,
        ...page(
          selected === undefined ? collection : collection.filter((item) => item.id === selected),
          input,
        ),
      };
    },
  );
  tool(
    "tool_catalog",
    "Search bundled reusable Tools and their stated limitations. Never installs anything.",
    { query: textSchema, ...pageProperties },
    [],
    (input) => ({ status: "success", ...page(readyTools(root, string(input, "query")), input) }),
  );
  tool(
    "tool_inspect",
    "Inspect a project Tool's contracts, source paths, operation behavior entry, and fidelity without executing it.",
    { toolId: idSchema },
    ["toolId"],
    async (input) => ({
      status: "success",
      ...(await inspectTool({ root, toolId: requiredString(input, "toolId") })),
    }),
  );

  tool(
    "environment_start",
    "Execute trusted repository Tool code and start an isolated local world with HTTP, MCP, and CLI endpoints. Does not run the customer's agent. At most four environments may be open.",
    {
      scenario: idSchema,
      drill: idSchema,
      seed: { type: "string", pattern: "^[0-9]{1,20}$" },
      actorId: idSchema,
    },
    [],
    async (input, signal) => {
      if (environments.size >= MAX_ENVIRONMENTS)
        throw new McpCommandError(
          "framework.MCP_ENVIRONMENT_LIMIT",
          "Close an environment before starting another; the limit is four.",
        );
      if (input.scenario !== undefined && input.drill !== undefined)
        throw new FiredrillProjectError(
          "framework.INVALID_ARGUMENT",
          "Select a scenario or a drill, not both.",
        );
      const world = await createLocalWorld({
        root,
        ...(input.scenario === undefined ? {} : { scenario: requiredString(input, "scenario") }),
        ...(input.drill === undefined ? {} : { drill: requiredString(input, "drill") }),
        ...(input.seed === undefined ? {} : { seed: requiredString(input, "seed") }),
      });
      let binding: LocalWorldBinding | undefined;
      try {
        signal.throwIfAborted();
        binding = await world.listen({
          protocols: ["http", "mcp", "cli"],
          ...(input.actorId === undefined ? {} : { actorId: requiredString(input, "actorId") }),
        });
        signal.throwIfAborted();
        const environmentId = `env_${randomUUID().replaceAll("-", "")}`;
        const owned = { world, binding };
        environments.set(environmentId, owned);
        return {
          status: "ready",
          ...status(environmentId, owned),
          next: "Use environment_connect to get explicit connection credentials. Use environment_tools to discover callable operations.",
        };
      } catch (error) {
        await binding?.close();
        world.close();
        throw error;
      }
    },
    true,
  );
  tool(
    "environment_list",
    "List environments owned by this MCP connection. Does not include access tokens.",
    {},
    [],
    () => ({ status: "success", items: [...environments].map(([id, owned]) => status(id, owned)) }),
    true,
    true,
  );
  tool(
    "environment_status",
    "Read current world identity, generation, seed, clock, and build. Does not return access tokens.",
    environmentProperties,
    ["environmentId"],
    (input) => ({ status: "success", ...status(requiredString(input, "environmentId"), environment(input)) }),
    true,
    true,
  );
  tool(
    "environment_connect",
    "Explicitly retrieve actor-scoped local endpoint URLs, tokens, and environment variables for a test process. Treat the response as credentials; do not commit it or put it in production configuration.",
    environmentProperties,
    ["environmentId"],
    (input) => {
      const { binding } = environment(input);
      return {
        status: "success",
        environmentId: input.environmentId,
        actorId: binding.actorId,
        environment: binding.environment,
        ...(binding.connections === undefined ? {} : { connections: binding.connections }),
        endpoints: { http: binding.http, mcp: binding.mcp, cli: binding.cli },
      };
    },
    true,
    true,
  );
  tool(
    "environment_tools",
    "Read callable Tool operation contracts, state namespaces, and faults from the running build.",
    { ...environmentProperties, ...pageProperties },
    ["environmentId"],
    (input) => ({ status: "success", ...page(environment(input).world.describe().tools, input) }),
    true,
    true,
  );
  tool(
    "environment_state",
    "Read synthetic Tool records. Pagination cursors are invalid after reset; start again when generation changes.",
    {
      ...environmentProperties,
      packageId: idSchema,
      namespace: idSchema,
      afterRowId: idSchema,
      limit: pageProperties.limit,
    },
    ["environmentId", "packageId", "namespace"],
    (input) => {
      const { world } = environment(input);
      const limit = number(input, "limit", 25);
      const rows = world.state({
        packageId: requiredString(input, "packageId"),
        namespace: requiredString(input, "namespace"),
        limit: limit + 1,
        ...(input.afterRowId === undefined ? {} : { afterRowId: requiredString(input, "afterRowId") }),
      });
      const items = rows.slice(0, limit);
      return {
        status: "success",
        generation: world.describe().generation,
        items,
        ...(rows.length > limit ? { nextAfterRowId: items.at(-1)?.rowId } : {}),
      };
    },
    true,
    true,
  );
  tool(
    "environment_evidence",
    "Read ordered local world activity. Operator calls are setup/exploration, not proof a target agent acted. May contain synthetic test data.",
    {
      ...environmentProperties,
      fromSequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      limit: pageProperties.limit,
    },
    ["environmentId"],
    (input) => {
      const { world } = environment(input);
      const limit = number(input, "limit", 25);
      const rows = world.evidence({ fromSequence: number(input, "fromSequence", 1), limit: limit + 1 });
      const items = rows.slice(0, limit);
      return {
        status: "success",
        generation: world.describe().generation,
        items,
        hasMore: rows.length > limit,
        ...(rows.length > limit ? { nextFromSequence: (items.at(-1)?.sequence ?? 0) + 1 } : {}),
      };
    },
    true,
    true,
  );
  const scenarioProperties = {
    ...environmentProperties,
    id: idSchema,
    title: textSchema,
    packages: { type: "array", items: idSchema, minItems: 1, maxItems: 100, uniqueItems: true },
  };
  function scenarioOptions(input: Arguments) {
    return {
      id: requiredString(input, "id"),
      ...(input.title === undefined ? {} : { title: requiredString(input, "title") }),
      ...(input.packages === undefined ? {} : { packages: input.packages as string[] }),
    };
  }
  tool(
    "environment_export_scenario",
    "Preview current Tool records as a reusable scenario. This is data-only setup, not a replay checkpoint: clock, actors, faults, timers and history inherit the repository baseline. Does not write source.",
    scenarioProperties,
    ["environmentId", "id"],
    (input) => ({ status: "success", ...environment(input).world.exportScenario(scenarioOptions(input)) }),
    true,
    true,
  );
  tool(
    "environment_save_scenario",
    "Save a previewed Tool-data scenario as a new repository source file. Requires explicit confirmation and the preview's hash and generation. Never overwrites an existing scenario or changes the running world.",
    {
      ...scenarioProperties,
      confirm: { type: "boolean", const: true },
      expectedSourceHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      expectedGeneration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
    ["environmentId", "id", "confirm", "expectedSourceHash", "expectedGeneration"],
    async (input) => ({
      status: "saved",
      ...(await environment(input).world.saveScenario({
        ...scenarioOptions(input),
        expectedSourceHash: requiredString(input, "expectedSourceHash"),
        expectedGeneration: number(input, "expectedGeneration", -1),
      })),
    }),
    true,
  );
  tool(
    "environment_call",
    "Invoke one synthetic Tool operation as the environment's selected actor. May mutate synthetic state; does not run the customer's agent.",
    {
      ...environmentProperties,
      packageId: idSchema,
      operationId: idSchema,
      arguments: { type: "object", additionalProperties: true },
      idempotencyKey: idSchema,
    },
    ["environmentId", "packageId", "operationId", "arguments"],
    (input) => {
      const { world, binding } = environment(input);
      return {
        status: "success",
        result: world.call({
          actorId: binding.actorId,
          packageId: requiredString(input, "packageId"),
          operationId: requiredString(input, "operationId"),
          arguments: JsonObjectSchema.parse(input.arguments),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: requiredString(input, "idempotencyKey") }),
        }),
      };
    },
    true,
  );
  tool(
    "environment_reset",
    "Reset all synthetic state to this environment's initial scenario and seed, or reset selected Tool packages. Discards current state in that scope; confirm must be true. Connection credentials remain valid.",
    {
      ...environmentProperties,
      packages: { type: "array", items: idSchema, minItems: 1, maxItems: 100, uniqueItems: true },
      confirm: { const: true, type: "boolean" },
    },
    ["environmentId", "confirm"],
    (input) => ({
      status: "success",
      result: environment(input).world.reset(
        input.packages === undefined ? {} : { packages: input.packages as string[] },
      ),
    }),
    true,
  );
  tool(
    "environment_advance_time",
    "Advance the virtual clock and process at most maxEvents scheduled events. toUs is an absolute virtual timestamp in microseconds, not elapsed wall time.",
    {
      ...environmentProperties,
      toUs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      maxEvents: { type: "integer", minimum: 1, maximum: 1000 },
    },
    ["environmentId", "toUs"],
    (input) => ({
      status: "success",
      result: environment(input).world.advanceTime(number(input, "toUs", 0), {
        maxEvents: number(input, "maxEvents", 100),
      }),
    }),
    true,
  );
  tool(
    "environment_set_fault",
    "Activate or deactivate a declared synthetic Tool fault in this environment.",
    { ...environmentProperties, packageId: idSchema, faultId: idSchema, active: { type: "boolean" } },
    ["environmentId", "packageId", "faultId", "active"],
    (input) => ({
      status: "success",
      result: environment(input).world.setFault({
        packageId: requiredString(input, "packageId"),
        faultId: requiredString(input, "faultId"),
        active: input.active as boolean,
      }),
    }),
    true,
  );
  tool(
    "environment_close",
    "Stop this environment's listeners, revoke its access, and close its SQLite handles. Retained local artifacts are not deleted.",
    environmentProperties,
    ["environmentId"],
    async (input) => {
      const owned = environment(input);
      environments.delete(requiredString(input, "environmentId"));
      try {
        await owned.binding.close();
      } finally {
        owned.world.close();
      }
      return { status: "closed", environmentId: input.environmentId };
    },
    true,
  );
  tool(
    "drill_run",
    "Run one repository drill against its declared target in fresh isolated worlds and write local reports. This can launch trusted subprocesses or call model providers; it is distinct from manually invoking a Tool. External callback targets require the SDK and cannot be driven here.",
    {
      drillId: idSchema,
      trials: { type: "integer", minimum: 1, maximum: 10 },
      seed: { type: "string", pattern: "^[0-9]{1,20}$" },
      timeoutMs: { type: "integer", minimum: 100, maximum: 600_000 },
    },
    ["drillId"],
    async (input, signal) => {
      const run = await runDrills({
        root,
        drill: requiredString(input, "drillId"),
        trials: number(input, "trials", 1),
        concurrency: 1,
        retries: 0,
        ...(input.seed === undefined ? {} : { seed: requiredString(input, "seed") }),
        hostEnvironment: io.environment ?? process.env,
        signal: AbortSignal.any([signal, AbortSignal.timeout(number(input, "timeoutMs", 120_000))]),
      });
      return {
        status: "completed",
        verdict: run.verdict,
        buildHash: run.buildHash,
        reportIndex: run.reportIndex,
        diagnostics: run.diagnostics,
        drills: run.drills.map((drill) => ({
          drillId: drill.drillId,
          verdict: drill.verdict,
          passed: drill.passed,
          failed: drill.failed,
          inconclusive: drill.inconclusive,
          trials: drill.trials.map((trial) => ({
            trial: trial.trial,
            seed: trial.seed,
            verdict: trial.verdict,
            runId: trial.result.runId,
            report: trial.report,
          })),
        })),
      };
    },
    true,
  );

  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_RESULT_BYTES });
  input.once("end", stop);
  input.once("close", stop);
  input.once("error", stop);
  io.signal?.addEventListener("abort", stop, { once: true });
  server.server.onclose = stop;
  server.server.onerror = () => {
    io.stderr.write("Firedrill MCP transport error; closing owned environments.\n");
    stop();
  };
  try {
    if (input.readableEnded || input.destroyed || io.signal?.aborted) stop();
    else await server.connect(transport);
    await stopped;
    return 0;
  } catch {
    io.stderr.write("Firedrill MCP could not start. Use firedrill mcp --help.\n");
    return 1;
  } finally {
    stop();
    await tail;
    const closed = await Promise.allSettled(
      [...environments.values()].map(async (owned) => {
        try {
          await owned.binding.close();
        } finally {
          owned.world.close();
        }
      }),
    );
    if (closed.some((item) => item.status === "rejected"))
      io.stderr.write("One or more local listeners reported a cleanup error.\n");
    environments.clear();
    try {
      await server.close();
    } finally {
      input.removeListener("end", stop);
      input.removeListener("close", stop);
      input.removeListener("error", stop);
      io.signal?.removeEventListener("abort", stop);
    }
  }
}
