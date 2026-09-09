import type { EvidenceEntry, SimulationTool } from "./types";

export interface EnvironmentTool {
  readonly packageId: string;
  readonly version: string;
  readonly operations: readonly string[];
  readonly operationContracts: SimulationTool["operations"];
  readonly stateNamespaces: readonly string[];
}
export interface EnvironmentConnection {
  readonly protocol: "http" | "mcp" | "cli";
  readonly url: string;
  readonly actorId: string;
}
export type EnvironmentStatus =
  | { readonly schemaVersion: 1; readonly available: false }
  | {
      readonly schemaVersion: 1;
      readonly available: true;
      readonly metadata: {
        readonly worldInstanceId: string;
        readonly buildHash: string;
        readonly seed: string;
        readonly virtualTimeUs: number;
      };
      readonly description: {
        readonly generation: number;
        readonly worldId: string;
        readonly buildHash: string;
        readonly scenarioId?: string;
        readonly drillId?: string;
        readonly tools: readonly EnvironmentTool[];
        readonly actors: readonly {
          readonly actorId: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly grants: readonly { readonly packageId: string; readonly operationId: string }[];
        }[];
      };
      readonly connections: readonly EnvironmentConnection[];
      readonly agentTested: false;
      readonly source: "live_environment";
    };
export type RunningEnvironment = Extract<EnvironmentStatus, { available: true }>;
export interface EnvironmentStatePage {
  readonly generation: number;
  readonly worldInstanceId: string;
  readonly packageId: string;
  readonly namespace: string;
  readonly records: readonly { readonly rowId: string; readonly value: Readonly<Record<string, unknown>> }[];
  readonly nextRowId?: string;
}
export interface EnvironmentActivityPage {
  readonly generation: number;
  readonly worldInstanceId: string;
  readonly fromSequence: number;
  readonly entries: readonly (EvidenceEntry & { readonly initiator: "operator" | "binding" | "world" })[];
  readonly nextSequence: number;
}
export interface EnvironmentCall {
  readonly actorId: string;
  readonly packageId: string;
  readonly operationId: string;
  readonly arguments: Record<string, unknown>;
  readonly idempotencyKey?: string;
}
export interface EnvironmentCallResult {
  readonly worldInstanceId: string;
  readonly result: {
    readonly invocation: unknown;
    readonly outcome: { readonly status: string; readonly value?: unknown; readonly error?: unknown };
    readonly evidence: readonly EvidenceEntry[];
  };
  readonly agentTested: false;
}
export interface EnvironmentConnections {
  readonly worldInstanceId: string;
  readonly connections: readonly (EnvironmentConnection & { readonly token: string })[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface EnvironmentScenarioPreview {
  readonly worldInstanceId: string;
  readonly generation: number;
  readonly sourceHash: string;
  readonly scenario: Readonly<Record<string, unknown>>;
  readonly recordCount: number;
  readonly deletionCount: number;
  readonly containsSensitiveValues: boolean;
}

export interface EnvironmentScenarioSaved {
  readonly id: string;
  readonly path: string;
  readonly runtimeChanged: false;
}
