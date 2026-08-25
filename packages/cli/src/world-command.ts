import { JsonObjectSchema } from "@firedrill/contracts";
import { CliWorldError, invokeCliWorldOperation, listCliWorldTools } from "@firedrill/protocol-cli";
import type { CliWriter } from "./program.js";

export interface WorldCommandInput {
  readonly command?: "call" | "tools";
  readonly packageId?: string;
  readonly operationId?: string;
  readonly input?: string;
  readonly idempotencyKey?: string;
  readonly json: boolean;
}

export interface WorldCommandIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

function writeJson(writer: CliWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function failure(input: WorldCommandInput, io: WorldCommandIo, error: unknown): number {
  const code = error instanceof CliWorldError ? error.code : "framework.INVALID_ARGUMENT";
  const message = error instanceof Error ? error.message : "world command failed";
  const details = error instanceof CliWorldError ? error.details : {};
  if (input.json) {
    writeJson(io.stdout, {
      schemaVersion: 1,
      command: input.command === "call" ? "world.call" : "world.tools",
      status: "failed",
      code,
      message,
      details,
    });
  } else {
    io.stderr.write(`${code} ${message}\n`);
  }
  return code === "framework.INVALID_ARGUMENT" ? 2 : 1;
}

function argumentsObject(value: string | undefined) {
  if (value === undefined) return {};
  if (Buffer.byteLength(value) > 1024 * 1024) {
    throw new TypeError("--input exceeds the 1 MiB local CLI limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("--input must be a valid JSON object");
  }
  const result = JsonObjectSchema.safeParse(parsed);
  if (!result.success) throw new TypeError("--input must be a JSON object");
  return result.data;
}

export async function executeWorldCommand(input: WorldCommandInput, io: WorldCommandIo): Promise<number> {
  try {
    if (input.command === "tools") {
      const tools = await listCliWorldTools({
        ...(io.environment === undefined ? {} : { environment: io.environment }),
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      });
      if (input.json) {
        writeJson(io.stdout, {
          schemaVersion: 1,
          command: "world.tools",
          status: "success",
          tools,
        });
      } else {
        for (const tool of tools) {
          io.stdout.write(`${tool.id}@${tool.version}\n`);
          for (const operation of tool.operations) {
            io.stdout.write(
              `  ${operation.id} — ${operation.fidelity}; idempotency ${operation.idempotency}\n`,
            );
          }
        }
      }
      return 0;
    }
    if (input.command !== "call" || input.packageId === undefined || input.operationId === undefined) {
      throw new TypeError("world call requires <tool-id> <operation-id>");
    }
    const result = await invokeCliWorldOperation({
      packageId: input.packageId,
      operationId: input.operationId,
      arguments: argumentsObject(input.input),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(io.environment === undefined ? {} : { environment: io.environment }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    if (input.json) {
      writeJson(io.stdout, {
        command: "world.call",
        status: "completed",
        ...result,
      });
    } else {
      writeJson(io.stdout, result.outcome);
    }
    return result.outcome.status === "ok" ? 0 : 1;
  } catch (error) {
    return failure(input, io, error);
  }
}
