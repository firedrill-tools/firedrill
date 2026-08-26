import { resolve } from "node:path";
import { compileWorld } from "@firedrill/compiler";
import type { Diagnostic, Sha256 } from "@firedrill/contracts";
import { FiredrillProjectError } from "@firedrill/sdk";
import type { SimulationProject } from "./contracts.js";
import { SimulationProjectSchema } from "./contracts.js";

export interface LoadSimulationProjectOptions {
  readonly root?: string;
  /** External targets are runnable only when their owner supplies the callback. */
  readonly externalAgentAvailable?: boolean;
}

export interface LoadedSimulationProject {
  readonly repositoryRoot: string;
  readonly buildHash: Sha256;
  readonly diagnostics: readonly Diagnostic[];
  readonly project: SimulationProject;
}

/** Compiles repository source and produces the stable World/Drill catalog consumed by inspectors. */
export async function loadSimulationProject(
  options: LoadSimulationProjectOptions = {},
): Promise<LoadedSimulationProject> {
  const repositoryRoot = resolve(options.root ?? process.cwd());
  const compiled = await compileWorld({ repositoryRoot, materialize: true });
  if (compiled.status === "failed") {
    throw new FiredrillProjectError(
      "framework.SOURCE_INVALID",
      "Firedrill source is invalid; fix the reported diagnostics before starting the inspector",
      { diagnostics: compiled.diagnostics },
    );
  }
  const source = new Map(
    compiled.build.sourceProvenance.map((item) => [
      `${item.kind}:${item.id}`,
      { path: item.sourcePath, contentHash: item.contentHash },
    ]),
  );
  const targetKinds = new Map(compiled.build.worldIr.targets.map((target) => [target.id, target.kind]));
  const project = SimulationProjectSchema.parse({
    schemaVersion: 1,
    world: {
      id: compiled.build.worldIr.world.id,
      ...(compiled.build.worldIr.world.title === undefined
        ? {}
        : { title: compiled.build.worldIr.world.title }),
      seed: compiled.build.worldIr.world.seed,
      buildHash: compiled.build.manifest.buildHash,
      packageLockHash: compiled.build.manifest.packageLockHash,
      ...(source.get(`world:${compiled.build.worldIr.world.id}`) === undefined
        ? {}
        : { source: source.get(`world:${compiled.build.worldIr.world.id}`) }),
    },
    tools: compiled.build.worldIr.tools.map((tool) => ({
      id: tool.id,
      version: tool.version,
      operations: tool.operations.map((operation) => ({
        id: operation.id,
        ...(operation.description === undefined ? {} : { description: operation.description }),
        fidelity: operation.fidelity,
        idempotency: operation.idempotency,
      })),
      stateNamespaces: tool.state.map((state) => state.namespace),
      events: tool.events.map((event) => event.id),
      faults: tool.faults.map((fault) => fault.id),
      httpRoutes: tool.http.map((route) => ({
        id: route.id,
        operationId: route.operationId,
        method: route.method,
        path: route.path,
      })),
      ...(source.get(`tool:${tool.id}`) === undefined ? {} : { source: source.get(`tool:${tool.id}`) }),
    })),
    targets: compiled.build.worldIr.targets.map((target) => ({
      id: target.id,
      kind: target.kind,
      bindings: [...target.bindings],
      runAvailability:
        target.kind !== "external" || options.externalAgentAvailable === true
          ? "ready"
          : "agent_callback_required",
      ...(source.get(`target:${target.id}`) === undefined
        ? {}
        : { source: source.get(`target:${target.id}`) }),
    })),
    drills: compiled.build.worldIr.drills.map((drill) => ({
      id: drill.id,
      ...(drill.title === undefined ? {} : { title: drill.title }),
      tags: [...drill.tags],
      targetId: drill.targetId,
      ...(drill.scenarioId === undefined ? {} : { scenarioId: drill.scenarioId }),
      inlineScenario: drill.inlineScenario !== undefined,
      trials: drill.trials,
      timeline: {
        interactions: drill.timeline.interactions.length,
        workloads: drill.timeline.workloads.length,
        horizonUs: drill.timeline.horizonUs,
        maxToolCalls: drill.timeline.maxToolCalls,
        maxEvents: drill.timeline.maxEvents,
      },
      assertions: drill.assertions.length + drill.timeline.invariants.length,
      expectations: [
        ...drill.timeline.invariants.map((assertion) => ({
          id: assertion.id,
          kind: assertion.kind,
          gate: assertion.gate,
          checkpoint: "invariant" as const,
        })),
        ...drill.assertions.map((assertion) => ({
          id: assertion.id,
          kind: assertion.kind,
          gate: assertion.gate,
          checkpoint: "final" as const,
        })),
      ],
      ...(source.get(`drill:${drill.id}`) === undefined ? {} : { source: source.get(`drill:${drill.id}`) }),
    })),
    suites: compiled.build.worldIr.suites.map((suite) => ({
      id: suite.id,
      ...(suite.title === undefined ? {} : { title: suite.title }),
      drills: [...suite.drills],
      tags: [...suite.tags],
      ...(suite.trials === undefined ? {} : { trials: suite.trials }),
      concurrency: suite.concurrency,
      retries: suite.retries,
      ...(source.get(`suite:${suite.id}`) === undefined ? {} : { source: source.get(`suite:${suite.id}`) }),
    })),
    diagnostics: compiled.diagnostics,
  });

  for (const drill of project.drills) {
    if (!targetKinds.has(drill.targetId)) {
      throw new FiredrillProjectError(
        "framework.BUILD_INVALID",
        `drill ${drill.id} references unavailable target ${drill.targetId}`,
      );
    }
  }
  return {
    repositoryRoot,
    buildHash: compiled.build.manifest.buildHash,
    diagnostics: compiled.diagnostics,
    project,
  };
}
