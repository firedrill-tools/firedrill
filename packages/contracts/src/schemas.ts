import { AssertionDefinitionSchema, AssertionResultSchema } from "./assertions.js";
import { DiagnosticSchema } from "./diagnostics.js";
import { DrillDefinitionSchema } from "./drill.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import { EvidenceEntrySchema, EvidencePageSchema } from "./evidence.js";
import { OperationInvocationSchema, OperationOutcomeSchema, ToolPackageManifestSchema } from "./operation.js";
import { EvidenceBundleManifestSchema } from "./report.js";
import { RunProgressSchema, RunResultSchema } from "./run.js";
import { ScenarioDefinitionSchema } from "./scenario.js";
import { DrillSuiteDefinitionSchema } from "./suite.js";
import { TargetDescriptorSchema, TargetInvocationSchema, TargetResultSchema } from "./target.js";

export const ContractSchemas = {
  assertionDefinition: AssertionDefinitionSchema,
  assertionResult: AssertionResultSchema,
  diagnostic: DiagnosticSchema,
  drillDefinition: DrillDefinitionSchema,
  errorEnvelope: ErrorEnvelopeSchema,
  evidenceBundleManifest: EvidenceBundleManifestSchema,
  evidenceEntry: EvidenceEntrySchema,
  evidencePage: EvidencePageSchema,
  operationInvocation: OperationInvocationSchema,
  operationOutcome: OperationOutcomeSchema,
  runProgress: RunProgressSchema,
  runResult: RunResultSchema,
  scenarioDefinition: ScenarioDefinitionSchema,
  drillSuiteDefinition: DrillSuiteDefinitionSchema,
  targetDescriptor: TargetDescriptorSchema,
  targetInvocation: TargetInvocationSchema,
  targetResult: TargetResultSchema,
  toolPackageManifest: ToolPackageManifestSchema,
} as const;

export type ContractSchemaName = keyof typeof ContractSchemas;
