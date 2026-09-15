import type {
  SimulationEvidencePage,
  SimulationProject,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunRequestList,
  SimulationRunSummary,
  SimulationSourceDocument,
  SimulationSourceKind,
  SimulationStatePage,
  SimulationToolSourceDocument,
  StartSimulationRun,
} from "@firedrill/simulation";

export type {
  SimulationEvidencePage,
  SimulationProject,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunRequestList,
  SimulationRunSummary,
  SimulationSourceDocument,
  SimulationSourceKind,
  SimulationStatePage,
  SimulationToolSourceDocument,
  StartSimulationRun,
};

export type SimulationTool = SimulationProject["tools"][number];
export type SimulationScenario = SimulationProject["scenarios"][number];
export type SimulationSetup = SimulationProject["world"]["baseline"];
export type SimulationDrill = SimulationProject["drills"][number];
export type SimulationSuite = SimulationProject["suites"][number];
export type SimulationTarget = SimulationProject["targets"][number];
export type EvidenceEntry = SimulationEvidencePage["entries"][number];
export type StateNamespace = SimulationRunDetail["stateNamespaces"][number];
export type Route =
  | "/browser-tests"
  | "/world"
  | "/schema"
  | "/data"
  | "/personas"
  | "/scenarios"
  | "/tools"
  | "/environment"
  | "/connect"
  | "/drills"
  | "/runs";

export interface Notice {
  readonly id: number;
  readonly tone: "success" | "warning" | "danger" | "info";
  readonly message: string;
}
