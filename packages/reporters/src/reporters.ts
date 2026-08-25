import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AssertionResult,
  EvidenceBundleManifest,
  EvidenceEntry,
  ReportArtifact,
  ReportRedaction,
  RunResult,
  ToolPackageManifest,
} from "@firedrill/contracts";
import {
  canonicalJson,
  EvidenceBundleManifestSchema,
  EvidenceEntrySchema,
  JsonValueSchema,
  RunResultSchema,
  ToolPackageManifestSchema,
} from "@firedrill/contracts";
import { trajectoryHash } from "@firedrill/world-ir";

export interface LocalReportInput {
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  /** Tool schemas add declared sensitive fields to the conservative built-in redaction policy. */
  readonly tools?: readonly ToolPackageManifest[];
}

interface CheckedLocalReport {
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  readonly sourceRunResultHash: string;
  readonly sourceEvidenceHash: string;
  readonly redaction: ReportRedaction;
}

export interface WrittenLocalReport {
  readonly directory: string;
  readonly manifest: EvidenceBundleManifest;
  readonly files: {
    readonly manifest: string;
    readonly run: string;
    readonly evidence: string;
    readonly json: string;
    readonly terminal: string;
    readonly junit: string;
    readonly html: string;
  };
}

export interface VerifiedLocalReport {
  readonly directory: string;
  readonly manifest: EvidenceBundleManifest;
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
}

export type LocalReportVerificationErrorCode =
  | "reporter.MANIFEST_INVALID"
  | "reporter.BUNDLE_CONTENT_MISMATCH"
  | "reporter.BUNDLE_LIMIT_EXCEEDED"
  | "reporter.ARTIFACT_MISMATCH"
  | "reporter.REPORT_INVALID"
  | "reporter.SOURCE_HASH_MISMATCH";

export class LocalReportVerificationError extends Error {
  readonly code: LocalReportVerificationErrorCode;

  constructor(code: LocalReportVerificationErrorCode, message: string) {
    super(message);
    this.name = "LocalReportVerificationError";
    this.code = code;
  }
}

const MAX_BUNDLE_ENTRIES = 1_024;
const MAX_BUNDLE_DEPTH = 32;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function semanticHash(value: unknown): `sha256:${string}` {
  const json = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
  return sha256(canonicalJson(json));
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sensitiveKey(name: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(name)) return true;
  const segments = name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (
    segments.some((segment) =>
      ["authorization", "cookie", "credential", "passwd", "password", "secret", "token"].includes(segment),
    )
  ) {
    return true;
  }
  return [
    ["api", "key"],
    ["access", "key"],
    ["private", "key"],
    ["client", "secret"],
  ].some(([left, right]) => segments.includes(left ?? "") && segments.includes(right ?? ""));
}

function collectDeclaredSensitiveNames(schema: unknown, names: Set<string>): void {
  if (!objectValue(schema)) return;
  const properties = schema.properties;
  if (objectValue(properties)) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (
        objectValue(propertySchema) &&
        (propertySchema.writeOnly === true ||
          propertySchema["x-firedrill-sensitive"] === true ||
          propertySchema.format === "password")
      ) {
        names.add(name);
      }
      collectDeclaredSensitiveNames(propertySchema, names);
    }
  }
  for (const keyword of [
    "items",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
  ]) {
    const child = schema[keyword];
    if (Array.isArray(child)) {
      for (const item of child) collectDeclaredSensitiveNames(item, names);
    } else {
      collectDeclaredSensitiveNames(child, names);
    }
  }
}

function sensitiveNames(tools: readonly ToolPackageManifest[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    for (const operation of tool.operations) {
      collectDeclaredSensitiveNames(operation.inputSchema, names);
      collectDeclaredSensitiveNames(operation.outputSchema, names);
    }
    for (const state of tool.state) collectDeclaredSensitiveNames(state.schema, names);
    for (const event of tool.events) collectDeclaredSensitiveNames(event.payloadSchema, names);
  }
  return names;
}

function collectStrings(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0 && value !== "[REDACTED]") result.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
    return;
  }
  if (objectValue(value)) {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
}

function collectSensitiveStrings(value: unknown, names: ReadonlySet<string>, secrets: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, names, secrets);
    return;
  }
  if (!objectValue(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey(key, names)) collectStrings(item, secrets);
    else collectSensitiveStrings(item, names, secrets);
  }
}

function redactReportValues(
  result: RunResult,
  evidence: readonly EvidenceEntry[],
  tools: readonly ToolPackageManifest[],
): {
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  readonly summary: ReportRedaction;
} {
  const names = sensitiveNames(tools);
  const secrets = new Set<string>();
  collectSensitiveStrings(result, names, secrets);
  collectSensitiveStrings(evidence, names, secrets);
  const propagatedSecrets = [...secrets]
    .filter((secret) => secret.length >= 8)
    .sort((a, b) => b.length - a.length);
  let replacements = 0;

  const payloadKeys = new Set([
    "actual",
    "after",
    "arguments",
    "before",
    "details",
    "expected",
    "input",
    "output",
    "payload",
    "value",
  ]);
  const textKeys = new Set(["description", "instruction", "message", "note", "reason", "text"]);

  const visit = (value: unknown, key?: string, insidePayload = false): unknown => {
    const payload = insidePayload || (key !== undefined && payloadKeys.has(key));
    if (payload && key !== undefined && sensitiveKey(key, names)) {
      replacements += 1;
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      if (payload && propagatedSecrets.includes(value)) {
        replacements += 1;
        return "[REDACTED]";
      }
      if (key !== undefined && textKeys.has(key)) {
        let redacted = value;
        for (const secret of propagatedSecrets) {
          const count = redacted.split(secret).length - 1;
          if (count > 0) {
            replacements += count;
            redacted = redacted.replaceAll(secret, "[REDACTED]");
          }
        }
        return redacted;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, undefined, payload));
    if (!objectValue(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [childKey, visit(item, childKey, payload)]),
    );
  };

  return {
    result: visit(result) as RunResult,
    evidence: visit(evidence) as readonly EvidenceEntry[],
    summary: {
      policy: "safe_fields_v2",
      applied: replacements > 0,
      replacements,
    },
  };
}

function checkedInput(input: LocalReportInput): CheckedLocalReport {
  const result = RunResultSchema.parse(input.result);
  const evidence = input.evidence.map((entry) => EvidenceEntrySchema.parse(entry));
  const tools = (input.tools ?? []).map((tool) => ToolPackageManifestSchema.parse(tool));
  for (let index = 1; index < evidence.length; index += 1) {
    const previous = evidence[index - 1];
    const current = evidence[index];
    if (previous !== undefined && current !== undefined && current.sequence <= previous.sequence) {
      throw new TypeError("report evidence must be ordered by sequence");
    }
  }
  if (result.evidenceRange !== undefined) {
    const first = evidence[0]?.sequence;
    const last = evidence.at(-1)?.sequence;
    if (first !== result.evidenceRange.fromSequence || last !== result.evidenceRange.toSequence) {
      throw new TypeError("report evidence does not match the sealed run range");
    }
  }
  const evidenceHash = semanticHash(evidence);
  if (result.status === "sealed" && result.evidenceHash !== evidenceHash) {
    throw new TypeError("report evidence hash does not match the sealed run");
  }
  if (
    result.status === "sealed" &&
    result.trajectoryHash !==
      trajectoryHash({ interactions: result.interactions, checkpoints: result.checkpoints, evidence })
  ) {
    throw new TypeError("report trajectory hash does not match the sealed run");
  }
  const redacted = redactReportValues(result, evidence, tools);
  return {
    result: redacted.result,
    evidence: redacted.evidence,
    sourceRunResultHash: semanticHash(result),
    sourceEvidenceHash: evidenceHash,
    redaction: redacted.summary,
  };
}

function operationName(entry: Extract<EvidenceEntry, { kind: "operation" }>): string {
  return `${entry.invocation.operation.packageId}.${entry.invocation.operation.operationId}`;
}

function assertionMark(assertion: AssertionResult): string {
  if (assertion.status === "passed") return "PASS";
  if (assertion.status === "failed") return assertion.gate ? "FAIL" : "WARN";
  return assertion.status.toUpperCase();
}

function terminalValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  const limit = 320;
  return serialized.length <= limit ? serialized : `${serialized.slice(0, limit - 3)}...`;
}

function reproductionCommand(result: RunResult): string {
  return `firedrill run ${result.identity.drillId} --seed ${result.identity.seed} --trials 1`;
}

function terminalReport({ result, evidence }: CheckedLocalReport): string {
  const outcome =
    result.status === "sealed" ? result.verdict.toUpperCase() : result.status.replace("_", " ").toUpperCase();
  const lines = [
    `${outcome}  ${result.identity.drillId}  trial ${result.identity.trial}/${result.identity.trialCount}  attempt ${result.identity.attempt}/${result.identity.attemptLimit}`,
    `Run ${result.identity.runId}`,
    `Build ${result.identity.buildHash}  seed ${result.identity.seed}`,
  ];
  if (result.status === "sealed") {
    const completed = result.interactions.filter(
      (interaction) => interaction.targetResult.status === "completed",
    ).length;
    lines.push(
      `${completed}/${result.interactions.length} agent interaction${result.interactions.length === 1 ? "" : "s"} completed  binding ${result.bindingEvidence}`,
    );
    for (const interaction of result.interactions.filter(
      (candidate) => candidate.targetResult.status !== "completed",
    )) {
      lines.push(
        `FAIL  ${interaction.interactionId} — ${interaction.targetResult.error?.message ?? interaction.targetResult.status}`,
      );
    }
    for (const checkpoint of result.checkpoints.filter(
      (candidate) => candidate.kind !== "final" && candidate.verdict === "failed",
    )) {
      for (const assertion of checkpoint.assertionResults.filter(
        (candidate) => candidate.gate && candidate.status !== "passed",
      )) {
        lines.push(`FAIL  ${assertion.assertionId} at ${checkpoint.virtualTimeUs} μs — ${assertion.message}`);
      }
    }
    for (const assertion of result.assertionResults) {
      lines.push(`${assertionMark(assertion).padEnd(5)} ${assertion.assertionId} — ${assertion.message}`);
      if (assertion.status === "failed") {
        lines.push(`      expected ${terminalValue(assertion.expected)}`);
        lines.push(`      actual   ${terminalValue(assertion.actual)}`);
      }
    }
    const operations = evidence.filter((entry) => entry.kind === "operation");
    const stateChanges = evidence.filter((entry) => entry.kind === "state_change");
    lines.push(
      `${operations.length} tool call${operations.length === 1 ? "" : "s"}; ${stateChanges.length} state change${stateChanges.length === 1 ? "" : "s"}; ${evidence.length} evidence entr${evidence.length === 1 ? "y" : "ies"}`,
    );
    lines.push(`Trajectory ${result.trajectoryHash}`);
  } else if (result.status === "runner_failed") {
    lines.push(`ERROR ${result.error.code} — ${result.error.message}`);
  } else {
    lines.push(`CANCELLED — ${result.reason}`);
  }
  lines.push(
    `Budgets: ${result.budgetUsage.toolCalls.attempted}/${result.budgetUsage.toolCalls.limit} Tool calls` +
      `${result.budgetUsage.toolCalls.rejected === 0 ? "" : ` (${result.budgetUsage.toolCalls.rejected} rejected)`}; ` +
      `${result.budgetUsage.scheduledEvents.processed}/${result.budgetUsage.scheduledEvents.limit} scheduled events` +
      `${result.budgetUsage.scheduledEvents.exhausted ? " (exhausted)" : ""}`,
  );
  lines.push(`Reproduce: ${reproductionCommand(result)}`);
  return `${lines.join("\n")}\n`;
}

export function renderTerminalReport(rawInput: LocalReportInput): string {
  return terminalReport(checkedInput(rawInput));
}

export function renderJsonReport(rawInput: LocalReportInput): string {
  return jsonReport(checkedInput(rawInput));
}

function jsonReport(input: CheckedLocalReport): string {
  return `${JSON.stringify({ schemaVersion: 1, run: input.result, evidence: input.evidence }, null, 2)}\n`;
}

function validXmlText(value: unknown): string {
  let result = "";
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    const valid =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    result += valid && codePoint !== 0xfffe && codePoint !== 0xffff ? character : "�";
  }
  return result;
}

function xml(value: unknown): string {
  return validXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertionCase(assertion: AssertionResult): string {
  const failed = assertion.gate && assertion.status !== "passed";
  const body = failed
    ? `<failure message="${xml(assertion.message)}" type="${xml(assertion.kind)}">${xml(
        JSON.stringify({ expected: assertion.expected, actual: assertion.actual, diff: assertion.diff }),
      )}</failure>`
    : assertion.status === "passed"
      ? ""
      : `<system-out>${xml(`Non-gating ${assertion.status}: ${assertion.message}`)}</system-out>`;
  return `<testcase name="${xml(assertion.assertionId)}" classname="firedrill.assertion" time="0">${body}</testcase>`;
}

function junitSeconds(startedAtVirtualUs: number, finishedAtVirtualUs: number): string {
  return ((finishedAtVirtualUs - startedAtVirtualUs) / 1_000_000)
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function targetStderr(attachments: readonly Record<string, unknown>[]): string | undefined {
  const messages = attachments.flatMap((attachment) =>
    attachment.kind === "process.stderr" && typeof attachment.text === "string" ? [attachment.text] : [],
  );
  return messages.length === 0 ? undefined : messages.join("\n");
}

function junitReport({ result }: CheckedLocalReport): string {
  const assertionCases = result.checkpoints.flatMap((checkpoint) =>
    checkpoint.assertionResults.map((assertion) => ({ checkpoint, assertion })),
  );
  const interactionFailures = result.interactions.filter(
    (interaction) =>
      interaction.targetResult.status !== "completed" && interaction.targetResult.status !== "cancelled",
  ).length;
  const assertionFailures = assertionCases.filter(
    ({ assertion }) => assertion.gate && assertion.status !== "passed",
  ).length;
  const runnerFailed = result.status === "runner_failed";
  const cancelled = result.status === "cancelled";
  const failures = assertionFailures;
  const errors = interactionFailures + (runnerFailed ? 1 : 0);
  const skipped =
    result.interactions.filter((interaction) => interaction.targetResult.status === "cancelled").length +
    (cancelled && result.interactions.length === 0 ? 1 : 0);
  const runnerCase = runnerFailed
    ? `<testcase name="drill runner" classname="firedrill.runner" time="${junitSeconds(
        result.startedAtVirtualUs,
        result.finishedAtVirtualUs,
      )}"><error message="${xml(result.error.message)}" type="${xml(result.error.code)}" /></testcase>`
    : cancelled && result.interactions.length === 0
      ? `<testcase name="drill runner" classname="firedrill.runner" time="${junitSeconds(
          result.startedAtVirtualUs,
          result.finishedAtVirtualUs,
        )}"><skipped message="${xml(result.reason)}" /></testcase>`
      : undefined;
  const interactionCases = result.interactions.map((interaction) => {
    const name = `interaction ${interaction.interactionId}`;
    const time = junitSeconds(interaction.startedAtVirtualUs, interaction.finishedAtVirtualUs);
    const stderr = targetStderr(interaction.targetResult.attachments);
    const diagnostics = stderr === undefined ? "" : `<system-err>${xml(stderr)}</system-err>`;
    if (interaction.targetResult.status === "completed") {
      return `<testcase name="${xml(name)}" classname="firedrill.target" time="${time}">${diagnostics}</testcase>`;
    }
    if (interaction.targetResult.status === "cancelled") {
      return `<testcase name="${xml(name)}" classname="firedrill.target" time="${time}"><skipped message="${xml(
        interaction.targetResult.error?.message ?? "cancelled",
      )}" />${diagnostics}</testcase>`;
    }
    return `<testcase name="${xml(name)}" classname="firedrill.target" time="${time}"><error message="${xml(
      interaction.targetResult.error?.message ?? interaction.targetResult.status,
    )}" type="${xml(interaction.targetResult.error?.code ?? interaction.targetResult.status)}" />${diagnostics}</testcase>`;
  });
  const tests = interactionCases.length + assertionCases.length + (runnerCase === undefined ? 0 : 1);
  const properties = [
    ...(result.status === "sealed"
      ? [`<property name="firedrill.trajectoryHash" value="${xml(result.trajectoryHash)}" />`]
      : []),
    `<property name="firedrill.toolCalls.attempted" value="${result.budgetUsage.toolCalls.attempted}" />`,
    `<property name="firedrill.toolCalls.limit" value="${result.budgetUsage.toolCalls.limit}" />`,
    `<property name="firedrill.scheduledEvents.processed" value="${result.budgetUsage.scheduledEvents.processed}" />`,
    `<property name="firedrill.scheduledEvents.limit" value="${result.budgetUsage.scheduledEvents.limit}" />`,
  ];
  const duration = junitSeconds(result.startedAtVirtualUs, result.finishedAtVirtualUs);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${duration}">`,
    `  <testsuite name="${xml(result.identity.drillId)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${duration}">`,
    `    <properties>${properties.join("")}</properties>`,
    ...(runnerCase === undefined ? [] : [`    ${runnerCase}`]),
    ...interactionCases.map((testCase) => `    ${testCase}`),
    ...assertionCases.map(
      ({ checkpoint, assertion }) =>
        `    ${assertionCase({ ...assertion, assertionId: `${checkpoint.checkpointId}/${assertion.assertionId}` })}`,
    ),
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

export function renderJunitReport(rawInput: LocalReportInput): string {
  return junitReport(checkedInput(rawInput));
}

function html(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(value: unknown): string {
  return html(JSON.stringify(value, null, 2));
}

function evidenceRows(evidence: readonly EvidenceEntry[]): string {
  return evidence
    .map((entry) => {
      let subject: string;
      if (entry.kind === "operation") subject = operationName(entry);
      else if (entry.kind === "state_change")
        subject = `${entry.packageId}.${entry.namespace}/${entry.rowId}`;
      else if (entry.kind === "event") subject = `${entry.event.packageId}.${entry.event.eventId}`;
      else if (entry.kind === "fault") subject = `${entry.packageId}.${entry.faultId}`;
      else if (entry.kind === "clock") subject = `${entry.fromUs} → ${entry.toUs} μs`;
      else if (entry.kind === "random") subject = `${entry.packageId} draw ${entry.draw}`;
      else if (entry.kind === "verification") {
        subject = `${entry.checkpointId}/${entry.result.assertionId}`;
      } else subject = entry.action;
      return `<tr><td class="mono">${entry.sequence}</td><td>${html(entry.kind.replaceAll("_", " "))}</td><td>${html(subject)}</td><td class="mono">${entry.virtualTimeUs}</td><td><details><summary>Inspect</summary><pre>${json(entry)}</pre></details></td></tr>`;
    })
    .join("");
}

function assertionRows(assertions: readonly AssertionResult[]): string {
  if (assertions.length === 0) return '<p class="empty">No assertions were evaluated.</p>';
  return `<div class="assertions">${assertions
    .map((assertion) => {
      const disclosure = assertion.status === "passed" ? "" : " open";
      return `<article class="assertion ${html(assertion.status)}"><span class="status">${html(assertionMark(assertion))}</span><div><h3>${html(assertion.assertionId)}</h3><p>${html(assertion.message)}</p><details${disclosure}><summary>Expected and actual</summary><pre>${json({ expected: assertion.expected, actual: assertion.actual, diff: assertion.diff })}</pre></details></div></article>`;
    })
    .join("")}</div>`;
}

function stateChangeRows(evidence: readonly EvidenceEntry[]): string {
  const changes = evidence.filter((entry) => entry.kind === "state_change");
  if (changes.length === 0) return '<p class="empty">No state changed during this run.</p>';
  return `<table><thead><tr><th scope="col">Record</th><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${changes
    .map(
      (entry) =>
        `<tr><td class="mono">${html(`${entry.packageId}.${entry.namespace}/${entry.rowId}`)}</td><td>${html(entry.change)}</td><td><pre>${json(entry.before)}</pre></td><td><pre>${json(entry.after)}</pre></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function interactionRows(result: RunResult): string {
  if (result.interactions.length === 0) {
    return '<p class="empty">No agent interaction started before this run ended.</p>';
  }
  return `<table><thead><tr><th scope="col">Interaction</th><th scope="col">Actor</th><th scope="col">Virtual time</th><th scope="col">Result</th><th scope="col">Task</th></tr></thead><tbody>${result.interactions
    .map((interaction) => {
      const error = interaction.targetResult.error;
      const output = interaction.targetResult.output;
      const attachments = interaction.targetResult.attachments
        .map((attachment) => {
          const label =
            typeof attachment.kind === "string"
              ? attachment.kind.replaceAll(".", " ")
              : typeof attachment.name === "string"
                ? attachment.name
                : "Attachment";
          const body = typeof attachment.text === "string" ? html(attachment.text) : json(attachment);
          return `<details><summary>${html(label)}</summary><pre>${body}</pre></details>`;
        })
        .join("");
      return `<tr><td class="mono">${html(interaction.interactionId)}</td><td>${html(interaction.actorId)}</td><td class="mono">${interaction.scheduledAtVirtualUs}</td><td><strong>${html(interaction.targetResult.status)}</strong>${error === undefined ? "" : `<p class="meta">${html(`${error.code}: ${error.message}`)}</p>`}${output === undefined ? "" : `<details><summary>Output</summary><pre>${json(output)}</pre></details>`}${attachments}</td><td><p>${html(interaction.task.instruction)}</p>${interaction.task.input === undefined ? "" : `<details><summary>Input</summary><pre>${json(interaction.task.input)}</pre></details>`}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function checkpointRows(result: RunResult): string {
  const checkpoints = result.checkpoints.filter((checkpoint) => checkpoint.kind !== "final");
  if (checkpoints.length === 0) {
    return '<p class="empty">No repeating invariants were configured.</p>';
  }
  return `<div class="checkpoints">${checkpoints
    .map(
      (checkpoint) =>
        `<details${checkpoint.verdict === "failed" ? " open" : ""}><summary><span class="checkpoint-status ${html(checkpoint.verdict)}">${html(checkpoint.verdict)}</span> ${html(checkpoint.kind.replaceAll("_", " "))} at <span class="mono">${checkpoint.virtualTimeUs}</span>${checkpoint.interactionId === undefined ? "" : ` · ${html(checkpoint.interactionId)}`}</summary>${assertionRows(checkpoint.assertionResults)}</details>`,
    )
    .join("")}</div>`;
}

function htmlReport({ result, evidence }: CheckedLocalReport): string {
  const verdict = result.status === "sealed" ? result.verdict : result.status;
  const operations = evidence.filter((entry) => entry.kind === "operation").length;
  const stateChanges = evidence.filter((entry) => entry.kind === "state_change").length;
  const events = evidence.filter((entry) => entry.kind === "event").length;
  const count = (value: number, singular: string, plural = `${singular}s`) =>
    `${value} ${value === 1 ? singular : plural}`;
  const summary = [
    count(result.interactions.length, "agent interaction"),
    count(operations, "tool call"),
    count(stateChanges, "state change"),
    count(events, "event"),
    count(evidence.length, "evidence entry", "evidence entries"),
  ].join(" · ");
  const reproduction = reproductionCommand(result);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(result.identity.drillId)} · Firedrill report</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--blue:#315ed8;--green:#16845b;--red:#c33d48;--amber:#a86308;--code:#f1f1f3}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:48px 28px 72px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:12px}h1{font-size:30px;line-height:1.15;letter-spacing:-.025em;margin:0 0 8px;overflow-wrap:anywhere}.meta{color:var(--muted);margin:0;overflow-wrap:anywhere}.summary{color:var(--muted);margin:0 0 28px}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-weight:700;text-transform:uppercase;font-size:12px}.pill.passed{color:var(--green)}.pill.failed,.pill.runner_failed{color:var(--red)}.pill.inconclusive,.pill.cancelled{color:var(--amber)}section{margin-top:30px}h2{font-size:18px;letter-spacing:-.01em;margin:0 0 12px}.panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:18px 20px}.assertions{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}.assertion{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line)}.assertion:last-child{border:0}.assertion h3{font-size:14px;margin:0}.assertion p{color:var(--muted);margin:3px 0 0}.status{font-size:11px;font-weight:800;color:var(--green)}.assertion.failed .status{color:var(--red)}.assertion.inconclusive .status,.assertion.invalid .status{color:var(--amber)}.checkpoints{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:4px 16px}.checkpoints>details{padding:10px 0;border-bottom:1px solid var(--line)}.checkpoints>details:last-child{border:0}.checkpoint-status{color:var(--green);text-transform:uppercase;font-size:11px}.checkpoint-status.failed{color:var(--red)}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);font-size:13px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}td p{margin:0}tr:last-child td{border:0}.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{display:block;background:var(--code);border-radius:8px;padding:12px;overflow:auto}details{margin-top:8px}summary{cursor:pointer;color:var(--blue);font-weight:600}summary:focus-visible{border-radius:4px;outline:2px solid var(--blue);outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:12px;border-radius:8px;font-size:12px}.empty{color:var(--muted)}@media(max-width:760px){main{padding:28px 16px}header{display:block}.pill{display:inline-block;margin-top:14px}table{display:block;overflow:auto}}
@media(prefers-color-scheme:dark){:root{--bg:#0c0d0f;--panel:#121316;--text:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--code:#191a1e;--blue:#83a2ff;--green:#55cf9b;--red:#ff818e;--amber:#f4b65f}}
</style></head><body><main>
<header><div><h1>${html(result.identity.drillId)}</h1><p class="meta">Trial ${result.identity.trial}/${result.identity.trialCount} · Attempt ${result.identity.attempt}/${result.identity.attemptLimit} · Run <span class="mono">${html(result.identity.runId)}</span></p></div><span class="pill ${html(verdict)}">${html(verdict)}</span></header>
<p class="summary">${html(summary)}</p>
${result.status === "runner_failed" ? `<section><h2>Runner failure</h2><div class="panel"><strong>${html(result.error.code)}</strong><p class="meta">${html(result.error.message)}</p></div></section>` : result.status === "cancelled" ? `<section><h2>Cancelled</h2><div class="panel"><p>${html(result.reason)}</p></div></section>` : ""}
<section><h2>Resource budgets</h2><div class="panel"><p>${result.budgetUsage.toolCalls.attempted}/${result.budgetUsage.toolCalls.limit} Tool calls${result.budgetUsage.toolCalls.rejected === 0 ? "" : ` · ${result.budgetUsage.toolCalls.rejected} rejected`}</p><p class="meta">${result.budgetUsage.scheduledEvents.processed}/${result.budgetUsage.scheduledEvents.limit} scheduled events processed${result.budgetUsage.scheduledEvents.exhausted ? " · budget exhausted" : ""}</p></div></section>
<section><h2>Agent interactions</h2>${interactionRows(result)}</section>
<section><h2>Invariant checkpoints</h2>${checkpointRows(result)}</section>
<section><h2>Final assertions</h2>${assertionRows(result.assertionResults)}</section>
<section><h2>State changes</h2>${stateChangeRows(evidence)}</section>
<section><h2>Evidence timeline</h2><table><thead><tr><th scope="col">Seq</th><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Virtual time</th><th scope="col">Details</th></tr></thead><tbody>${evidenceRows(evidence)}</tbody></table></section>
<section><h2>Reproduce</h2><code>${html(reproduction)}</code><p class="meta">Build ${html(result.identity.buildHash)} · Seed ${html(result.identity.seed)}${result.status === "sealed" ? ` · Trajectory ${html(result.trajectoryHash)}` : ""}</p></section>
</main></body></html>\n`;
}

export function renderHtmlReport(rawInput: LocalReportInput): string {
  return htmlReport(checkedInput(rawInput));
}

function artifact(
  path: string,
  mediaType: string,
  role: ReportArtifact["role"],
  body: string,
): ReportArtifact {
  return {
    path,
    mediaType,
    bytes: Buffer.byteLength(body),
    hash: sha256(body),
    role,
  };
}

/** Writes a complete report directory without ever replacing an existing report. */
export function writeLocalReport(rawInput: LocalReportInput, outputDirectory: string): WrittenLocalReport {
  const input = checkedInput(rawInput);
  const destination = resolve(outputDirectory);
  if (existsSync(destination)) throw new Error(`refusing to overwrite report directory ${destination}`);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(destination)}-`));
  const bodies = {
    run: `${JSON.stringify(input.result, null, 2)}\n`,
    evidence: `${input.evidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    json: jsonReport(input),
    terminal: terminalReport(input),
    junit: junitReport(input),
    html: htmlReport(input),
  };
  const artifacts = [
    artifact("run.json", "application/json", "run", bodies.run),
    artifact("evidence.jsonl", "application/x-ndjson", "evidence", bodies.evidence),
    artifact("report.json", "application/json", "json", bodies.json),
    artifact("terminal.txt", "text/plain; charset=utf-8", "terminal", bodies.terminal),
    artifact("junit.xml", "application/junit+xml", "junit", bodies.junit),
    artifact("index.html", "text/html; charset=utf-8", "html", bodies.html),
  ];
  const manifest = EvidenceBundleManifestSchema.parse({
    schemaVersion: 1,
    runId: input.result.identity.runId,
    complete: true,
    runResultHash: input.sourceRunResultHash,
    evidenceHash: input.sourceEvidenceHash,
    ...(input.result.status === "sealed"
      ? { stateHash: input.result.stateHash, trajectoryHash: input.result.trajectoryHash }
      : {}),
    projectedRunResultHash: semanticHash(input.result),
    projectedEvidenceHash: semanticHash(input.evidence),
    ...(input.result.status === "sealed"
      ? {
          projectedTrajectoryHash: trajectoryHash({
            interactions: input.result.interactions,
            checkpoints: input.result.checkpoints,
            evidence: input.evidence,
          }),
        }
      : {}),
    redaction: input.redaction,
    reproduction: {
      schemaVersion: 1,
      scope: "world_inputs",
      drillId: input.result.identity.drillId,
      ...(input.result.identity.scenarioId === undefined
        ? {}
        : { scenarioId: input.result.identity.scenarioId }),
      targetId: input.result.identity.targetId,
      buildHash: input.result.identity.buildHash,
      packageLockHash: input.result.identity.packageLockHash,
      seed: input.result.identity.seed,
      originalTrial: input.result.identity.trial,
      originalTrialCount: input.result.identity.trialCount,
      originalAttempt: input.result.identity.attempt,
      originalAttemptLimit: input.result.identity.attemptLimit,
    },
    artifacts,
  });
  try {
    writeFileSync(join(temporary, "run.json"), bodies.run);
    writeFileSync(join(temporary, "evidence.jsonl"), bodies.evidence);
    writeFileSync(join(temporary, "report.json"), bodies.json);
    writeFileSync(join(temporary, "terminal.txt"), bodies.terminal);
    writeFileSync(join(temporary, "junit.xml"), bodies.junit);
    writeFileSync(join(temporary, "index.html"), bodies.html);
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true, recursive: true });
    throw error;
  }
  return {
    directory: destination,
    manifest,
    files: {
      manifest: join(destination, "manifest.json"),
      run: join(destination, "run.json"),
      evidence: join(destination, "evidence.jsonl"),
      json: join(destination, "report.json"),
      terminal: join(destination, "terminal.txt"),
      junit: join(destination, "junit.xml"),
      html: join(destination, "index.html"),
    },
  };
}

function bundleFiles(root: string): readonly string[] {
  const result: string[] = [];
  let entries = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_BUNDLE_DEPTH) {
      throw new LocalReportVerificationError(
        "reporter.BUNDLE_LIMIT_EXCEEDED",
        `report bundle exceeds the ${MAX_BUNDLE_DEPTH}-directory depth limit`,
      );
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_BUNDLE_ENTRIES) {
        throw new LocalReportVerificationError(
          "reporter.BUNDLE_LIMIT_EXCEEDED",
          `report bundle exceeds the ${MAX_BUNDLE_ENTRIES}-entry limit`,
        );
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new LocalReportVerificationError(
          "reporter.BUNDLE_CONTENT_MISMATCH",
          "report bundle cannot contain symbolic links",
        );
      }
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
      else {
        throw new LocalReportVerificationError(
          "reporter.BUNDLE_CONTENT_MISMATCH",
          "report bundle contains an unsupported filesystem entry",
        );
      }
    }
  };
  visit(root, 0);
  return result.sort();
}

function artifactPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const candidate = relative(root, resolved);
  if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    throw new LocalReportVerificationError(
      "reporter.BUNDLE_CONTENT_MISMATCH",
      "report artifact resolves outside its bundle",
    );
  }
  return resolved;
}

function parseManifest(path: string): EvidenceBundleManifest {
  try {
    if (statSync(path).size > MAX_MANIFEST_BYTES) {
      throw new LocalReportVerificationError(
        "reporter.BUNDLE_LIMIT_EXCEEDED",
        "report manifest exceeds 1 MiB",
      );
    }
    return EvidenceBundleManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof LocalReportVerificationError) throw error;
    throw new LocalReportVerificationError(
      "reporter.MANIFEST_INVALID",
      "report manifest is missing or invalid",
    );
  }
}

/** Verifies a self-contained local report without contacting Firedrill Cloud. */
export function verifyLocalReport(outputDirectory: string): VerifiedLocalReport {
  const directory = resolve(outputDirectory);
  let actualFiles: readonly string[];
  try {
    actualFiles = bundleFiles(directory);
  } catch (error) {
    if (error instanceof LocalReportVerificationError) throw error;
    throw new LocalReportVerificationError(
      "reporter.BUNDLE_CONTENT_MISMATCH",
      "report bundle cannot be read",
    );
  }
  const manifest = parseManifest(join(directory, "manifest.json"));
  if (!manifest.complete) {
    throw new LocalReportVerificationError("reporter.REPORT_INVALID", "report bundle is not marked complete");
  }
  const expectedFiles = ["manifest.json", ...manifest.artifacts.map((artifact) => artifact.path)].sort();
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some((file, index) => file !== actualFiles[index])
  ) {
    throw new LocalReportVerificationError(
      "reporter.BUNDLE_CONTENT_MISMATCH",
      "report bundle files do not match its manifest",
    );
  }

  let claimedBytes = 0;
  for (const artifact of manifest.artifacts) {
    if (artifact.bytes > MAX_ARTIFACT_BYTES) {
      throw new LocalReportVerificationError(
        "reporter.BUNDLE_LIMIT_EXCEEDED",
        `report artifact ${artifact.path} exceeds 64 MiB`,
      );
    }
    claimedBytes += artifact.bytes;
    if (claimedBytes > MAX_BUNDLE_BYTES) {
      throw new LocalReportVerificationError(
        "reporter.BUNDLE_LIMIT_EXCEEDED",
        "report artifacts exceed the 256 MiB bundle limit",
      );
    }
    const path = artifactPath(directory, artifact.path);
    if (statSync(path).size !== artifact.bytes) {
      throw new LocalReportVerificationError(
        "reporter.ARTIFACT_MISMATCH",
        `report artifact ${artifact.path} does not match its manifest`,
      );
    }
    const body = readFileSync(path);
    if (body.byteLength !== artifact.bytes || sha256(body) !== artifact.hash) {
      throw new LocalReportVerificationError(
        "reporter.ARTIFACT_MISMATCH",
        `report artifact ${artifact.path} does not match its manifest`,
      );
    }
  }

  const artifactForRole = (role: ReportArtifact["role"]): ReportArtifact | undefined => {
    const matches = manifest.artifacts.filter((artifact) => artifact.role === role);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const runArtifact = artifactForRole("run");
  const evidenceArtifact = artifactForRole("evidence");
  const jsonArtifact = artifactForRole("json");
  const terminalArtifact = artifactForRole("terminal");
  const junitArtifact = artifactForRole("junit");
  const htmlArtifact = artifactForRole("html");
  if (
    runArtifact === undefined ||
    evidenceArtifact === undefined ||
    jsonArtifact === undefined ||
    terminalArtifact === undefined ||
    junitArtifact === undefined ||
    htmlArtifact === undefined
  ) {
    throw new LocalReportVerificationError(
      "reporter.REPORT_INVALID",
      "report bundle requires exactly one run, evidence, JSON, terminal, JUnit, and HTML artifact",
    );
  }

  let result: RunResult;
  let evidence: readonly EvidenceEntry[];
  try {
    result = RunResultSchema.parse(
      JSON.parse(readFileSync(artifactPath(directory, runArtifact.path), "utf8")),
    );
    const evidenceText = readFileSync(artifactPath(directory, evidenceArtifact.path), "utf8").trim();
    evidence =
      evidenceText.length === 0
        ? []
        : evidenceText.split("\n").map((line) => EvidenceEntrySchema.parse(JSON.parse(line)));
  } catch {
    throw new LocalReportVerificationError(
      "reporter.REPORT_INVALID",
      "report run or evidence artifact is invalid",
    );
  }

  const range = result.evidenceRange;
  if (
    result.identity.runId !== manifest.runId ||
    (range !== undefined &&
      (evidence[0]?.sequence !== range.fromSequence || evidence.at(-1)?.sequence !== range.toSequence)) ||
    manifest.reproduction.drillId !== result.identity.drillId ||
    manifest.reproduction.targetId !== result.identity.targetId ||
    manifest.reproduction.buildHash !== result.identity.buildHash ||
    manifest.reproduction.packageLockHash !== result.identity.packageLockHash ||
    manifest.reproduction.seed !== result.identity.seed ||
    manifest.reproduction.scenarioId !== result.identity.scenarioId ||
    manifest.reproduction.originalTrial !== result.identity.trial ||
    manifest.reproduction.originalTrialCount !== result.identity.trialCount ||
    manifest.reproduction.originalAttempt !== result.identity.attempt ||
    manifest.reproduction.originalAttemptLimit !== result.identity.attemptLimit ||
    (result.status === "sealed" &&
      (manifest.stateHash !== result.stateHash ||
        manifest.evidenceHash !== result.evidenceHash ||
        manifest.trajectoryHash !== result.trajectoryHash)) ||
    (result.status !== "sealed" &&
      (manifest.stateHash !== undefined || manifest.trajectoryHash !== undefined))
  ) {
    throw new LocalReportVerificationError(
      "reporter.REPORT_INVALID",
      "report identity, evidence range, or reproduction metadata is inconsistent",
    );
  }

  const checked: CheckedLocalReport = {
    result,
    evidence,
    sourceRunResultHash: manifest.runResultHash,
    sourceEvidenceHash: manifest.evidenceHash,
    redaction: manifest.redaction,
  };
  const expectedBodies = new Map<string, string>([
    [runArtifact.path, `${JSON.stringify(result, null, 2)}\n`],
    [evidenceArtifact.path, `${evidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`],
    [jsonArtifact.path, jsonReport(checked)],
    [terminalArtifact.path, terminalReport(checked)],
    [junitArtifact.path, junitReport(checked)],
    [htmlArtifact.path, htmlReport(checked)],
  ]);
  for (const [path, expected] of expectedBodies) {
    if (readFileSync(artifactPath(directory, path), "utf8") !== expected) {
      throw new LocalReportVerificationError(
        "reporter.REPORT_INVALID",
        `report artifact ${path} is inconsistent with the run and evidence`,
      );
    }
  }

  if (
    semanticHash(result) !== manifest.projectedRunResultHash ||
    semanticHash(evidence) !== manifest.projectedEvidenceHash ||
    (result.status === "sealed" &&
      trajectoryHash({ interactions: result.interactions, checkpoints: result.checkpoints, evidence }) !==
        manifest.projectedTrajectoryHash)
  ) {
    throw new LocalReportVerificationError(
      "reporter.SOURCE_HASH_MISMATCH",
      "report content does not match its projected semantic hashes",
    );
  }
  if (
    !manifest.redaction.applied &&
    (manifest.projectedRunResultHash !== manifest.runResultHash ||
      manifest.projectedEvidenceHash !== manifest.evidenceHash ||
      (result.status === "sealed" && manifest.projectedTrajectoryHash !== manifest.trajectoryHash))
  ) {
    throw new LocalReportVerificationError(
      "reporter.SOURCE_HASH_MISMATCH",
      "unredacted report content does not match its source hashes",
    );
  }
  return { directory, manifest, result, evidence };
}
