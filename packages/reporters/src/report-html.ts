import type {
  AssertionResult,
  EvidenceEntry,
  ReportToolDescriptor,
  RunResult,
  TargetFileAttachment,
} from "@firedrill-run/contracts";
import { TargetFileAttachmentSchema } from "@firedrill-run/contracts";
import { type AttachmentPreview, readableCaptureLog } from "./attachment-preview.js";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pretty(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2) ?? "Not recorded");
}

function label(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

export const reportStyles = `
:root{color-scheme:light dark;--bg:#fafafa;--panel:#fff;--text:#202124;--muted:#65666b;--line:#e5e5e7;--accent:#3154c8;--green:#207448;--red:#bd3434;--amber:#986317;--code:#f5f5f6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:auto;padding:32px 28px 72px}a{color:var(--accent);text-underline-offset:3px}button,input,select{font:inherit}a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}h1{font-size:26px;line-height:1.25;letter-spacing:-.025em;margin:12px 0 8px;overflow-wrap:anywhere}h2{font-size:18px;margin:0 0 4px}h3{font-size:14px;margin:0}p{margin:8px 0}header{padding-bottom:20px;border-bottom:1px solid var(--line)}.brand{font-weight:650;color:var(--muted);font-size:13px}.title-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.muted,.hint{color:var(--muted)}.hint{max-width:76ch;margin:0 0 14px}.outcome{font-size:13px;font-weight:650;white-space:nowrap}.passed{color:var(--green)}.failed,.runner_failed{color:var(--red)}.inconclusive,.invalid,.cancelled{color:var(--amber)}.facts{display:flex;flex-wrap:wrap;gap:8px 24px;margin-top:16px}.facts strong{font-weight:600}nav{display:flex;flex-wrap:wrap;gap:20px;padding:14px 0;border-bottom:1px solid var(--line)}nav a{text-decoration:none}nav a:hover{text-decoration:underline}section{margin-top:28px;scroll-margin-top:16px}.list{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--panel)}.item{padding:14px 16px;border-bottom:1px solid var(--line)}.item:last-child{border-bottom:0}.item>summary{display:flex;align-items:baseline;gap:12px;list-style:none}.item>summary:before{content:"›";color:var(--muted)}.item[open]>summary:before{content:"⌄"}.item summary strong{color:var(--text);overflow-wrap:anywhere}.item summary .muted{margin-left:auto;font-size:12px}.item p{overflow-wrap:anywhere}.call-number{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.tag{font-size:12px;font-weight:650;white-space:nowrap}details>summary{cursor:pointer}details details{margin:12px 0}pre,code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{padding:12px;background:var(--code);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}code{overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.columns>*{min-width:0}.comparison{margin-top:14px}.comparison h3{font-size:12px;color:var(--muted);font-weight:500}.failure{border:1px solid var(--line);border-radius:6px;padding:12px 16px;background:var(--panel)}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:500}td p{margin:0}td a{font-weight:600}tr:last-child td{border-bottom:0}.empty{padding:24px 16px;color:var(--muted)}.filters{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}.filters label{display:flex;gap:8px;align-items:center}.filters input,.filters select{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:8px 12px;border-radius:6px}.filters input{width:280px;max-width:100%}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.toolbar button{border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);padding:6px 12px}.toolbar button:disabled{opacity:.4}footer{margin-top:32px;color:var(--muted);font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}
@media(prefers-color-scheme:dark){:root{--bg:#0c0d0f;--panel:#121316;--text:#eeeef0;--muted:#b1b2bb;--line:#292a30;--code:#1a1b20;--accent:#a3b4f6;--green:#75cc9b;--red:#f79090;--amber:#e7bf79}}
@media(max-width:680px){main{padding:20px 16px 48px}.columns{grid-template-columns:1fr}.title-row{align-items:flex-start}h1{font-size:22px}.item>summary{flex-wrap:wrap;gap:6px 10px}.item summary .muted{margin-left:0}.filters{display:block}.filters label{margin-top:10px}.filters input{width:100%}th,td{padding:10px}.facts{gap:6px 14px}}
.attachment-media{display:block;width:auto;max-width:100%;max-height:70vh;object-fit:contain;margin:12px 0;background:var(--code)}video.attachment-media{width:100%}.attachment-log{max-height:24rem;overflow:auto;white-space:pre-wrap}.capture-errors{padding-left:20px}.capture-errors li+li{margin-top:8px}
`;

export function reportDocument(
  title: string,
  body: string,
  script = "",
  contentSecurityPolicy?: string,
): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">${contentSecurityPolicy === undefined ? "" : `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(contentSecurityPolicy)}">`}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Firedrill</title><style>${reportStyles}</style></head><body><main>${body}</main>${script === "" ? "" : `<script>${script}</script>`}</body></html>\n`;
}

function checkRows(checks: readonly AssertionResult[], evidence: readonly EvidenceEntry[]): string {
  if (checks.length === 0) return '<p class="empty">No final checks were evaluated.</p>';
  const sequences = new Set(evidence.map((entry) => entry.sequence));
  return `<div class="list">${checks
    .map(
      (check) =>
        `<details class="item"${check.status === "passed" ? "" : " open"}><summary><span class="tag ${escapeHtml(check.status)}">${escapeHtml(label(check.status))}</span><strong>${escapeHtml(label(check.assertionId))}</strong>${check.gate ? "" : '<span class="muted">Non-blocking</span>'}</summary><p>${escapeHtml(check.message)}</p><div class="columns comparison"><div><h3>Expected</h3><pre>${pretty(check.expected)}</pre></div><div><h3>Actual</h3><pre>${pretty(check.actual)}</pre></div></div>${check.location === undefined ? "" : `<details><summary>What this check inspects</summary><pre>${pretty(check.location)}</pre></details>`}<p class="muted">${check.evidenceSequences
          .filter((seq) => sequences.has(seq))
          .map((seq) => `<a href="#event-${seq}">Event ${seq}</a>`)
          .join(" · ")}</p></details>`,
    )
    .join("")}</div>`;
}

function overrideDetail(entry: Extract<EvidenceEntry, { kind: "operation" }>): string {
  const rule = entry.toolOverride;
  if (rule === undefined) return "";
  const source =
    rule.scope.kind === "scenario"
      ? `scenario ${rule.scope.scenarioId}`
      : rule.scope.kind === "drill" || rule.scope.kind === "run"
        ? `${rule.scope.kind} ${rule.scope.drillId}`
        : "world baseline";
  const action =
    rule.outcome === "original"
      ? "Used the tool's normal behavior"
      : rule.outcome === "error"
        ? "Returned a test error without running the tool"
        : "Returned a test value without running the tool";
  return `<p><strong>Override: ${escapeHtml(rule.id)}</strong> · ${escapeHtml(source)} · match ${rule.matchIndex}<br>${escapeHtml(action)}.</p>`;
}

function operations(evidence: readonly EvidenceEntry[]): string {
  const calls = evidence.filter((entry) => entry.kind === "operation");
  if (calls.length === 0)
    return '<p class="empty">No tool calls were recorded. This alone does not prove the agent was connected.</p>';
  return `<div class="list">${calls.map((entry, index) => `<details class="item"><summary><span class="call-number">${index + 1}.</span><strong>${escapeHtml(`${entry.invocation.operation.packageId}.${entry.invocation.operation.operationId}`)}</strong><span class="tag ${entry.outcome.status === "ok" ? "passed" : "failed"}">${escapeHtml(entry.outcome.status === "ok" ? "Success" : label(entry.outcome.status))}</span></summary><p class="muted">Actor ${escapeHtml(entry.actorId ?? "Not recorded")} · <a href="#event-${entry.sequence}">Event ${entry.sequence}</a></p>${overrideDetail(entry)}<div class="columns"><div><h3>Arguments sent</h3><pre>${pretty(entry.invocation.arguments)}</pre></div><div><h3>Response received</h3><pre>${pretty(entry.outcome)}</pre></div></div></details>`).join("")}</div>`;
}

function changes(evidence: readonly EvidenceEntry[]): string {
  const setupSequences = new Set(
    evidence
      .filter((entry) => entry.kind === "lifecycle" && entry.action === "world_created")
      .map((entry) => entry.sequence),
  );
  const entries = evidence.filter(
    (entry) =>
      entry.kind === "state_change" &&
      (entry.causeSequence === undefined || !setupSequences.has(entry.causeSequence)),
  );
  if (entries.length === 0)
    return '<p class="empty">No data changes were recorded after initial world creation.</p>';
  return `<div class="list">${entries.map((entry) => `<details class="item"><summary><strong>${escapeHtml(`${entry.packageId} / ${entry.namespace} / ${entry.rowId}`)}</strong><span class="muted">${escapeHtml(entry.change)}</span></summary><div class="columns"><div><h3>Before</h3><pre>${pretty(entry.before)}</pre></div><div><h3>After</h3><pre>${pretty(entry.after)}</pre></div></div><a href="#event-${entry.sequence}">Event ${entry.sequence}</a></details>`).join("")}</div>`;
}

function toolDetails(tools: readonly ReportToolDescriptor[]): string {
  return (
    tools
      .map(
        (tool) =>
          `<article class="item"><h3>${escapeHtml(tool.id)} <span class="muted">${escapeHtml(tool.version)}</span></h3><p>${tool.operations.map((operation) => `${escapeHtml(operation.id)} (${escapeHtml(operation.fidelity)})`).join(" · ")}</p>${tool.compatibility.map((profile) => `<details><summary>${escapeHtml(`${profile.client.name}@${profile.client.version}`)}</summary><p>${profile.routes.length} covered routes · ${escapeHtml(profile.mode)}</p><h3>Known limitations</h3><ul>${profile.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul><pre>${pretty(profile.routes)}</pre></details>`).join("")}<details><summary>Full tool declaration</summary><pre>${pretty(tool)}</pre></details></article>`,
      )
      .join("") || '<p class="empty">No tool declarations were attached to this report.</p>'
  );
}

interface DisplayAttachment {
  readonly attachment: TargetFileAttachment;
  readonly interactionId?: string | undefined;
  readonly kind?: string;
  readonly policy?: string;
}

function attachmentSection(result: RunResult, previews: ReadonlyMap<string, AttachmentPreview>): string {
  const files: readonly DisplayAttachment[] = [
    ...result.interactions.flatMap((interaction) =>
      interaction.targetResult.attachments.flatMap((attachment) =>
        attachment.kind === "file"
          ? [
              {
                attachment: TargetFileAttachmentSchema.parse(attachment),
                interactionId: interaction.interactionId,
              },
            ]
          : [],
      ),
    ),
    ...(result.capture?.attachments ?? []),
  ];
  const logs = result.interactions.flatMap((interaction) =>
    interaction.targetResult.attachments.flatMap((attachment) =>
      attachment.kind === "process.stderr" && typeof attachment.text === "string"
        ? [{ interactionId: interaction.interactionId, text: attachment.text }]
        : [],
    ),
  );
  if (files.length === 0 && logs.length === 0 && result.capture === undefined) return "";
  const fileItems = files
    .map(({ attachment, interactionId, kind, policy }) => {
      const path = `attachments/${attachment.id}/${attachment.name}`
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const download = `<a href="${escapeHtml(path)}" download="${escapeHtml(attachment.name)}">Download ${escapeHtml(attachment.name)}</a>`;
      const preview = previews.get(attachment.id);
      const display =
        preview?.kind === "image"
          ? `<img class="attachment-media" data-attachment-preview="image" src="${escapeHtml(path)}" alt="${escapeHtml(attachment.name)}" loading="lazy">`
          : preview?.kind === "video"
            ? `<video class="attachment-media" data-attachment-preview="video" src="${escapeHtml(path)}" aria-label="${escapeHtml(attachment.name)}" controls preload="metadata" playsinline>Your browser cannot play this recording. ${download}</video>`
            : preview?.kind === "text"
              ? `<pre class="attachment-log">${escapeHtml(kind === "log" ? readableCaptureLog(preview.content) : preview.content)}</pre>${preview.truncated ? '<p class="muted">Preview limited to the first 64 KiB. Download the complete file above.</p>' : ""}`
              : '<p class="muted">Inline preview is unavailable for this file. Download it to inspect its contents.</p>';
      const context = [
        ...(kind === undefined ? [] : [label(kind)]),
        ...(interactionId === undefined ? [] : [`Interaction ${interactionId}`]),
        ...(policy === undefined
          ? []
          : [policy === "retain-on-failure" ? "Retained on failure" : "Always retained"]),
      ]
        .map(escapeHtml)
        .join(" · ");
      return `<article class="item" id="attachment-${escapeHtml(attachment.id)}"><h3>${escapeHtml(attachment.name)}</h3>${context === "" ? "" : `<p class="muted">${context}</p>`}<p>${download} <span class="muted">· ${escapeHtml(attachment.mediaType)} · ${attachment.bytes} bytes</span></p><p class="muted">${attachment.redaction.status === "applied_by_caller" ? "Caller applied redaction before attachment" : "Copied verbatim without redaction"}${attachment.redaction.note === null ? "" : ` · ${escapeHtml(attachment.redaction.note)}`}</p>${display}</article>`;
    })
    .join("");
  const logItems = logs
    .map(
      (log) =>
        `<article class="item"><h3>Process stderr · ${escapeHtml(log.interactionId)}</h3><pre class="attachment-log">${escapeHtml(log.text.slice(0, 65_536))}</pre>${log.text.length > 65_536 ? '<p class="muted">Log preview truncated. The full captured text remains in the report data.</p>' : ""}</article>`,
    )
    .join("");
  const capture = result.capture;
  const captureInfo =
    capture === undefined
      ? ""
      : (() => {
          const policies = Object.entries(capture.policies)
            .filter(([, policy]) => policy !== "off")
            .map(
              ([kind, policy]) =>
                `${kind}: ${policy === "retain-on-failure" ? "retain on failure" : "always"}`,
            );
          const discarded = Object.entries(capture.discarded)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => `${count} ${kind}`);
          return `<p class="muted">${policies.length === 0 ? "Optional capture was disabled." : `Capture policies — ${escapeHtml(policies.join("; "))}.`}</p>${discarded.length === 0 ? "" : `<p class="muted">Discarded by retention policy: ${escapeHtml(discarded.join(", "))}.</p>`}${capture.errors.length === 0 ? "" : `<div class="failure"><h3>Capture errors</h3><p>These errors concern supporting files, not the world verdict.</p><ul class="capture-errors">${capture.errors.map((error) => `<li><code>${escapeHtml(error.code)}</code>: ${escapeHtml(error.message)}${error.interactionId === undefined ? "" : ` <span class="muted">(Interaction ${escapeHtml(error.interactionId)})</span>`}</li>`).join("")}</ul></div>`}`;
        })();
  return `<section id="attachments"><h2>Logs and attachments</h2><p class="hint">Supporting files and logs do not determine the test verdict. Files may contain sensitive data; review them before sharing.</p>${captureInfo}${files.length === 0 && logs.length === 0 ? '<p class="muted">No files or logs were retained.</p>' : `<div class="list">${logItems}${fileItems}</div>`}</section>`;
}

/** Presentation only. Metadata has passed redaction; file previews are explicitly verified, verbatim bytes. */
export function renderReportPage(input: {
  readonly result: RunResult;
  readonly evidence: readonly EvidenceEntry[];
  readonly tools: readonly ReportToolDescriptor[];
  readonly reproduce: string;
  readonly reproductionNote: string;
  readonly attachmentPreviews?: ReadonlyMap<string, AttachmentPreview>;
}): string {
  const { result, evidence, tools } = input;
  const outcome = result.status === "sealed" ? result.verdict : result.status;
  const passed = result.assertionResults.filter((check) => check.status === "passed").length;
  const calls = evidence.filter((entry) => entry.kind === "operation");
  const faultCheckpoints = result.checkpoints.filter((checkpoint) => checkpoint.kind !== "final");
  const attachments = attachmentSection(result, input.attachmentPreviews ?? new Map());
  const tasks = result.interactions
    .map(
      (interaction) =>
        `<article class="item"><h3>${escapeHtml(interaction.task.instruction)}</h3><p class="muted">Agent ${escapeHtml(result.identity.targetId)} · ${escapeHtml(label(interaction.targetResult.status))}</p>${interaction.targetResult.error === undefined ? "" : `<p class="failed">${escapeHtml(interaction.targetResult.error.message)}</p>`}${interaction.task.input === undefined ? "" : `<details><summary>Task input</summary><pre>${pretty(interaction.task.input)}</pre></details>`}${interaction.targetResult.output === undefined ? "" : `<details><summary>Agent output (not the test verdict)</summary><pre>${pretty(interaction.targetResult.output)}</pre></details>`}${interaction.targetResult.attachments
          .map((attachment) => {
            if (attachment.kind === "process.stderr" && typeof attachment.text === "string") return "";
            if (attachment.kind !== "file")
              return `<details><summary>Attachment</summary><pre>${pretty(attachment)}</pre></details>`;
            return `<p><a href="#attachment-${escapeHtml(attachment.id)}">View ${escapeHtml(attachment.name)}</a></p>`;
          })
          .join("")}</article>`,
    )
    .join("");
  const technical = `<details class="item"><summary><strong>Run details and limits</strong></summary><pre>${pretty({ runId: result.identity.runId, scenario: result.identity.scenarioId ?? "World baseline", build: result.identity.buildHash, seed: result.identity.seed, repeat: `${result.identity.trial} of ${result.identity.trialCount}`, attempt: `${result.identity.attempt} of ${result.identity.attemptLimit}`, bindingEvidence: result.bindingEvidence, virtualTimeUs: { start: result.startedAtVirtualUs, end: result.finishedAtVirtualUs }, budgets: result.budgetUsage })}</pre><p class="muted">Virtual time is the world’s simulated clock, not elapsed execution time.</p></details>`;
  return reportDocument(
    `${result.identity.drillId} · report`,
    `<header><span class="brand">Firedrill / Drill report</span><div class="title-row"><h1>${escapeHtml(label(result.identity.drillId))}</h1><span class="outcome ${escapeHtml(outcome)}">${escapeHtml(label(outcome))}</span></div><p class="hint">One execution of a drill: the task your agent received, the checks evaluated, and what happened in its synthetic world.</p><div class="facts"><span><strong>${passed}/${result.assertionResults.length}</strong> final checks passed</span><span><strong>${calls.length}</strong> tool calls</span><span>Scenario: ${escapeHtml(result.identity.scenarioId ?? "World baseline")}</span></div></header><nav aria-label="Report sections"><a href="#task">Task</a><a href="#checks">Checks</a><a href="#actions">Tool calls</a><a href="#changes">Data changes</a>${attachments === "" ? "" : '<a href="#attachments">Logs and attachments</a>'}<a href="#details">Details</a></nav>
${result.status === "runner_failed" ? `<section class="failure"><h2>Could not finish the drill</h2><p>${escapeHtml(result.error.message)}</p><code>${escapeHtml(result.error.code)}</code></section>` : result.status === "cancelled" ? `<section class="failure"><h2>Run cancelled</h2><p>${escapeHtml(result.reason)}</p></section>` : ""}
<section id="task"><h2>Task</h2><div class="list">${tasks || '<p class="empty">The run ended before an agent interaction started.</p>'}</div></section>
<section id="checks"><h2>Checks</h2><p class="hint">Assertions compare observed actions and world data with your expectations. Agent output is not treated as proof.</p>${checkRows(result.assertionResults, evidence)}${faultCheckpoints.length === 0 ? "" : `<details class="item"${faultCheckpoints.some((checkpoint) => checkpoint.verdict === "failed") ? " open" : ""}><summary>Checks evaluated during execution (${faultCheckpoints.length} checkpoints)</summary>${faultCheckpoints.map((checkpoint) => `<h3>${escapeHtml(label(checkpoint.kind))} · virtual time ${checkpoint.virtualTimeUs} μs</h3>${checkRows(checkpoint.assertionResults, evidence)}`).join("")}</details>`}</section>
<section id="actions"><h2>Tool calls</h2><p class="hint">Calls received by the synthetic tools, in recorded order. Expand a call to see its arguments and response.</p>${operations(evidence)}</section>
<section id="changes"><h2>Data changes</h2><p class="hint">Changes after world creation. Initial seed records are available in the full event log below.</p>${changes(evidence)}</section>
${attachments}
<section id="details"><h2>Details</h2><div class="list">${technical}${
      evidence.some((entry) => entry.kind === "fault_control")
        ? `<details class="item"><summary><strong>Runtime fault controls</strong></summary>${evidence
            .filter((entry) => entry.kind === "fault_control")
            .map(
              (entry) =>
                `<p>${escapeHtml(entry.packageId)}.${escapeHtml(entry.faultId)} · ${entry.active ? "enabled" : "disabled"}${entry.previouslyActive === entry.active ? " (unchanged)" : ""}</p>`,
            )
            .join("")}</details>`
        : ""
    }<details class="item"><summary><strong>Synthetic tools used by this world</strong></summary>${toolDetails(tools)}</details>${result.setup === undefined ? "" : `<details class="item"><summary>Test-local setup</summary><pre>${pretty(result.setup)}</pre></details>`}<details class="item"><summary><strong>Full event log (${evidence.length} entries)</strong></summary><p class="muted">Includes setup, tool calls, timers, data changes, and verification. Event numbers refer to this log.</p>${evidence.map((entry) => `<details id="event-${entry.sequence}" class="item"><summary>Event ${entry.sequence} · ${escapeHtml(label(entry.kind))}</summary><pre>${pretty(entry)}</pre></details>`).join("")}</details></div></section>
<section><h2>Run again</h2><pre>${escapeHtml(input.reproduce)}</pre><p class="hint">${escapeHtml(input.reproductionNote)}</p></section><footer>Reports can contain sensitive synthetic inputs and agent output. Review them before sharing. Passing means the configured checks passed—not that every possible behavior is safe.</footer>`,
    "",
    "default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'none'",
  );
}
