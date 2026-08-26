import {
  Activity,
  Ban,
  Braces,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  GitCompareArrows,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Webhook,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { inspectorApi } from "../api";
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  InlineMessage,
  KeyValue,
  SearchField,
  Select,
  Spinner,
  Status,
} from "../components/primitives";
import { compactId, evidenceLabel, json, plural, titleFromId, virtualTime } from "../format";
import type {
  EvidenceEntry,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunRequest,
  SimulationRunSummary,
  SimulationStatePage,
  StartSimulationRun,
  StateNamespace,
} from "../types";

function resultTone(value?: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (value === "passed") return "success";
  if (value === "failed" || value === "runner_failed") return "danger";
  if (value === "inconclusive" || value === "cancelling") return "warning";
  if (value === "running") return "info";
  return "neutral";
}

function resultLabel(run: SimulationRunSummary): string {
  if (run.verdict !== undefined) return titleFromId(run.verdict);
  return titleFromId(run.status);
}

function eventTone(entry: EvidenceEntry): "success" | "warning" | "danger" | "info" | "neutral" {
  if (entry.kind === "fault") return "danger";
  if (entry.kind === "verification") return resultTone(entry.result.status);
  if (entry.kind === "operation") return resultTone(entry.outcome.status === "ok" ? "passed" : "failed");
  if (entry.kind === "callback" && entry.phase === "failed") return "danger";
  if (entry.kind === "event" && entry.phase === "failed") return "danger";
  if (entry.kind === "state_change") return "info";
  return "neutral";
}

function EventIcon({ kind }: { readonly kind: EvidenceEntry["kind"] }) {
  const Icon =
    kind === "operation"
      ? Wrench
      : kind === "state_change"
        ? Database
        : kind === "event"
          ? Radio
          : kind === "callback"
            ? Webhook
            : kind === "fault"
              ? TriangleAlert
              : kind === "clock"
                ? Clock3
                : kind === "verification"
                  ? ShieldCheck
                  : kind === "lifecycle"
                    ? Activity
                    : Braces;
  return <Icon size={15} aria-hidden="true" />;
}

function EventInspector({ entry }: { readonly entry: EvidenceEntry | undefined }) {
  if (entry === undefined) {
    return (
      <aside className="fd-selection-inspector">
        <EmptyState title="Select an evidence entry">
          Choose an item in the causal timeline to inspect it.
        </EmptyState>
      </aside>
    );
  }
  return (
    <aside className="fd-selection-inspector">
      <div className="fd-inspector-head">
        <div>
          <strong>{evidenceLabel(entry)}</strong>
          <code>event {entry.sequence}</code>
        </div>
        <Status tone={eventTone(entry)}>{titleFromId(entry.kind)}</Status>
      </div>
      <div className="fd-inspector-scroll">
        <section className="fd-inspector-section">
          <h3>Causality</h3>
          <dl>
            <KeyValue label="Sequence" mono>
              {entry.sequence}
            </KeyValue>
            <KeyValue label="Cause" mono>
              {entry.causeSequence ?? "Root"}
            </KeyValue>
            <KeyValue label="Transaction" mono>
              {compactId(entry.transactionId, 18)}
            </KeyValue>
            <KeyValue label="Virtual time" mono>
              {virtualTime(entry.virtualTimeUs)}
            </KeyValue>
            <KeyValue label="Correlation" mono>
              {compactId(entry.correlationId, 18)}
            </KeyValue>
          </dl>
        </section>
        {entry.kind === "state_change" ? (
          <section className="fd-inspector-section">
            <h3>State consequence</h3>
            <div className="fd-diff-stack">
              <div data-diff="removed">
                <span>Before</span>
                <CodeBlock>{json(entry.before)}</CodeBlock>
              </div>
              <div data-diff="added">
                <span>After</span>
                <CodeBlock>{json(entry.after)}</CodeBlock>
              </div>
            </div>
          </section>
        ) : null}
        {entry.kind === "operation" ? (
          <section className="fd-inspector-section">
            <h3>Tool exchange</h3>
            <dl>
              <KeyValue label="Outcome">{titleFromId(entry.outcome.status)}</KeyValue>
              <KeyValue label="Idempotency">{titleFromId(entry.idempotency)}</KeyValue>
              <KeyValue label="Actor" mono>
                {entry.actorId ?? "Unbound"}
              </KeyValue>
            </dl>
            <details className="fd-disclosure">
              <summary>Arguments and result</summary>
              <CodeBlock>{json({ invocation: entry.invocation, outcome: entry.outcome })}</CodeBlock>
            </details>
          </section>
        ) : null}
        {entry.kind === "verification" ? (
          <section className="fd-inspector-section">
            <h3>Assertion result</h3>
            <Status tone={resultTone(entry.result.status)}>{titleFromId(entry.result.status)}</Status>
            <p className="fd-inspector-copy">{entry.result.message}</p>
            <div className="fd-diff-stack">
              <div data-diff="removed">
                <span>Expected</span>
                <CodeBlock>{json(entry.result.expected)}</CodeBlock>
              </div>
              <div data-diff="added">
                <span>Actual</span>
                <CodeBlock>{json(entry.result.actual)}</CodeBlock>
              </div>
            </div>
          </section>
        ) : null}
        <section className="fd-inspector-section">
          <details className="fd-disclosure">
            <summary>Raw evidence</summary>
            <CodeBlock>{json(entry)}</CodeBlock>
          </details>
        </section>
      </div>
    </aside>
  );
}

function StateBrowser({
  runId,
  namespaces,
  onError,
}: {
  readonly runId: string;
  readonly namespaces: readonly StateNamespace[];
  readonly onError: (message: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const [page, setPage] = useState<SimulationStatePage>();
  const [loading, setLoading] = useState(false);
  const selected = namespaces.find((item) => `${item.packageId}:${item.namespace}` === selectedKey);

  const load = async (namespace: StateNamespace, after?: string) => {
    setLoading(true);
    try {
      const result = await inspectorApi.state(runId, namespace.packageId, namespace.namespace, after);
      setPage((current) =>
        after === undefined || current === undefined
          ? result
          : { ...result, records: [...current.records, ...result.records] },
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "State could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  if (namespaces.length === 0) return null;
  return (
    <section className="fd-run-section">
      <div className="fd-section-heading">
        <div>
          <h3>Retained world state</h3>
          <p>Queryable state from this run's isolated SQLite world.</p>
        </div>
        <Select
          label="State namespace"
          value={selectedKey ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            setSelectedKey(next || undefined);
            setPage(undefined);
            const namespace = namespaces.find((item) => `${item.packageId}:${item.namespace}` === next);
            if (namespace !== undefined) void load(namespace);
          }}
        >
          <option value="">Choose state</option>
          {namespaces.map((namespace) => (
            <option
              key={`${namespace.packageId}:${namespace.namespace}`}
              value={`${namespace.packageId}:${namespace.namespace}`}
            >
              {namespace.packageId}.{namespace.namespace} ({namespace.records})
            </option>
          ))}
        </Select>
      </div>
      {loading && page === undefined ? (
        <div className="fd-subtle-loading">
          <Spinner label="Loading state" /> Loading state…
        </div>
      ) : null}
      {page !== undefined ? (
        <div className="fd-state-table-wrap">
          <table className="fd-table fd-state-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {page.records.map((record) => (
                <tr key={record.rowId}>
                  <td>
                    <code>{record.rowId}</code>
                  </td>
                  <td>
                    <pre>{json(record.value)}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.records.length === 0 ? (
            <div className="fd-table-empty">This namespace has no rows.</div>
          ) : null}
          {page.nextRowId === undefined || selected === undefined ? null : (
            <div className="fd-load-more">
              <Button size="compact" onClick={() => void load(selected, page.nextRowId)} disabled={loading}>
                {loading ? <Spinner label="Loading more state" /> : null}
                Load more rows
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeWork({ detail }: { readonly detail: SimulationRunDetail }) {
  const pendingEvents = detail.scheduledEvents.filter((event) => event.status === "pending");
  const unresolvedCallbacks = detail.callbackDeliveries.filter((delivery) =>
    ["pending", "in_flight", "failed"].includes(delivery.status),
  );
  const total = detail.faults.length + pendingEvents.length + unresolvedCallbacks.length;
  if (total === 0) return null;
  return (
    <details className="fd-runtime-work">
      <summary>
        World runtime
        <span>
          {plural(detail.faults.length, "active fault")} · {plural(pendingEvents.length, "pending event")} ·{" "}
          {plural(unresolvedCallbacks.length, "unresolved callback")}
        </span>
      </summary>
      <div className="fd-runtime-work__body">
        {detail.faults.length === 0 ? null : (
          <section>
            <h4>Active faults</h4>
            <ul>
              {detail.faults.map((fault) => (
                <li key={`${fault.packageId}:${fault.faultId}`}>
                  <code>
                    {fault.packageId}.{fault.faultId}
                  </code>
                </li>
              ))}
            </ul>
          </section>
        )}
        {pendingEvents.length === 0 ? null : (
          <section>
            <h4>Pending events</h4>
            <ul>
              {pendingEvents.map((event) => (
                <li key={event.id}>
                  <code>
                    {event.event.packageId}.{event.event.eventId}
                  </code>
                  <span>due {virtualTime(event.dueUs)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {unresolvedCallbacks.length === 0 ? null : (
          <section>
            <h4>Callback deliveries</h4>
            <ul>
              {unresolvedCallbacks.map((delivery) => (
                <li key={delivery.id}>
                  <code>
                    {delivery.callback.packageId}.{delivery.callback.callbackId}
                  </code>
                  <span>
                    {titleFromId(delivery.status)} · {plural(delivery.attemptCount, "attempt")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}

function changedLabel(value: boolean | undefined): string {
  if (value === undefined) return "Not available";
  return value ? "Changed" : "Unchanged";
}

function ComparisonDialog({
  runs,
  selectedRunId,
  onClose,
  onError,
}: {
  readonly runs: readonly SimulationRunSummary[];
  readonly selectedRunId: string | undefined;
  readonly onClose: () => void;
  readonly onError: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const eligible = runs.filter((run) => run.reportAvailable);
  const candidateDefault = eligible.find((run) => run.runId === selectedRunId) ?? eligible[0];
  const baselineDefault = eligible.find((run) => run.runId !== candidateDefault?.runId);
  const [baselineRunId, setBaselineRunId] = useState(baselineDefault?.runId ?? "");
  const [candidateRunId, setCandidateRunId] = useState(candidateDefault?.runId ?? "");
  const [comparison, setComparison] = useState<SimulationRunComparison>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const compare = async () => {
    setLoading(true);
    try {
      setComparison(await inspectorApi.compareRuns(baselineRunId, candidateRunId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "The runs could not be compared.");
    } finally {
      setLoading(false);
    }
  };

  const deltas =
    comparison === undefined
      ? []
      : [
          ...comparison.changes.operationCounts.map((item) => ({ kind: "Operation", ...item })),
          ...comparison.changes.stateChangeCounts.map((item) => ({ kind: "State change", ...item })),
          ...comparison.changes.eventCounts.map((item) => ({ kind: "Event", ...item })),
        ];

  return (
    <dialog
      ref={dialog}
      className="fd-dialog fd-compare-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!loading) onClose();
      }}
      onClose={() => {
        if (!loading) onClose();
      }}
    >
      <div className="fd-dialog__head">
        <div>
          <h2>Compare drill runs</h2>
          <code>Verified local reports</code>
        </div>
        <Button variant="quiet" size="compact" onClick={onClose} disabled={loading}>
          Close
        </Button>
      </div>
      <div className="fd-compare-fields">
        <div className="fd-field">
          <span>Baseline</span>
          <Select
            label="Baseline run"
            value={baselineRunId}
            onChange={(event) => {
              setBaselineRunId(event.target.value);
              setComparison(undefined);
            }}
          >
            {eligible.map((run) => (
              <option key={run.runId} value={run.runId} disabled={run.runId === candidateRunId}>
                {titleFromId(run.drillId)} · {compactId(run.runId, 16)} · seed {run.seed}
              </option>
            ))}
          </Select>
        </div>
        <div className="fd-field">
          <span>Candidate</span>
          <Select
            label="Candidate run"
            value={candidateRunId}
            onChange={(event) => {
              setCandidateRunId(event.target.value);
              setComparison(undefined);
            }}
          >
            {eligible.map((run) => (
              <option key={run.runId} value={run.runId} disabled={run.runId === baselineRunId}>
                {titleFromId(run.drillId)} · {compactId(run.runId, 16)} · seed {run.seed}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant="primary"
          onClick={() => void compare()}
          disabled={
            loading || baselineRunId === "" || candidateRunId === "" || baselineRunId === candidateRunId
          }
        >
          {loading ? <Spinner label="Comparing runs" /> : <GitCompareArrows size={16} />}
          Compare
        </Button>
      </div>
      {comparison === undefined ? (
        <div className="fd-compare-empty">
          Choose two sealed runs. Firedrill reports factual differences and whether their inputs are
          compatible.
        </div>
      ) : (
        <div className="fd-compare-result">
          <InlineMessage
            tone={
              comparison.compatibility.status === "exact_inputs"
                ? "success"
                : comparison.compatibility.status === "descriptive_only"
                  ? "warning"
                  : "danger"
            }
            title={titleFromId(comparison.compatibility.status)}
          >
            {comparison.compatibility.explanation}
          </InlineMessage>
          <dl className="fd-compare-summary">
            <KeyValue label="Outcome">{titleFromId(comparison.outcome)}</KeyValue>
            <KeyValue label="Verdict">{changedLabel(comparison.changes.verdictChanged)}</KeyValue>
            <KeyValue label="State">{changedLabel(comparison.changes.stateChanged)}</KeyValue>
            <KeyValue label="Trajectory">{changedLabel(comparison.changes.trajectoryChanged)}</KeyValue>
          </dl>
          {deltas.length === 0 ? null : (
            <section>
              <h3>Count differences</h3>
              <table className="fd-table fd-compare-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Subject</th>
                    <th>Baseline</th>
                    <th>Candidate</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {deltas.map((delta) => (
                    <tr key={`${delta.kind}:${delta.subject}`}>
                      <td>{delta.kind}</td>
                      <td>
                        <code>{delta.subject}</code>
                      </td>
                      <td>{delta.baseline}</td>
                      <td>{delta.candidate}</td>
                      <td>{delta.delta > 0 ? `+${delta.delta}` : delta.delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {comparison.changes.assertions.length === 0 ? null : (
            <section>
              <h3>Assertion differences</h3>
              <ul className="fd-compare-list">
                {comparison.changes.assertions.map((assertion) => (
                  <li key={`${assertion.checkpointId}:${assertion.assertionId}`}>
                    <code>{assertion.assertionId}</code>
                    <span>
                      {titleFromId(assertion.baseline ?? "missing")} →{" "}
                      {titleFromId(assertion.candidate ?? "missing")}
                      {assertion.actualChanged ? " · actual value changed" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </dialog>
  );
}

function RunWorkspace({
  summary,
  onCancel,
  cancelling,
  onOpenReport,
  onRerun,
  starting,
  onError,
}: {
  readonly summary: SimulationRunSummary;
  readonly onCancel: (requestId: string) => void;
  readonly cancelling: boolean;
  readonly onOpenReport: (runId: string) => void;
  readonly onRerun: (input: StartSimulationRun) => void;
  readonly starting: boolean;
  readonly onError: (message: string) => void;
}) {
  const [detail, setDetail] = useState<SimulationRunDetail>();
  const [entries, setEntries] = useState<readonly EvidenceEntry[]>([]);
  const [nextSequence, setNextSequence] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedSequence, setSelectedSequence] = useState<number>();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setEntries([]);
    setNextSequence(1);
    setSelectedSequence(undefined);
    Promise.all([inspectorApi.run(summary.runId), inspectorApi.evidence(summary.runId, 1, 300)])
      .then(([nextDetail, page]) => {
        if (!current) return;
        setDetail(nextDetail);
        setEntries(page.entries);
        setNextSequence(page.nextSequence);
        setSelectedSequence(page.entries.at(-1)?.sequence);
      })
      .catch((error: unknown) => {
        if (current) onError(error instanceof Error ? error.message : "Run evidence could not be loaded.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [summary.runId, onError]);

  useEffect(() => {
    if (loading || nextSequence > summary.evidenceSequence) return;
    let current = true;
    Promise.all([
      inspectorApi.run(summary.runId),
      inspectorApi.evidence(
        summary.runId,
        nextSequence,
        Math.min(300, summary.evidenceSequence - nextSequence + 1),
      ),
    ])
      .then(([nextDetail, page]) => {
        if (!current) return;
        setDetail(nextDetail);
        if (page.entries.length > 0) {
          setEntries((value) => [...value, ...page.entries]);
          setNextSequence(page.nextSequence);
          setSelectedSequence((value) => value ?? page.entries.at(-1)?.sequence);
        }
      })
      .catch((error: unknown) => {
        if (current) onError(error instanceof Error ? error.message : "Live evidence could not be updated.");
      });
    return () => {
      current = false;
    };
  }, [loading, nextSequence, onError, summary.evidenceSequence, summary.runId]);

  useEffect(() => {
    if (summary.status === detail?.summary.status) return;
    void inspectorApi
      .run(summary.runId)
      .then(setDetail)
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : "Run detail could not be updated."),
      );
  }, [detail?.summary.status, onError, summary.runId, summary.status]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await inspectorApi.evidence(summary.runId, nextSequence, 300);
      setEntries((value) => [...value, ...page.entries]);
      setNextSequence(page.nextSequence);
    } catch (error) {
      onError(error instanceof Error ? error.message : "More evidence could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    const search = `${entry.kind} ${evidenceLabel(entry)} ${entry.sequence}`.toLowerCase();
    return search.includes(query.toLowerCase());
  });
  const selected = entries.find((entry) => entry.sequence === selectedSequence);
  const assertions = detail?.result?.assertionResults ?? [];

  return (
    <>
      <div className="fd-workspace-main fd-run-main">
        <div className="fd-run-titlebar">
          <div>
            <div className="fd-run-titleline">
              <h2>{titleFromId(summary.drillId)}</h2>
              <Status tone={resultTone(summary.verdict ?? summary.status)}>{resultLabel(summary)}</Status>
            </div>
            <p>
              <code>{summary.runId}</code> · seed <code>{summary.seed}</code> · trial {summary.trial}/
              {summary.trialCount}
            </p>
          </div>
          <div className="fd-run-actions">
            {summary.reportAvailable ? (
              <>
                <Button
                  size="compact"
                  onClick={() => onRerun({ drillId: summary.drillId, seed: summary.seed })}
                  disabled={starting}
                >
                  {starting ? <Spinner label="Starting drill" /> : <RotateCcw size={15} />}
                  Rerun seed
                </Button>
                <Button size="compact" onClick={() => onOpenReport(summary.runId)}>
                  <FileText size={15} /> Open report
                </Button>
              </>
            ) : null}
            {summary.requestId !== undefined && ["running", "cancelling"].includes(summary.status) ? (
              <Button
                variant="danger"
                size="compact"
                onClick={() => setConfirmCancel(true)}
                disabled={summary.status === "cancelling"}
              >
                <Ban size={15} /> {summary.status === "cancelling" ? "Cancelling" : "Cancel"}
              </Button>
            ) : null}
          </div>
        </div>
        {loading ? (
          <div className="fd-subtle-loading fd-subtle-loading--fill">
            <Spinner label="Loading run" /> Loading evidence…
          </div>
        ) : (
          <>
            <div className="fd-run-trust-row">
              <span>
                Binding <strong>{titleFromId(detail?.result?.bindingEvidence ?? "not_checked")}</strong>
              </span>
              <span>
                Consistency <strong>{titleFromId(detail?.result?.worldConsistency ?? "unknown")}</strong>
              </span>
              <span>
                Virtual time <strong>{virtualTime(summary.virtualTimeUs)}</strong>
              </span>
              <span>
                Evidence <strong>{summary.evidenceSequence.toLocaleString()}</strong>
              </span>
            </div>
            {detail === undefined ? null : <RuntimeWork detail={detail} />}
            <section className="fd-timeline-section">
              <div className="fd-timeline-toolbar">
                <div>
                  <h3>Causal evidence</h3>
                  <span>{plural(entries.length, "loaded entry", "loaded entries")}</span>
                </div>
                <SearchField
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find evidence"
                />
                <Select label="Evidence kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="all">All evidence</option>
                  <option value="operation">Operations</option>
                  <option value="state_change">State changes</option>
                  <option value="verification">Assertions</option>
                  <option value="event">Events</option>
                  <option value="callback">Callbacks</option>
                  <option value="fault">Faults</option>
                  <option value="clock">Clock</option>
                  <option value="lifecycle">Lifecycle</option>
                </Select>
              </div>
              <div className="fd-timeline">
                {filtered.map((entry) => (
                  <button
                    type="button"
                    className="fd-timeline-entry"
                    key={entry.sequence}
                    aria-current={selectedSequence === entry.sequence ? "true" : undefined}
                    onClick={() => setSelectedSequence(entry.sequence)}
                  >
                    <span className="fd-timeline-entry__sequence">{entry.sequence}</span>
                    <span className="fd-timeline-entry__mark" data-tone={eventTone(entry)}>
                      <EventIcon kind={entry.kind} />
                    </span>
                    <span className="fd-timeline-entry__body">
                      <strong>{evidenceLabel(entry)}</strong>
                      <small>
                        {titleFromId(entry.kind)} · {virtualTime(entry.virtualTimeUs)}
                      </small>
                    </span>
                    {entry.causeSequence === undefined ? null : (
                      <span className="fd-timeline-entry__cause">← {entry.causeSequence}</span>
                    )}
                  </button>
                ))}
                {filtered.length === 0 ? (
                  <div className="fd-table-empty">No evidence matches these filters.</div>
                ) : null}
              </div>
              {nextSequence <= summary.evidenceSequence ? (
                <div className="fd-load-more">
                  <Button size="compact" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? <Spinner label="Loading more evidence" /> : null}
                    Load more evidence
                  </Button>
                </div>
              ) : null}
            </section>
            {assertions.length > 0 ? (
              <section className="fd-run-section">
                <div className="fd-section-heading">
                  <div>
                    <h3>Assertions</h3>
                    <p>Final checks against state and evidence.</p>
                  </div>
                </div>
                <div className="fd-assertion-list">
                  {assertions.map((assertion) => (
                    <button
                      type="button"
                      key={assertion.assertionId}
                      onClick={() => setSelectedSequence(assertion.evidenceSequences.at(-1))}
                      disabled={assertion.evidenceSequences.length === 0}
                    >
                      {assertion.status === "passed" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                      <span>
                        <strong>{titleFromId(assertion.assertionId)}</strong>
                        <small>{assertion.message}</small>
                      </span>
                      <Status tone={resultTone(assertion.status)}>{titleFromId(assertion.status)}</Status>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {detail === undefined ? null : (
              <StateBrowser
                key={summary.runId}
                runId={summary.runId}
                namespaces={detail.stateNamespaces}
                onError={onError}
              />
            )}
          </>
        )}
      </div>
      <EventInspector entry={selected} />
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this drill run?"
        description="The target is asked to stop and the partial world evidence remains available. Completed work is not deleted."
        confirmLabel="Cancel run"
        busy={cancelling}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          if (summary.requestId !== undefined) onCancel(summary.requestId);
        }}
      />
    </>
  );
}

export function RunsView({
  runs,
  requests,
  starting,
  cancelling,
  onCancel,
  onRerun,
  onOpenReport,
  onNavigateDrills,
  onError,
}: {
  readonly runs: readonly SimulationRunSummary[];
  readonly requests: readonly SimulationRunRequest[];
  readonly starting: boolean;
  readonly cancelling: boolean;
  readonly onCancel: (requestId: string) => void;
  readonly onRerun: (input: StartSimulationRun) => void;
  readonly onOpenReport: (runId: string) => void;
  readonly onNavigateDrills: () => void;
  readonly onError: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(runs[0]?.runId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [compareOpen, setCompareOpen] = useState(false);
  const selected = runs.find((run) => run.runId === selectedId) ?? runs[0];
  const activeRequests = requests.filter((request) =>
    ["starting", "running", "cancelling"].includes(request.status),
  );
  const filtered = runs.filter((run) => {
    if (status !== "all" && (run.verdict ?? run.status) !== status) return false;
    return `${run.drillId} ${run.runId} ${run.seed}`.toLowerCase().includes(query.toLowerCase());
  });

  useEffect(() => {
    if (selectedId === undefined && runs[0] !== undefined) setSelectedId(runs[0].runId);
  }, [runs, selectedId]);

  if (runs.length === 0 && activeRequests.length === 0) {
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <div>
            <h1>Runs</h1>
            <p>Live and sealed evidence from local drills.</p>
          </div>
        </header>
        <EmptyState
          title="No drill runs yet"
          action={
            <Button variant="primary" onClick={onNavigateDrills}>
              <Play size={16} /> Choose a drill
            </Button>
          }
        >
          Run a drill to inspect the target's Tool calls, world-state changes, assertions, and report.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <div>
          <h1>Runs</h1>
          <p>
            {plural(runs.length, "retained run")} · {plural(activeRequests.length, "active request")}
          </p>
        </div>
        {runs.filter((run) => run.reportAvailable).length > 1 ? (
          <Button onClick={() => setCompareOpen(true)}>
            <GitCompareArrows size={16} /> Compare runs
          </Button>
        ) : null}
      </header>
      {activeRequests.some((request) => request.runIds.length === 0) ? (
        <InlineMessage tone="info">
          Firedrill is preparing an isolated world for the selected drill.
        </InlineMessage>
      ) : null}
      <div className="fd-workspace fd-run-workspace">
        <aside className="fd-workspace-rail fd-run-rail">
          <div className="fd-rail-head">
            <strong>Runs</strong>
            <span>{runs.length}</span>
          </div>
          <div className="fd-run-filters">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a run"
            />
            <Select label="Run result" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All results</option>
              <option value="running">Running</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="inconclusive">Inconclusive</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </div>
          <div className="fd-rail-list">
            {filtered.map((run) => (
              <button
                type="button"
                className="fd-run-list-item"
                key={run.runId}
                aria-current={selected?.runId === run.runId ? "true" : undefined}
                onClick={() => setSelectedId(run.runId)}
              >
                <span className="fd-run-list-item__top">
                  <strong>{titleFromId(run.drillId)}</strong>
                  <Status tone={resultTone(run.verdict ?? run.status)}>{resultLabel(run)}</Status>
                </span>
                <code>{compactId(run.runId, 19)}</code>
                <span className="fd-run-list-item__meta">
                  Seed {run.seed} · trial {run.trial}/{run.trialCount}
                </span>
              </button>
            ))}
          </div>
          {filtered.length === 0 ? <div className="fd-rail-empty">No runs match these filters.</div> : null}
        </aside>
        {selected === undefined ? (
          <EmptyState title="Run is starting">
            The first live attempt will appear here when its world is ready.
          </EmptyState>
        ) : (
          <RunWorkspace
            summary={selected}
            onCancel={onCancel}
            onRerun={onRerun}
            starting={starting}
            cancelling={cancelling}
            onOpenReport={onOpenReport}
            onError={onError}
          />
        )}
      </div>
      {compareOpen ? (
        <ComparisonDialog
          runs={runs}
          selectedRunId={selected?.runId}
          onClose={() => setCompareOpen(false)}
          onError={onError}
        />
      ) : null}
    </section>
  );
}
