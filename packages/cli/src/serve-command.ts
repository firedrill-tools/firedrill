import { startLocalInspector } from "@firedrill/inspector";
import type { LocalWorld, LocalWorldBinding } from "@firedrill/sdk";
import { createLocalWorld, FiredrillProjectError } from "@firedrill/sdk";
import type { CliWriter } from "./program.js";

export interface ServeCommandInput {
  readonly root: string;
  readonly scenario?: string;
  readonly actorId?: string;
  readonly seed?: string;
  readonly httpPort?: number;
  readonly mcpPort?: number;
  readonly cliPort?: number;
  readonly json: boolean;
  readonly noOpen?: boolean;
}

interface ServeCommandIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly signal?: AbortSignal;
  readonly openUrl?: (url: string) => Promise<void>;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Foreground only: owns one world and its loopback listeners until the caller cancels. */
export async function executeServeCommand(input: ServeCommandInput, io: ServeCommandIo): Promise<number> {
  let world: LocalWorld | undefined;
  let binding: LocalWorldBinding | undefined;
  let inspector: Awaited<ReturnType<typeof startLocalInspector>> | undefined;
  let worldClosed = false;
  let failure: unknown;
  const closeWorld = () => {
    if (world === undefined || worldClosed) return;
    worldClosed = true;
    world.close();
  };
  try {
    if (!io.signal?.aborted) {
      world = await createLocalWorld({
        root: input.root,
        ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
        ...(input.seed === undefined ? {} : { seed: input.seed }),
      });
      if (!io.signal?.aborted) {
        binding = await world.listen({
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          ...(input.httpPort === undefined ? {} : { httpPort: input.httpPort }),
          ...(input.mcpPort === undefined ? {} : { mcpPort: input.mcpPort }),
          ...(input.cliPort === undefined ? {} : { cliPort: input.cliPort }),
        });
        if (!io.signal?.aborted) {
          inspector = await startLocalInspector({ root: input.root, environment: { world, binding } });
        }
        if (!io.signal?.aborted && inspector !== undefined) {
          const metadata = world.metadata();
          const endpoints = {
            ...(binding.http === undefined ? {} : { http: binding.http }),
            ...(binding.mcp === undefined ? {} : { mcp: binding.mcp }),
            ...(binding.cli === undefined ? {} : { cli: binding.cli }),
          };
          if (input.json) {
            io.stdout.write(
              `${JSON.stringify({
                schemaVersion: 1,
                command: "serve",
                status: "ready",
                worldInstanceId: metadata.worldInstanceId,
                buildHash: metadata.buildHash,
                directory: world.directoryPath,
                actorId: binding.actorId,
                ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
                environment: binding.environment,
                ...(binding.connections === undefined ? {} : { connections: binding.connections }),
                endpoints,
                url: inspector.url,
                testsExecuted: false,
              })}\n`,
            );
          } else {
            io.stdout.write(`Local backend active · actor ${binding.actorId}\n`);
            io.stdout.write(
              "No agent or tests were executed. Connect your existing client with these environment values:\n\n",
            );
            for (const [name, value] of Object.entries(binding.environment))
              io.stdout.write(`export ${name}=${shellValue(value)}\n`);
            for (const connection of binding.connections ?? []) {
              io.stdout.write(
                `\n${connection.title} (${connection.packageId}/${connection.id}) — optional test-process settings:\n`,
              );
              for (const [name, value] of Object.entries(connection.environment))
                io.stdout.write(`export ${name}=${shellValue(value)}\n`);
            }
            io.stdout.write(`\nThese tokens grant local access as ${binding.actorId}; keep them private.\n`);
            io.stdout.write(`World files: ${world.directoryPath}\nPress Ctrl+C to stop.\n`);
            io.stdout.write(`Inspector: ${inspector.url}\n`);
            if (input.noOpen !== true && io.openUrl !== undefined) {
              try {
                await io.openUrl(inspector.url);
              } catch {
                io.stderr.write(`Browser could not be opened. Visit ${inspector.url}\n`);
              }
            }
          }
          await waitForAbort(io.signal);
        }
      }
    }
  } catch (error) {
    if (!io.signal?.aborted) failure ??= error;
  } finally {
    try {
      await inspector?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await binding?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      closeWorld();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    const known = failure instanceof FiredrillProjectError ? failure : undefined;
    const portInUse =
      known?.details.code === "EADDRINUSE" ||
      (typeof failure === "object" && failure !== null && "code" in failure && failure.code === "EADDRINUSE");
    const code = portInUse ? "framework.PORT_IN_USE" : known ? known.code : "framework.SERVE_FAILED";
    const message = portInUse
      ? "A requested local port is already in use. Choose another port or use 0 for an available port."
      : known
        ? known.message
        : "The local backend could not start or shut down cleanly. Check the repository and local listener configuration.";
    if (input.json)
      io.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "serve", status: "failed", code, message, ...(known ? { diagnostics: known.diagnostics, details: known.details } : {}) })}\n`,
      );
    else {
      io.stderr.write(`${code} ${message}\n`);
      if (known) {
        for (const diagnostic of known.diagnostics)
          io.stderr.write(`${diagnostic.code} ${diagnostic.message}\n`);
        const available = known.details.available;
        if (Array.isArray(available) && available.length > 0)
          io.stderr.write(`Available: ${available.join(", ")}\n`);
      }
    }
    return code === "framework.INVALID_ARGUMENT" || code === "framework.SCENARIO_NOT_FOUND" ? 2 : 1;
  }
  if (input.json)
    io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "serve", status: "stopped" })}\n`);
  else io.stdout.write("Local backend stopped.\n");
  return 0;
}
