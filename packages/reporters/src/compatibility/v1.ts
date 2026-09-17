// Frozen report projection from 1ff11bd. Compatibility-only: do not restyle.
import type {
  AssertionResult,
  EvidenceEntry,
  ReportToolDescriptor,
  RunResult,
  TargetFileAttachment,
} from "@firedrill-tools/contracts";
import { compareStableStrings, TargetFileAttachmentSchema } from "@firedrill-tools/contracts";
import type { ReportProjectionInput, ReportProjections } from "./types.js";

const MAX_FILE_ATTACHMENTS = 32;

function fileAttachments(result: RunResult): readonly TargetFileAttachment[] {
  const attachments = result.interactions.flatMap((interaction) =>
    interaction.targetResult.attachments.flatMap((attachment) =>
      attachment.kind === "file" ? [TargetFileAttachmentSchema.parse(attachment)] : [],
    ),
  );
  if (attachments.length > MAX_FILE_ATTACHMENTS) {
    throw new TypeError(`a report supports at most ${MAX_FILE_ATTACHMENTS} file attachments`);
  }
  const ids = new Set<string>();
  for (const attachment of attachments) {
    if (ids.has(attachment.id)) throw new TypeError(`duplicate file attachment id ${attachment.id}`);
    ids.add(attachment.id);
  }
  return attachments.sort((left, right) => compareStableStrings(left.id, right.id));
}

function attachmentArtifactPath(attachment: TargetFileAttachment): string {
  return `attachments/${attachment.id}/${attachment.name}`;
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
  return `firedrill run ${result.identity.drillId} --build-hash ${result.identity.buildHash} --seed ${result.identity.seed} --trials 1`;
}

function hasRuntimeFaultControls(evidence: readonly EvidenceEntry[]): boolean {
  return evidence.some((entry) => entry.kind === "fault_control");
}

const RUNTIME_CONTROL_REPRODUCTION_NOTE =
  "This command restores initial world inputs only. Runtime fault controls require the original harness; the seed does not replay them or guarantee identical agent behavior.";

function terminalReport({ result, evidence, tools }: ReportProjectionInput): string {
  const outcome =
    result.status === "sealed" ? result.verdict.toUpperCase() : result.status.replace("_", " ").toUpperCase();
  const lines = [
    `${outcome}  ${result.identity.drillId}  trial ${result.identity.trial}/${result.identity.trialCount}  attempt ${result.identity.attempt}/${result.identity.attemptLimit}`,
    `Run ${result.identity.runId}`,
    `Build ${result.identity.buildHash}  seed ${result.identity.seed}`,
  ];
  if (result.setup !== undefined) lines.push(`Setup ${result.setup.setupHash}`);
  const compatibility = tools.flatMap((tool) =>
    tool.compatibility.map(
      (profile) =>
        `${tool.id}: ${profile.client.name}@${profile.client.version} (${profile.routes.length} covered route${profile.routes.length === 1 ? "" : "s"})`,
    ),
  );
  if (compatibility.length > 0) lines.push(`Compatibility ${compatibility.join("; ")}`);
  const attachments = fileAttachments(result);
  if (attachments.length > 0) {
    lines.push(
      `Attachments ${attachments.map((attachment) => `${attachment.name} (${attachment.bytes} bytes)`).join(", ")}`,
    );
  }
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
  lines.push(
    `${hasRuntimeFaultControls(evidence) ? "Rerun initial world inputs" : "Reproduce"}: ${reproductionCommand(result)}`,
  );
  if (hasRuntimeFaultControls(evidence)) lines.push(RUNTIME_CONTROL_REPRODUCTION_NOTE);
  return `${lines.join("\n")}\n`;
}

function jsonReport(input: ReportProjectionInput): string {
  return `${JSON.stringify(
    { schemaVersion: 1, run: input.result, tools: input.tools, evidence: input.evidence },
    null,
    2,
  )}\n`;
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

function junitReport({ result }: ReportProjectionInput): string {
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
    `<property name="firedrill.attachments" value="${fileAttachments(result).length}" />`,
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
      else if (entry.kind === "callback")
        subject = `${entry.callback.packageId}.${entry.callback.callbackId} · ${entry.phase}`;
      else if (entry.kind === "fault") subject = `${entry.packageId}.${entry.faultId}`;
      else if (entry.kind === "fault_control")
        subject = `${entry.packageId}.${entry.faultId} · ${entry.active ? "enabled" : "disabled"}${entry.previouslyActive === entry.active ? " (unchanged)" : ""}`;
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
          if (attachment.kind === "file") {
            const file = TargetFileAttachmentSchema.parse(attachment);
            const redaction =
              file.redaction.status === "applied_by_caller"
                ? "caller applied redaction before attachment"
                : "copied verbatim without redaction";
            return `<details><summary>${html(file.name)}</summary><p><a href="${html(attachmentArtifactPath(file))}" download>Open attachment</a> · ${file.bytes} bytes · ${html(file.mediaType)}</p><p class="meta">${html(redaction)}${file.redaction.note === null ? "" : ` · ${html(file.redaction.note)}`}</p></details>`;
          }
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

function toolRows(tools: readonly ReportToolDescriptor[]): string {
  if (tools.length === 0) return '<p class="empty">No Tool manifests were attached to this report.</p>';
  return `<table><thead><tr><th scope="col">Tool</th><th scope="col">Operations</th><th scope="col">Client compatibility</th></tr></thead><tbody>${tools
    .map((tool) => {
      const operations = tool.operations
        .map((operation) => `${operation.id} — ${operation.fidelity}`)
        .join("\n");
      const compatibility =
        tool.compatibility.length === 0
          ? '<span class="meta">No official-client compatibility claimed.</span>'
          : tool.compatibility
              .map((profile) => {
                const covered = profile.routes
                  .map((route) => `${route.clientMethod} → ${route.routeId}`)
                  .join("\n");
                return `<div><strong>${html(`${profile.client.name}@${profile.client.version}`)}</strong><p class="meta">${html(`${profile.service}${profile.apiVersion === undefined ? "" : ` · API ${profile.apiVersion}`} · ${profile.mode}`)}</p><details><summary>${profile.routes.length} covered route${profile.routes.length === 1 ? "" : "s"}</summary><pre>${html(covered)}</pre></details><details><summary>Known limitations</summary><ul>${profile.limitations.map((limitation) => `<li>${html(limitation)}</li>`).join("")}</ul></details></div>`;
              })
              .join("");
      return `<tr><td><strong>${html(tool.id)}</strong><p class="meta mono">${html(tool.version)}</p></td><td><pre>${html(operations)}</pre>${tool.http.length === 0 ? "" : `<p class="meta">${tool.http.length} synthetic HTTP route${tool.http.length === 1 ? "" : "s"}</p>`}</td><td>${compatibility}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function htmlReport({ result, evidence, tools }: ReportProjectionInput): string {
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
<section><h2>World capabilities</h2>${toolRows(tools)}</section>
<section><h2>Agent interactions</h2>${interactionRows(result)}</section>
<section><h2>Invariant checkpoints</h2>${checkpointRows(result)}</section>
<section><h2>Final assertions</h2>${assertionRows(result.assertionResults)}</section>
<section><h2>State changes</h2>${stateChangeRows(evidence)}</section>
${result.setup === undefined ? "" : `<section><h2>Test-local setup</h2><div class="panel"><p class="meta">${html(result.setup.setupHash)}</p><details><summary>View resolved setup</summary><pre>${html(JSON.stringify(result.setup.setup, null, 2))}</pre></details></div></section>`}
<section><h2>Evidence timeline</h2><table><thead><tr><th scope="col">Seq</th><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Virtual time</th><th scope="col">Details</th></tr></thead><tbody>${evidenceRows(evidence)}</tbody></table></section>
<section><h2>${hasRuntimeFaultControls(evidence) ? "Rerun initial world inputs" : "Reproduce"}</h2><code>${html(reproduction)}</code>${hasRuntimeFaultControls(evidence) ? `<p class="meta">${html(RUNTIME_CONTROL_REPRODUCTION_NOTE)}</p>` : ""}<p class="meta">Build ${html(result.identity.buildHash)} · Seed ${html(result.identity.seed)}${result.status === "sealed" ? ` · Trajectory ${html(result.trajectoryHash)}` : ""}</p></section>
</main></body></html>\n`;
}

export function legacyProjections(input: ReportProjectionInput): ReportProjections {
  return {
    json: jsonReport(input),
    terminal: terminalReport(input),
    junit: junitReport(input),
    html: htmlReport(input),
  };
}
