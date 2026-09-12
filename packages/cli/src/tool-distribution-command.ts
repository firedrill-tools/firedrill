import type { CliIo } from "./program.js";
import { discoverTools, ToolDiscoveryError } from "./tool-discovery.js";
import { FiredrillToolInstallationError, installToolSource } from "./tool-installation.js";
import { createToolPackage } from "./tool-package-scaffold.js";
import { addToolPackage, FiredrillToolSetupError } from "./tool-setup.js";

/** Copyable POSIX-shell argument, never an executable interpolation from index metadata. */
export function sourceArgument(value: string): string {
  return /^[a-zA-Z0-9_@/.:+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

interface DistributionInput {
  readonly root: string;
  readonly json: boolean;
  readonly toolCommand?: string;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly toolIndex?: string;
  readonly toolLimit?: number;
  readonly toolOffset?: number;
  readonly toolTemplate?: "stateful" | "stateless";
}

/** Acquisition and discovery stay outside runtime dispatch and never evaluate Tool behavior. */
export async function executeToolDistributionCommand(input: DistributionInput, io: CliIo): Promise<number> {
  const command = `tool.${input.toolCommand}`;
  const emit = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (input.toolCommand === "search") {
      const result = await discoverTools({
        root: input.root,
        ...(input.toolId === undefined ? {} : { query: input.toolId }),
        ...(input.toolIndex === undefined ? {} : { index: input.toolIndex }),
        ...(input.toolLimit === undefined ? {} : { limit: input.toolLimit }),
        ...(input.toolOffset === undefined ? {} : { offset: input.toolOffset }),
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      });
      if (input.json) emit({ ...result, command, status: "success" });
      else {
        io.stdout.write(`Tools — ${result.source.location}\n`);
        for (const tool of result.tools) {
          io.stdout.write(
            `\n${tool.packageName}@${tool.version}${tool.installed ? " (installed)" : ""}\n  ${tool.description}\n`,
          );
          io.stdout.write(
            `  Operations: ${tool.operations.map((operation) => operation.id).join(", ")}\n  Metadata: ${tool.metadataOrigin === "publisher" ? "publisher-declared" : "installed declaration"}\n`,
          );
          io.stdout.write(`  Install: firedrill tool add ${sourceArgument(tool.installSource)} --install\n`);
          for (const limitation of tool.limitations) io.stdout.write(`  Limit: ${limitation}\n`);
        }
        io.stdout.write(
          `\nShowing ${result.tools.length === 0 ? 0 : result.offset + 1}–${result.tools.length === 0 ? 0 : result.offset + result.tools.length} of ${result.total}.\n`,
        );
        if (result.offset + result.tools.length < result.total)
          io.stdout.write(`Next page: repeat with --offset ${result.offset + result.limit}\n`);
        io.stdout.write(
          "Discovery reads metadata only. Review code and run conformance before trusting a Tool.\n",
        );
      }
      return 0;
    }
    if (input.toolId === undefined)
      throw new FiredrillToolSetupError(
        "framework.TOOL_SETUP_INVALID_ARGUMENT",
        "Provide a Tool id or package source.",
      );
    if (input.toolCommand === "create") {
      const setup = createToolPackage({
        root: input.root,
        id: input.toolId,
        ...(input.toolName === undefined ? {} : { packageName: input.toolName }),
        ...(input.toolTemplate === undefined ? {} : { template: input.toolTemplate }),
      });
      if (input.json) emit({ schemaVersion: 1, command, status: "success", setup });
      else {
        io.stdout.write(`Created independent Tool package ${setup.packageName}\n`);
        for (const path of setup.created) io.stdout.write(`Created ${path}\n`);
        io.stdout.write(
          `\nFrom ${input.root}, validate and test the Tool before sharing it.\nNo packages were installed, executed, or published.\n`,
        );
        for (const step of setup.nextSteps) io.stdout.write(`${step}\n`);
      }
      return 0;
    }
    const installation = await installToolSource({
      root: input.root,
      source: input.toolId,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    const setup = addToolPackage({ root: input.root, packageName: installation.packageName });
    if (input.json) emit({ schemaVersion: 1, command, status: "success", installation, setup });
    else {
      io.stdout.write(`Installed and selected ${installation.packageName}@${installation.version}\n`);
      for (const path of setup.created) io.stdout.write(`Created ${path}\n`);
      for (const path of setup.updated) io.stdout.write(`Updated ${path}\n`);
      for (const guidance of setup.grantGuidance) io.stdout.write(`${guidance}\n`);
      io.stdout.write(
        "Commit dependency manifests/locks and .firedrill-tools/ if created. Keep .firedrill/ private.\nReview the code, then run firedrill serve. No Tool behavior or agent was executed.\n",
      );
    }
    return 0;
  } catch (error) {
    if (
      !(error instanceof FiredrillToolSetupError) &&
      !(error instanceof FiredrillToolInstallationError) &&
      !(error instanceof ToolDiscoveryError)
    )
      throw error;
    const suggestion = error instanceof FiredrillToolInstallationError ? error.suggestion : undefined;
    if (input.json)
      emit({
        schemaVersion: 1,
        command,
        status: "failed",
        code: error.code,
        message: error.message,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
    else
      io.stderr.write(`${error.code} ${error.message}\n${suggestion === undefined ? "" : `${suggestion}\n`}`);
    return 2;
  }
}
