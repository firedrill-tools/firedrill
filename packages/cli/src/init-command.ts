import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWorld, inspectInstalledToolPackage } from "@firedrill/compiler";
import { NodePackageNameSchema } from "@firedrill/contracts";
import { executeAgentCommand } from "./agent-command.js";
import { FiredrillInitError, type InitializedProject, type InitPath, initProject } from "./init-project.js";
import { installReadyTool, toolInstallPlan } from "./install-tool.js";
import type { CliIo } from "./program.js";
import { executeServeCommand } from "./serve-command.js";
import type { ReadyTool } from "./tool-catalog.js";
import {
  type DiscoveredTool,
  discoverTools,
  resolveDiscoveredTool,
  ToolDiscoveryError,
} from "./tool-discovery.js";
import { sourceArgument } from "./tool-distribution-command.js";
import { FiredrillToolInstallationError, installToolSource } from "./tool-installation.js";
import { addToolPackages, createTool, FiredrillToolSetupError, type ToolSetupResult } from "./tool-setup.js";

export interface InitCommandInput {
  readonly root: string;
  readonly json: boolean;
  readonly initPath?: InitPath;
  readonly initTool?: readonly string[];
  readonly initCustom?: string;
  readonly initSearch?: string;
  readonly toolIndex?: string;
  readonly initAuthoring?: "manual" | "firedrill-agent" | "coding-agent";
  readonly initInstall?: boolean;
  readonly initAllowAgent?: boolean;
  readonly initStart?: boolean;
  readonly noOpen?: boolean;
  readonly actorId?: string;
}

function emit(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function initialized(io: CliIo, result: InitializedProject): void {
  io.stdout.write(`Initialized the ${result.path} path.\n`);
  if (result.path === "firedrill-agent" || result.path === "coding-agent") {
    io.stdout.write("Canonical authoring skill and repository brief are in .agents/.\n");
    if (result.path === "coding-agent")
      io.stdout.write(
        "Ask your coding agent to read .agents/firedrill/BRIEF.md and set up the local Tool environment.\n",
      );
    return;
  }
  for (const path of result.written) io.stdout.write(`Created ${path}\n`);
  for (const path of result.updated) io.stdout.write(`Updated ${path}\n`);
  for (const path of result.unchanged) io.stdout.write(`Kept identical ${path}\n`);
  for (const step of result.next) io.stdout.write(`Next: ${step}\n`);
}

function catalog(io: CliIo, tools: readonly ReadyTool[], allowCustom = true): void {
  if (tools.length === 0)
    io.stdout.write("No matching ready-made Tool in the bundled catalog. Create a custom Tool below.\n");
  tools.forEach((tool, index) => {
    io.stdout.write(
      `  ${index + 1}. ${tool.id} — ${tool.packageName}@${tool.version} (${tool.installed ? "installed" : "installation required"})\n     ${tool.description}\n`,
    );
    io.stdout.write(
      `     ${tool.operations.length} declared operations; bounded compatibility, not a complete service replica.\n`,
    );
  });
  if (allowCustom) io.stdout.write("  c. Create your own local Tool (no key or account)\n");
}

function yes(answer: string, defaultValue = false): boolean {
  const value = answer.trim().toLowerCase();
  return value === "y" || value === "yes" || (value === "" && defaultValue);
}

interface ToolSelection {
  readonly selector: string;
  readonly entry: DiscoveredTool | undefined;
  readonly packageName: string | undefined;
  readonly sourceKey: string;
}

function localSourcePath(root: string, selector: string): string | undefined {
  if (!selector.startsWith(".") && !selector.startsWith("file:") && !isAbsolute(selector)) return undefined;
  try {
    return selector.startsWith("file://")
      ? fileURLToPath(new URL(selector))
      : resolve(root, selector.startsWith("file:") ? selector.slice(5) : selector);
  } catch {
    return undefined;
  }
}

/** Read identity hints only. Acquisition still validates the complete package before installation. */
function selectionIdentity(root: string, selector: string, entry: DiscoveredTool | undefined): ToolSelection {
  if (entry !== undefined)
    return { selector, entry, packageName: entry.packageName, sourceKey: entry.installSource };
  const local = localSourcePath(root, selector);
  if (local !== undefined) {
    let sourceKey = `local:${resolve(local)}`;
    let packageName: string | undefined;
    try {
      sourceKey = `local:${realpathSync(local)}`;
      const manifestPath = join(local, "package.json");
      const metadata = lstatSync(manifestPath);
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1_048_576) {
        const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest !== null && typeof manifest === "object" && "name" in manifest) {
          const parsed = NodePackageNameSchema.safeParse(manifest.name);
          if (parsed.success) packageName = parsed.data;
        }
      }
    } catch {
      /* Invalid or unavailable sources receive their actionable error during acquisition. */
    }
    return { selector, entry, packageName, sourceKey };
  }
  const npm = selector.startsWith("npm:") ? selector.slice(4) : selector;
  const separator = npm.lastIndexOf("@");
  const name = separator > 0 ? npm.slice(0, separator) : npm;
  if (NodePackageNameSchema.safeParse(name).success) {
    let version = separator > 0 ? npm.slice(separator + 1) : "latest";
    if (separator <= 0) {
      const installed = inspectInstalledToolPackage({ repositoryRoot: root, packageName: name });
      if (installed.status === "success") version = installed.package.version;
    }
    return { selector, entry, packageName: name, sourceKey: `${name}@${version}` };
  }
  return { selector, entry, packageName: undefined, sourceKey: selector };
}

function selectionConflict(packageName: string, afterAcquisition = false): never {
  throw new ToolDiscoveryError(
    "framework.TOOL_SELECTION_CONFLICT",
    `Choose one version and source for ${packageName}; multiple conflicting selections cannot share one package dependency.${afterAcquisition ? " Acquisition revealed the conflict; inspect package.json and its lock for dependency changes. No Firedrill source selection was written." : " No packages were acquired or setup files written."}`,
  );
}

async function planToolSelections(
  input: InitCommandInput,
  selectors: readonly string[],
  signal?: AbortSignal,
): Promise<readonly ToolSelection[]> {
  const selections: ToolSelection[] = [];
  const packages = new Map<string, string>();
  const sources = new Set<string>();
  for (const selector of selectors) {
    const entry = await resolveDiscoveredTool({
      root: input.root,
      selector,
      ...(input.toolIndex === undefined ? {} : { index: input.toolIndex }),
      ...(signal === undefined ? {} : { signal }),
    });
    const selection = selectionIdentity(input.root, selector, entry);
    if (selection.packageName !== undefined) {
      const previous = packages.get(selection.packageName);
      if (previous !== undefined && previous !== selection.sourceKey)
        selectionConflict(selection.packageName);
      packages.set(selection.packageName, selection.sourceKey);
    }
    if (sources.has(selection.sourceKey)) continue;
    sources.add(selection.sourceKey);
    selections.push(selection);
  }
  return selections;
}

async function authorEnvironment(
  input: InitCommandInput,
  io: CliIo,
  onReady?: (actorId: string) => void,
): Promise<number> {
  const resume = "firedrill agent --workflow environment";
  const allowed =
    input.initAllowAgent === true ||
    (!input.json &&
      io.ask !== undefined &&
      yes(
        await io.ask(
          "Start Firedrill Agent now? It can edit and execute repository code and sends selected source to Anthropic using your key (up to $2 by default). [y/N] ",
        ),
      ));
  if (!allowed) {
    if (input.json)
      emit(io, {
        schemaVersion: 1,
        command: "init",
        status: "authoring-pending",
        code: "agent.CONSENT_REQUIRED",
        next: resume,
      });
    else io.stdout.write(`Authoring is optional. Resume when ready: ${resume}\n`);
    return 0;
  }
  if (!(io.environment ?? process.env).ANTHROPIC_API_KEY) {
    const message =
      "Set ANTHROPIC_API_KEY in your shell or secret manager, then resume. Do not paste a key into this prompt or command arguments.";
    if (input.json)
      emit(io, {
        schemaVersion: 1,
        command: "init",
        status: "authoring-pending",
        code: "agent.API_KEY_MISSING",
        message,
        next: resume,
      });
    else
      io.stdout.write(
        `${message}\nResume: ${resume}\nYour local Tool setup remains usable without the Agent.\n`,
      );
    return 0;
  }
  return executeAgentCommand(
    {
      root: input.root,
      json: input.json,
      agentWorkflow: "environment",
      onResult: (result) => {
        if (result.readiness?.status === "ready" && result.readiness.actorId !== undefined)
          onReady?.(result.readiness.actorId);
      },
    },
    io,
  );
}

async function finish(input: InitCommandInput, io: CliIo, readyActorId?: string): Promise<number> {
  const start =
    input.initStart === true ||
    (!input.json &&
      io.ask !== undefined &&
      yes(
        await io.ask(
          "Start the local fake tools and open the inspector now? This executes selected Tool code, not your agent or tests. [Y/n] ",
        ),
        true,
      ));
  if (!start) {
    if (!input.json) io.stdout.write("Start later: firedrill serve\n");
    return 0;
  }
  let actorId = input.actorId ?? readyActorId;
  if (actorId === undefined && !input.json && io.ask !== undefined) {
    const compiled = await compileWorld({ repositoryRoot: input.root, materialize: false });
    if (compiled.status === "success" && compiled.build.worldIr.baseline.actors.length > 1) {
      const available = compiled.build.worldIr.baseline.actors.map((actor) => actor.id);
      actorId = (await io.ask(`Connect as which actor? ${available.join(", ")}: `)).trim();
      if (!available.includes(actorId))
        throw new FiredrillToolSetupError(
          "framework.TOOL_SETUP_INVALID_ARGUMENT",
          `Choose an existing actor: ${available.join(", ")}. Resume with firedrill serve --actor <id>.`,
        );
    }
  }
  return executeServeCommand(
    {
      root: input.root,
      json: input.json,
      ...(input.noOpen === undefined ? {} : { noOpen: input.noOpen }),
      ...(actorId === undefined ? {} : { actorId }),
    },
    io,
  );
}

/** Owns the setup dialogue; every write/execution has an equivalent explicit flag. */
export async function executeInitCommand(input: InitCommandInput, io: CliIo): Promise<number> {
  try {
    if (!input.json)
      io.stdout.write(
        "Firedrill runs stateful fake tools locally so your agent can act without touching production.\n",
      );
    if (input.initPath !== undefined) {
      const result = initProject(input.root, input.initPath);
      if (input.json) emit(io, { command: "init", ...result });
      else if (result.status === "initialized") initialized(io, result);
      if (input.initPath === "firedrill-agent") {
        let readyActorId: string | undefined;
        const code =
          input.initAllowAgent === true || (!input.json && io.ask !== undefined)
            ? await authorEnvironment(input, io, (id) => {
                readyActorId = id;
              })
            : 0;
        if (code !== 0) return code;
        if (input.initStart) return finish(input, io, readyActorId);
      } else if (input.initStart) return finish(input, io);
      return 0;
    }
    const discover = (query = "", offset = 0) =>
      discoverTools({
        root: input.root,
        query,
        offset,
        limit: 20,
        ...(input.toolIndex === undefined ? {} : { index: input.toolIndex }),
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      });
    let discovery = await discover(input.initSearch);
    const tools = discovery.tools;
    if (input.initSearch !== undefined) {
      if (input.json) emit(io, { ...discovery, command: "init", status: "catalog", accountRequired: false });
      else {
        catalog(io, tools);
        io.stdout.write(
          `Showing ${tools.length} of ${discovery.total}. Use firedrill tool search for pagination.\n`,
        );
      }
      return 0;
    }
    const selected = [...(input.initTool ?? [])];
    let custom = input.initCustom;
    let authoring = input.initAuthoring;
    if (selected.length === 0 && custom === undefined && (input.json || io.ask === undefined)) {
      emitOrInspect(input, io, tools);
      return 0;
    }
    if (selected.length === 0 && custom === undefined && io.ask !== undefined) {
      let visible = tools;
      let query = "";
      while (custom === undefined) {
        catalog(io, visible, selected.length === 0);
        if (discovery.total > discovery.limit)
          io.stdout.write(
            `Showing ${discovery.offset + 1}–${discovery.offset + visible.length} of ${discovery.total}; n: next page, p: previous page.\n`,
          );
        const answer = (
          await io.ask(
            selected.length === 0
              ? "Choose a Tool [c], package/Git/local source, or /search: "
              : "Choose another Tool, package/Git/local source, or /search (Enter to finish): ",
          )
        ).trim();
        const search = answer.startsWith("/") && !(isAbsolute(answer) && existsSync(answer));
        if (answer === "n" || answer === "p" || search) {
          let offset = discovery.offset;
          if (search) {
            query = answer.slice(1);
            offset = 0;
          } else if (answer === "n" && offset + discovery.limit < discovery.total) offset += discovery.limit;
          else if (answer === "p") offset = Math.max(0, offset - discovery.limit);
          discovery = await discover(query, offset);
          visible = discovery.tools;
          continue;
        }
        if (answer === "" && selected.length > 0) break;
        if (selected.length === 0 && (answer === "" || answer === "c" || answer === "custom")) {
          custom = (await io.ask("Name your custom Tool [my-tool]: ")).trim() || "my-tool";
        } else {
          selected.push(
            visible.find((_tool, index) => answer === String(index + 1))?.installSource ?? answer,
          );
          if (!yes(await io.ask("Add another ready-made Tool? [y/N] "))) break;
        }
      }
    }
    let setup: ToolSetupResult;
    if (selected.length > 0) {
      const packageNames: string[] = [];
      const packageSources = new Map<string, string>();
      const selections = await planToolSelections(input, selected, io.signal);
      for (const selection of selections) {
        const { selector, entry } = selection;
        let packageName = entry?.packageName ?? selector;
        if (entry !== undefined && !input.json) {
          io.stdout.write(`${entry.id}: ${entry.operations.map((item) => item.id).join(", ")}\n`);
          for (const limitation of entry.limitations) io.stdout.write(`Limit: ${limitation}\n`);
        }
        if (entry !== undefined && !entry.installed && input.toolIndex === undefined) {
          const install =
            input.initInstall === true ||
            (!input.json &&
              io.ask !== undefined &&
              yes(
                await io.ask(
                  `Install ${entry.packageName}@${entry.version} into this repository with lifecycle scripts disabled? Catalog entries may not be published yet. [y/N] `,
                ),
              ));
          const plan = toolInstallPlan(input.root, entry);
          const next = `firedrill init --tool ${entry.packageName} --install`;
          if (install && !input.json)
            io.stdout.write(
              `Installing ${entry.packageName}@${entry.version} with lifecycle scripts disabled…\n`,
            );
          if (!install || !(await installReadyTool(input.root, entry, io.signal))) {
            const code = io.signal?.aborted
              ? "framework.TOOL_INSTALL_CANCELLED"
              : install
                ? "framework.TOOL_INSTALL_FAILED"
                : "framework.TOOL_INSTALL_REQUIRED";
            const message = install
              ? "Tool installation did not complete. Check package availability and your package manager; pre-release catalog entries may require a locally packed archive. No fake replacement was selected."
              : "This Tool is not installed. Installation requires explicit permission; local custom Tools need no package download.";
            if (input.json)
              emit(io, {
                schemaVersion: 1,
                command: "init",
                status: "setup-pending",
                code,
                message,
                install: plan,
                next,
              });
            else
              io.stdout.write(
                `${message}\nInstall command: ${plan.executable} ${plan.arguments.join(" ")}\nResume: ${next}\n`,
              );
            return 2;
          }
        } else if (
          (input.toolIndex !== undefined && entry !== undefined && (input.initInstall || !entry.installed)) ||
          (entry === undefined &&
            inspectInstalledToolPackage({ repositoryRoot: input.root, packageName }).status !== "success")
        ) {
          const source = entry?.installSource ?? selector;
          const permitted =
            input.initInstall === true ||
            (!input.json &&
              io.ask !== undefined &&
              yes(
                await io.ask(
                  `Install ${source} with lifecycle scripts disabled? Review third-party Tool code before running it. [y/N] `,
                ),
              ));
          if (!permitted) {
            if (input.json)
              emit(io, {
                schemaVersion: 1,
                command: "init",
                status: "setup-pending",
                code: "framework.TOOL_INSTALL_REQUIRED",
                source,
                next: `firedrill init --tool ${sourceArgument(source)} --install`,
              });
            else
              io.stdout.write(
                `Installation was not authorized. Resume: firedrill init --tool ${sourceArgument(source)} --install\n`,
              );
            return 2;
          }
          const installed = await installToolSource({
            root: input.root,
            source,
            ...(io.signal === undefined ? {} : { signal: io.signal }),
          });
          const inspected = inspectInstalledToolPackage({
            repositoryRoot: input.root,
            packageName: installed.packageName,
          });
          if (
            entry !== undefined &&
            (installed.packageName !== entry.packageName ||
              installed.version !== entry.version ||
              inspected.status !== "success" ||
              inspected.declaration.manifest.id !== entry.id)
          )
            throw new ToolDiscoveryError(
              "framework.TOOL_INDEX_PACKAGE_MISMATCH",
              "The installed package does not match the selected index entry. Review the package and index; it was not selected in firedrill.json.",
            );
          packageName = installed.packageName;
          if (!input.json)
            io.stdout.write(
              `Installed ${packageName}@${installed.version}. Commit dependency manifests/locks and .firedrill-tools/ if created.\n`,
            );
        }
        const previousSource = packageSources.get(packageName);
        if (previousSource !== undefined && previousSource !== selection.sourceKey)
          selectionConflict(packageName, true);
        packageSources.set(packageName, selection.sourceKey);
        if (!packageNames.includes(packageName)) packageNames.push(packageName);
      }
      setup = addToolPackages({ root: input.root, packageNames });
    } else {
      setup = createTool({ root: input.root, id: custom ?? "my-tool" });
    }
    if (authoring === undefined && !input.json && io.ask !== undefined) {
      const answer = (
        await io.ask(
          "Customize the Tool yourself, with Firedrill Agent, or your coding agent? [manual/firedrill-agent/coding-agent; manual]: ",
        )
      ).trim();
      if (answer !== "" && !["manual", "firedrill-agent", "coding-agent"].includes(answer))
        throw new FiredrillToolSetupError(
          "framework.TOOL_SETUP_INVALID_ARGUMENT",
          "Choose manual, firedrill-agent, or coding-agent. The custom Tool was created and can be resumed with firedrill serve.",
        );
      authoring = answer === "" ? "manual" : (answer as NonNullable<InitCommandInput["initAuthoring"]>);
    }
    const compiled = await compileWorld({ repositoryRoot: input.root, materialize: false });
    if (compiled.status !== "success") {
      if (input.json)
        emit(io, {
          schemaVersion: 1,
          command: "init",
          status: "failed",
          code: "framework.INIT_VALIDATION_FAILED",
          setup,
          diagnostics: compiled.diagnostics,
        });
      else {
        io.stderr.write(
          "Tool source was written but the environment is not valid yet. Run firedrill validate --json and resolve its diagnostics.\n",
        );
        for (const diagnostic of compiled.diagnostics)
          io.stderr.write(`${diagnostic.code} ${diagnostic.message}\n`);
      }
      return 1;
    }
    if (input.json)
      emit(io, {
        schemaVersion: 1,
        command: "init",
        status: "initialized",
        path: selected.length === 0 ? "custom" : "tool",
        setup,
        sourceValidated: true,
        testsExecuted: false,
        next: ["firedrill serve"],
      });
    else {
      io.stdout.write(
        `Tool source validated: ${(setup.packageIds ?? [setup.packageId]).join(", ")}. No agent or tests ran.\n`,
      );
      for (const guidance of setup.grantGuidance) io.stdout.write(`${guidance}\n`);
      if (selected.length === 0)
        io.stdout.write(
          "The custom stateful starter supports get/set records. Edit its declaration and behavior to model your own system.\n",
        );
      else
        io.stdout.write(
          `The selected package supplies the local Tool behavior and ${setup.starterRows ?? 0} package-authored starter rows. Existing world state is preserved.\n`,
        );
    }
    let readyActorId: string | undefined;
    if (authoring !== undefined && authoring !== "manual") {
      const result = initProject(input.root, authoring);
      if (!input.json && result.status === "initialized") initialized(io, result);
      if (authoring === "firedrill-agent") {
        const code = await authorEnvironment(input, io, (id) => {
          readyActorId = id;
        });
        if (code !== 0) return code;
      }
    }
    return finish(input, io, readyActorId);
  } catch (error) {
    if (io.signal?.aborted) {
      if (input.json)
        emit(io, {
          schemaVersion: 1,
          command: "init",
          status: "cancelled",
          code: "framework.INIT_CANCELLED",
        });
      else io.stdout.write("Setup cancelled. Any completed local source changes remain available.\n");
      return 0;
    }
    if (error instanceof FiredrillToolInstallationError || error instanceof ToolDiscoveryError) {
      const suggestion = error instanceof FiredrillToolInstallationError ? error.suggestion : undefined;
      if (input.json)
        emit(io, {
          schemaVersion: 1,
          command: "init",
          status: "failed",
          code: error.code,
          message: error.message,
          ...(suggestion === undefined ? {} : { suggestion }),
        });
      else
        io.stderr.write(
          `${error.code} ${error.message}\n${suggestion === undefined ? "" : `${suggestion}\n`}`,
        );
      return 2;
    }
    if (!(error instanceof FiredrillInitError) && !(error instanceof FiredrillToolSetupError)) throw error;
    if (input.json)
      emit(io, {
        schemaVersion: 1,
        command: "init",
        status: "failed",
        code: error.code,
        message: error.message,
        paths: error.paths,
      });
    else {
      io.stderr.write(`${error.code} ${error.message}\n`);
      for (const path of error.paths) io.stderr.write(`  ${path}\n`);
    }
    return 2;
  }
}

function emitOrInspect(input: InitCommandInput, io: CliIo, tools: readonly ReadyTool[]): void {
  const inspection = initProject(input.root);
  if (input.json) emit(io, { command: "init", ...inspection, tools });
  else {
    catalog(io, tools);
    io.stdout.write(
      "Read-only inspection. Set up with firedrill init --tool <installed-package> or firedrill init --custom <tool-id>. Add --install to authorize a catalog package download; add --start to serve it.\n",
    );
  }
}
