import { join, resolve } from "node:path";
import type { ToolSourceSet } from "@firedrill-tools/compiler";
import { compileWorld } from "@firedrill-tools/compiler";
import type {
  Diagnostic,
  EvidenceEntry,
  OperationOutcome,
  PackageId,
  Sha256,
  StableId,
  ToolPackageManifest,
} from "@firedrill-tools/contracts";
import { compareStableStrings, PackageIdSchema } from "@firedrill-tools/contracts";
import type { CallbackReceiver } from "@firedrill-tools/drills";
import type { LoadedWorldBuild } from "@firedrill-tools/world-build";
import { loadWorldBuild } from "@firedrill-tools/world-build";
import { FiredrillProjectError } from "./project-error.js";
import type { AgentCallback, RunDrillsResult } from "./run-drills.js";
import { runDrills } from "./run-drills.js";
import { stagePackagedToolConformance } from "./tool-package-conformance.js";

export interface ToolInspection {
  readonly schemaVersion: 1;
  readonly repositoryRoot: string;
  /** Non-error diagnostics produced while compiling the selected Tool. */
  readonly diagnostics: readonly Diagnostic[];
  readonly toolId: PackageId;
  readonly sourcePath: string;
  /** Declaration, exact behavior dependency closure and optional browser assets. */
  readonly sourceFiles: readonly string[];
  /** Exact UI source closure in artifact.ui.assets order; empty for backend-only Tools. */
  readonly uiSourceFiles: readonly string[];
  readonly origin: ToolSourceSet["origin"];
  readonly buildHash: Sha256;
  readonly packageLockHash: Sha256;
  readonly artifact: {
    readonly manifestHash: Sha256;
    readonly artifactHash: Sha256;
    readonly artifactPath: string;
    readonly exportName: string;
    readonly moduleFormat: "esm";
    readonly ui?: NonNullable<LoadedWorldBuild["packageLock"]["packages"][number]["ui"]>;
  };
  readonly manifest: ToolPackageManifest;
}

export interface ToolValidation extends ToolInspection {
  readonly executable: true;
  readonly buildDirectory: string;
}

export interface InspectToolOptions {
  /** Consumer repository containing firedrill.json. Defaults to process.cwd(). */
  readonly root?: string;
  readonly toolId: string;
}

export interface TestToolOptions extends InspectToolOptions {
  /** Defaults to <tool-id>-conformance, or conformance for a one-Tool world. */
  readonly suite?: string;
  /** Used only when a conformance drill selects an external target. */
  readonly agent?: AgentCallback;
  /** First trial seed for both identical conformance passes. */
  readonly seed?: string;
  /** Defaults to <root>/.firedrill/tool-tests/<tool-id>. */
  readonly testDirectory?: string;
  readonly allowRemoteHttp?: boolean;
  /** Runtime-local endpoints used by conformance drills that exercise callbacks. */
  readonly callbackReceivers?: Readonly<Record<string, CallbackReceiver>>;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export type ToolConformanceViolationCode =
  | "CALLBACK_UNCOVERED"
  | "DECLARED_ERROR_UNCOVERED"
  | "DRILL_RUN_FAILED"
  | "EVENT_UNCOVERED"
  | "FAULT_UNCOVERED"
  | "NONDETERMINISTIC_RESULT"
  | "OPERATION_SUCCESS_UNCOVERED"
  | "OPERATION_UNCOVERED"
  | "SUBSCRIPTION_UNCOVERED";

export interface ToolConformanceViolation {
  readonly code: ToolConformanceViolationCode;
  readonly message: string;
  readonly subject?: string;
  readonly drillId?: StableId;
  readonly trial?: number;
  readonly difference?:
    | "missing_repeat"
    | "seed"
    | "status"
    | "state"
    | "trajectory"
    | "state_and_trajectory";
}

export interface ToolOperationCoverage {
  readonly operationId: string;
  readonly attempts: number;
  readonly statuses: Readonly<Record<OperationOutcome["status"], number>>;
  readonly declaredErrors: readonly {
    readonly code: string;
    readonly observations: number;
  }[];
}

export interface ToolEventCoverage {
  readonly eventId: string;
  readonly emitted: number;
  readonly scheduled: number;
  readonly handled: number;
  readonly failed: number;
}

export interface ToolFaultCoverage {
  readonly faultId: string;
  readonly activations: number;
}

export interface ToolSubscriptionCoverage {
  readonly subscriptionId: string;
  readonly deliveries: number;
  readonly failures: number;
}

export interface ToolCallbackCoverage {
  readonly callbackId: string;
  readonly queued: number;
  readonly delivered: number;
  readonly retryScheduled: number;
  readonly failed: number;
}

export interface ToolConformanceResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly tool: ToolValidation;
  readonly suiteId: StableId;
  /** Whether the consumer supplied the suite or the installed package shipped it. */
  readonly suiteSource: "repository" | "package";
  readonly coverage: {
    readonly operations: readonly ToolOperationCoverage[];
    readonly events: readonly ToolEventCoverage[];
    readonly faults: readonly ToolFaultCoverage[];
    readonly subscriptions: readonly ToolSubscriptionCoverage[];
    readonly callbacks: readonly ToolCallbackCoverage[];
    readonly changedStateNamespaces: readonly string[];
  };
  readonly deterministic: boolean;
  readonly violations: readonly ToolConformanceViolation[];
  /** Two complete ordinary drill runs, including verified local report paths. */
  readonly runs: readonly [RunDrillsResult, RunDrillsResult];
}

interface PreparedTool {
  readonly root: string;
  readonly inspection: ToolInspection;
  readonly loaded: LoadedWorldBuild;
}

function parsedToolId(value: string): PackageId {
  const parsed = PackageIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new FiredrillProjectError("framework.INVALID_ARGUMENT", "tool id must be a valid Firedrill id");
  }
  return parsed.data;
}

function inspectionFromBuild(
  root: string,
  toolId: PackageId,
  build: Awaited<ReturnType<typeof compileWorld>> & { readonly status: "success" },
): ToolInspection {
  const manifest = build.build.worldIr.tools.find((candidate) => candidate.id === toolId);
  if (manifest === undefined) {
    throw new FiredrillProjectError("framework.TOOL_NOT_FOUND", `no Tool named ${toolId} exists`, {
      details: { requested: toolId, available: build.build.worldIr.tools.map((tool) => tool.id) },
    });
  }
  const provenance = build.build.sourceProvenance.find(
    (candidate) => candidate.kind === "tool" && candidate.id === toolId,
  );
  const lock = build.build.packageLock.packages.find((candidate) => candidate.packageId === toolId);
  const sourceSet = build.build.toolSources.find((candidate) => candidate.packageId === toolId);
  if (provenance === undefined || lock === undefined || sourceSet === undefined) {
    throw new FiredrillProjectError(
      "framework.BUILD_INVALID",
      `the compiler omitted provenance or a package lock for Tool ${toolId}`,
    );
  }
  return {
    schemaVersion: 1,
    repositoryRoot: root,
    diagnostics: build.diagnostics,
    toolId,
    sourcePath: provenance.sourcePath,
    sourceFiles: [
      sourceSet.declarationPath,
      ...sourceSet.behaviorPaths.filter((path) => path !== sourceSet.declarationPath),
      ...(sourceSet.uiPaths ?? []),
    ],
    uiSourceFiles: sourceSet.uiPaths ?? [],
    origin: sourceSet.origin,
    buildHash: build.build.manifest.buildHash,
    packageLockHash: build.build.manifest.packageLockHash,
    artifact: {
      manifestHash: lock.manifestHash,
      artifactHash: lock.artifactHash,
      artifactPath: lock.artifactPath,
      exportName: lock.exportName,
      moduleFormat: lock.moduleFormat,
      ...(lock.ui === undefined ? {} : { ui: lock.ui }),
    },
    manifest,
  };
}

async function compiledTool(
  options: InspectToolOptions,
  materialize: boolean,
): Promise<{
  readonly root: string;
  readonly inspection: ToolInspection;
  readonly buildDirectory?: string;
}> {
  const root = resolve(options.root ?? process.cwd());
  const toolId = parsedToolId(options.toolId);
  const compiled = await compileWorld({ repositoryRoot: root, materialize });
  if (compiled.status === "failed") {
    throw new FiredrillProjectError("framework.SOURCE_INVALID", "Firedrill source is invalid", {
      diagnostics: compiled.diagnostics,
    });
  }
  return {
    root,
    inspection: inspectionFromBuild(root, toolId, compiled),
    ...(compiled.build.buildDirectory === undefined ? {} : { buildDirectory: compiled.build.buildDirectory }),
  };
}

async function preparedTool(options: InspectToolOptions): Promise<PreparedTool> {
  const compiled = await compiledTool(options, true);
  if (compiled.buildDirectory === undefined) {
    throw new FiredrillProjectError("framework.BUILD_INVALID", "the compiler produced no executable build");
  }
  const loaded = await loadWorldBuild(compiled.buildDirectory);
  if (loaded.status === "failed") {
    throw new FiredrillProjectError(
      "framework.BUILD_INVALID",
      `Tool ${compiled.inspection.toolId} could not be loaded as executable behavior`,
      { diagnostics: loaded.diagnostics },
    );
  }
  return { root: compiled.root, inspection: compiled.inspection, loaded: loaded.build };
}

/**
 * Inspects the normalized, content-addressed contract without importing customer behavior.
 */
export async function inspectTool(options: InspectToolOptions): Promise<ToolInspection> {
  return (await compiledTool(options, false)).inspection;
}

/**
 * Materializes and imports one Tool, proving its export and exact handler surface load successfully.
 * Tool modules are trusted local code; call this only for a repository the caller trusts.
 */
export async function validateTool(options: InspectToolOptions): Promise<ToolValidation> {
  const prepared = await preparedTool(options);
  return {
    ...prepared.inspection,
    executable: true,
    buildDirectory: prepared.loaded.directory,
  };
}

function resolveSuite(build: LoadedWorldBuild, toolId: PackageId, requested?: string): StableId {
  if (requested !== undefined) {
    const suite = build.worldIr.suites.find((candidate) => candidate.id === requested);
    if (suite !== undefined) return suite.id;
    throw new FiredrillProjectError("framework.SUITE_NOT_FOUND", `no suite named ${requested} exists`, {
      details: { requested, available: build.worldIr.suites.map((suite_) => suite_.id) },
    });
  }
  const conventional = `${toolId}-conformance`;
  const selected = build.worldIr.suites.find(
    (candidate) =>
      candidate.id === conventional || (build.worldIr.tools.length === 1 && candidate.id === "conformance"),
  );
  if (selected !== undefined) return selected.id;
  throw new FiredrillProjectError(
    "framework.TOOL_CONFORMANCE_SUITE_REQUIRED",
    `Tool ${toolId} needs a conformance suite`,
    {
      details: {
        ...(conventional.length <= 96 ? { expected: conventional } : {}),
        available: build.worldIr.suites.map((suite) => suite.id),
        suggestion: "add a repository-owned drill suite or pass --suite <id>",
      },
    },
  );
}

function finalEvidence(run: RunDrillsResult): readonly EvidenceEntry[] {
  return run.drills.flatMap((drill) => drill.trials.flatMap((trial) => trial.evidence));
}

function outcomeCounts(entries: readonly EvidenceEntry[], toolId: PackageId, operationId: string) {
  const statuses: Record<OperationOutcome["status"], number> = {
    ok: 0,
    denied: 0,
    tool_error: 0,
    unsupported: 0,
    invalid: 0,
  };
  const operations = entries.filter(
    (entry) =>
      entry.kind === "operation" &&
      entry.invocation.operation.packageId === toolId &&
      entry.invocation.operation.operationId === operationId,
  );
  for (const entry of operations) {
    if (entry.kind === "operation") statuses[entry.outcome.status] += 1;
  }
  return { operations, statuses };
}

function collectCoverage(
  manifest: ToolPackageManifest,
  entries: readonly EvidenceEntry[],
): ToolConformanceResult["coverage"] {
  const operations = manifest.operations.map((contract): ToolOperationCoverage => {
    const observed = outcomeCounts(entries, manifest.id, contract.id);
    return {
      operationId: contract.id,
      attempts: observed.operations.length,
      statuses: observed.statuses,
      declaredErrors: contract.declaredErrors.map((code) => ({
        code,
        observations: observed.operations.filter(
          (entry) => entry.kind === "operation" && entry.outcome.error?.code === `tool.${code}`,
        ).length,
      })),
    };
  });
  const events = manifest.events.map((contract): ToolEventCoverage => {
    const observed = entries.filter(
      (entry) =>
        entry.kind === "event" &&
        entry.event.packageId === manifest.id &&
        entry.event.eventId === contract.id,
    );
    return {
      eventId: contract.id,
      emitted: observed.filter((entry) => entry.kind === "event" && entry.phase === "emitted").length,
      scheduled: observed.filter((entry) => entry.kind === "event" && entry.phase === "scheduled").length,
      handled: observed.filter((entry) => entry.kind === "event" && entry.phase === "handled").length,
      failed: observed.filter((entry) => entry.kind === "event" && entry.phase === "failed").length,
    };
  });
  const faults = manifest.faults.map(
    (contract): ToolFaultCoverage => ({
      faultId: contract.id,
      activations: entries.filter(
        (entry) => entry.kind === "fault" && entry.packageId === manifest.id && entry.faultId === contract.id,
      ).length,
    }),
  );
  const subscriptions = manifest.subscriptions.map(
    (contract): ToolSubscriptionCoverage => ({
      subscriptionId: contract.id,
      deliveries: entries.filter(
        (entry) =>
          entry.kind === "event" &&
          entry.handlerPackageId === manifest.id &&
          entry.subscriptionId === contract.id &&
          entry.phase === "handled",
      ).length,
      failures: entries.filter(
        (entry) =>
          entry.kind === "event" &&
          entry.handlerPackageId === manifest.id &&
          entry.subscriptionId === contract.id &&
          entry.phase === "failed",
      ).length,
    }),
  );
  const callbacks = manifest.callbacks.map((contract): ToolCallbackCoverage => {
    const observed = entries.filter(
      (entry) =>
        entry.kind === "callback" &&
        entry.callback.packageId === manifest.id &&
        entry.callback.callbackId === contract.id,
    );
    return {
      callbackId: contract.id,
      queued: observed.filter((entry) => entry.kind === "callback" && entry.phase === "queued").length,
      delivered: observed.filter((entry) => entry.kind === "callback" && entry.phase === "delivered").length,
      retryScheduled: observed.filter(
        (entry) => entry.kind === "callback" && entry.phase === "retry_scheduled",
      ).length,
      failed: observed.filter((entry) => entry.kind === "callback" && entry.phase === "failed").length,
    };
  });
  const changedStateNamespaces = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === "state_change" && entry.packageId === manifest.id ? [entry.namespace] : [],
      ),
    ),
  ].sort(compareStableStrings);
  return { operations, events, faults, subscriptions, callbacks, changedStateNamespaces };
}

function coverageViolations(coverage: ToolConformanceResult["coverage"]): ToolConformanceViolation[] {
  const violations: ToolConformanceViolation[] = [];
  for (const operation of coverage.operations) {
    if (operation.attempts === 0) {
      violations.push({
        code: "OPERATION_UNCOVERED",
        subject: operation.operationId,
        message: `operation ${operation.operationId} was never called`,
      });
    } else if (operation.statuses.ok === 0) {
      violations.push({
        code: "OPERATION_SUCCESS_UNCOVERED",
        subject: operation.operationId,
        message: `operation ${operation.operationId} has no successful call`,
      });
    }
    for (const error of operation.declaredErrors) {
      if (error.observations === 0) {
        violations.push({
          code: "DECLARED_ERROR_UNCOVERED",
          subject: `${operation.operationId}:${error.code}`,
          message: `declared error ${error.code} for ${operation.operationId} was never observed`,
        });
      }
    }
  }
  for (const event of coverage.events) {
    if (event.emitted + event.scheduled + event.handled + event.failed === 0) {
      violations.push({
        code: "EVENT_UNCOVERED",
        subject: event.eventId,
        message: `event ${event.eventId} was never observed`,
      });
    }
  }
  for (const fault of coverage.faults) {
    if (fault.activations === 0) {
      violations.push({
        code: "FAULT_UNCOVERED",
        subject: fault.faultId,
        message: `fault ${fault.faultId} was never activated`,
      });
    }
  }
  for (const subscription of coverage.subscriptions) {
    if (subscription.deliveries + subscription.failures === 0) {
      violations.push({
        code: "SUBSCRIPTION_UNCOVERED",
        subject: subscription.subscriptionId,
        message: `subscription ${subscription.subscriptionId} never received an event`,
      });
    }
  }
  for (const callback of coverage.callbacks) {
    if (callback.delivered === 0) {
      violations.push({
        code: "CALLBACK_UNCOVERED",
        subject: callback.callbackId,
        message: `callback ${callback.callbackId} was never delivered successfully`,
      });
    }
  }
  return violations;
}

function determinismViolations(first: RunDrillsResult, second: RunDrillsResult): ToolConformanceViolation[] {
  const violations: ToolConformanceViolation[] = [];
  const repeat = new Map(
    second.drills.flatMap((drill) =>
      drill.trials.map((trial) => [`${drill.drillId}\u0000${trial.trial}`, trial] as const),
    ),
  );
  for (const drill of first.drills) {
    for (const trial of drill.trials) {
      const other = repeat.get(`${drill.drillId}\u0000${trial.trial}`);
      const same =
        other !== undefined &&
        other.seed === trial.seed &&
        other.result.status === "sealed" &&
        trial.result.status === "sealed" &&
        other.result.stateHash === trial.result.stateHash &&
        other.result.trajectoryHash === trial.result.trajectoryHash;
      if (!same) {
        const difference =
          other === undefined
            ? ("missing_repeat" as const)
            : other.seed !== trial.seed
              ? ("seed" as const)
              : other.result.status !== "sealed" || trial.result.status !== "sealed"
                ? ("status" as const)
                : other.result.stateHash !== trial.result.stateHash &&
                    other.result.trajectoryHash !== trial.result.trajectoryHash
                  ? ("state_and_trajectory" as const)
                  : other.result.stateHash !== trial.result.stateHash
                    ? ("state" as const)
                    : ("trajectory" as const);
        const explanation =
          difference === "trajectory"
            ? "world state reproduced, but the trajectory differed; inspect target output and operation/event evidence for runtime IDs, timestamps, random values, or unstable ordering"
            : difference === "state"
              ? "the final world state differed even though the trajectory hash matched"
              : difference === "state_and_trajectory"
                ? "both final world state and trajectory differed"
                : difference === "seed"
                  ? "the repeat did not use the same seed"
                  : difference === "status"
                    ? "one pass did not seal successfully"
                    : "the corresponding repeat trial is missing";
        violations.push({
          code: "NONDETERMINISTIC_RESULT",
          drillId: drill.drillId,
          trial: trial.trial,
          difference,
          message: `drill ${drill.drillId} trial ${trial.trial} did not reproduce with the same seed: ${explanation}`,
        });
      }
    }
  }
  return violations;
}

function drillFailure(run: RunDrillsResult, pass: "first" | "repeat"): ToolConformanceViolation[] {
  if (run.verdict === "passed") return [];
  return [
    {
      code: "DRILL_RUN_FAILED",
      message: `${pass} conformance pass finished ${run.verdict}`,
    },
  ];
}

/**
 * Runs an ordinary repository-owned drill suite twice against one immutable build.
 * Conformance requires passing drills, reproducible hashes, and observed declared behavior.
 */
export async function testTool(options: TestToolOptions): Promise<ToolConformanceResult> {
  let prepared = await preparedTool(options);
  const originalInspection = prepared.inspection;
  const output = resolve(
    prepared.root,
    options.testDirectory ?? join(".firedrill", "tool-tests", prepared.inspection.toolId),
  );
  let suiteSource: ToolConformanceResult["suiteSource"] = "repository";
  let selectedSuite = options.suite;
  if (
    selectedSuite === undefined &&
    !prepared.loaded.worldIr.suites.some(
      (suite) =>
        suite.id === `${prepared.inspection.toolId}-conformance` ||
        (prepared.loaded.worldIr.tools.length === 1 && suite.id === "conformance"),
    )
  ) {
    const packaged = await stagePackagedToolConformance({
      root: prepared.root,
      output,
      tool: prepared.inspection,
    });
    if (packaged !== undefined) {
      prepared = await preparedTool({ root: packaged.root, toolId: options.toolId });
      selectedSuite = packaged.suite;
      suiteSource = "package";
    }
  }
  const suiteId = resolveSuite(prepared.loaded, prepared.inspection.toolId, selectedSuite);
  const run = () =>
    runDrills({
      root: prepared.root,
      suite: suiteId,
      buildHash: prepared.inspection.buildHash,
      runDirectory: join(output, "runs"),
      reportDirectory: join(output, "reports"),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.allowRemoteHttp === undefined ? {} : { allowRemoteHttp: options.allowRemoteHttp }),
      ...(options.callbackReceivers === undefined ? {} : { callbackReceivers: options.callbackReceivers }),
      ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const first = await run();
  const second = await run();
  const coverage = collectCoverage(prepared.inspection.manifest, finalEvidence(first));
  const violations = [
    ...drillFailure(first, "first"),
    ...drillFailure(second, "repeat"),
    ...determinismViolations(first, second),
    ...coverageViolations(coverage),
  ];
  return {
    schemaVersion: 1,
    status: violations.length === 0 ? "passed" : "failed",
    tool: {
      ...prepared.inspection,
      ...(suiteSource === "package" ? { origin: originalInspection.origin } : {}),
      executable: true,
      buildDirectory: prepared.loaded.directory,
    },
    suiteId,
    suiteSource,
    coverage,
    deterministic: !violations.some((violation) => violation.code === "NONDETERMINISTIC_RESULT"),
    violations,
    runs: [first, second],
  };
}
