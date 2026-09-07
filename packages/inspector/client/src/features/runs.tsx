import {
  Activity,
  Ban,
  Braces,
  ChevronRight,
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
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { inspectorApi } from "../api";
import { DataViewer } from "../components/data-viewer";
import { DetailsPanel, DetailsTrigger } from "../components/details-panel";
import { PageIntro } from "../components/page-intro";
import { ScrollArea } from "../components/scroll-area";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  InlineMessage,
  KeyValue,
  RowButton,
  SearchField,
  Select,
  Spinner,
  Status,
} from "../components/primitives";
import { compactId, evidenceLabel, plural, titleFromId, virtualTime } from "../format";
import { evidenceSearchText, matchesSearch, preferredEvidenceSequence, runSearchText } from "../search";
import type {
  EvidenceEntry,
  SimulationProject,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunSummary,
  SimulationStatePage,
  StartSimulationRun,
  StateNamespace,
} from "../types";
import "./runs.css";

type RunResult = NonNullable<SimulationRunDetail["result"]>;
type CheckResult = RunResult["assertionResults"][number];

function ResultValue({ title, value }: { readonly title: string; readonly value: unknown }) {
  if (value !== null && typeof value === "object") {
    return <DataViewer title={title} value={value} label="View value" />;
  }
  return (
    <span className="fd-result-value">{value === undefined ? "Not recorded" : JSON.stringify(value)}</span>
  );
}

function ExpectedValue({ value, kind }: { readonly value: unknown; readonly kind: CheckResult["kind"] }) {
  const usesComparison = [
    "state.value",
    "state.count",
    "operation.count",
    "event.count",
    "callback.count",
  ].includes(kind);
  if (usesComparison && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const comparison = value as Record<string, unknown>;
    const labels: Readonly<Record<string, string>> = {
      equals: "Equals",
      not_equals: "Does not equal",
      greater_than_or_equal: "At least",
      less_than_or_equal: "At most",
      one_of: "One of",
    };
    const label = typeof comparison.operator === "string" ? labels[comparison.operator] : undefined;
    if (label !== undefined && Object.hasOwn(comparison, "value") && Object.keys(comparison).length === 2) {
      return (
        <div className="fd-result-expectation">
          <span>{label}</span>
          <ResultValue title="Expected value" value={comparison.value} />
        </div>
      );
    }
  }
  return <ResultValue title="Expected value" value={value} />;
}

function CheckComparison({ assertion }: { readonly assertion: CheckResult }) {
  return (
    <dl className="fd-result-comparison">
      <div>
        <dt>Expected</dt>
        <dd>
          <ExpectedValue value={assertion.expected} kind={assertion.kind} />
        </dd>
      </div>
      <div>
        <dt>Actual</dt>
        <dd>
          <ResultValue title="Actual value" value={assertion.actual} />
        </dd>
      </div>
    </dl>
  );
}

function CheckItem({ assertion }: { readonly assertion: CheckResult }) {
  return (
    <details className="fd-result-check" open={assertion.status === "failed"}>
      <summary>
        <span className="fd-result-check__label">
          <ChevronRight size={15} aria-hidden="true" />
          <strong>{titleFromId(assertion.assertionId)}</strong>
        </span>
        <Status tone={resultTone(assertion.status)}>{titleFromId(assertion.status)}</Status>
      </summary>
      <p>{assertion.message}</p>
      <CheckComparison assertion={assertion} />
      <div className="fd-result-actions">
        <DataViewer title={`Check: ${assertion.assertionId}`} value={assertion} label="Check details" />
        {assertion.gate ? null : <span>This check does not determine the run’s verdict.</span>}
      </div>
    </details>
  );
}

function UnavailableReports({ reports }: { readonly reports: SimulationRunList["unavailable"] }) {
  if (reports.length === 0) return null;
  const unsupported = reports.every((report) => report.code === "reporter.VERSION_UNSUPPORTED");
  return (
    <div className="fd-unavailable-reports">
      <p>
        {plural(reports.length, "saved report")}{" "}
        {unsupported
          ? `${reports.length === 1 ? "uses" : "use"} an unsupported format.`
          : "could not be opened."}
      </p>
      <DataViewer title="Reports that could not be opened" value={reports} label="View details" />
    </div>
  );
}

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
      <div className="fd-details-content">
        <EmptyState title="Select an activity">
          Choose a tool call or event to inspect its details.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="fd-details-content">
      <div className="fd-inspector-head">
        <div>
          <strong>{evidenceLabel(entry)}</strong>
        </div>
      </div>
      <ScrollArea label="Event details" resetKey={String(entry.sequence)}>
        {entry.kind === "state_change" ? (
          <section className="fd-inspector-section">
            <h3>Data changed</h3>
            <dl className="fd-result-comparison">
              <div>
                <dt>Before</dt>
                <dd>
                  <ResultValue title="Record before this change" value={entry.before} />
                </dd>
              </div>
              <div>
                <dt>After</dt>
                <dd>
                  <ResultValue title="Record after this change" value={entry.after} />
                </dd>
              </div>
            </dl>
          </section>
        ) : null}
        {entry.kind === "operation" ? (
          <section className="fd-inspector-section">
            <h3>Tool call</h3>
            <dl>
              <KeyValue label="Outcome">{titleFromId(entry.outcome.status)}</KeyValue>
              {entry.actorId === undefined ? null : <KeyValue label="Actor">{entry.actorId}</KeyValue>}
            </dl>
            <div className="fd-result-actions">
              <DataViewer title="Tool arguments" value={entry.invocation.arguments} label="Arguments" />
              <DataViewer title="Tool response" value={entry.outcome} label="Response" />
            </div>
          </section>
        ) : null}
        {entry.kind === "verification" ? (
          <section className="fd-inspector-section">
            <h3>Check result</h3>
            <Status tone={resultTone(entry.result.status)}>{titleFromId(entry.result.status)}</Status>
            <p className="fd-inspector-copy">{entry.result.message}</p>
            <CheckComparison assertion={entry.result} />
          </section>
        ) : null}
        <section className="fd-inspector-section">
          <dl>
            <KeyValue label="World time">{virtualTime(entry.virtualTimeUs)}</KeyValue>
            {entry.causeSequence === undefined ? null : (
              <KeyValue label="Caused by">Event {entry.causeSequence}</KeyValue>
            )}
          </dl>
          <DataViewer title={`Event ${entry.sequence}`} value={entry} label="Full event" />
        </section>
      </ScrollArea>
    </div>
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
  const stateRequest = useRef(0);
  const selected = namespaces.find((item) => `${item.packageId}:${item.namespace}` === selectedKey);

  const load = async (namespace: StateNamespace, after?: string) => {
    const request = ++stateRequest.current;
    setLoading(true);
    try {
      const result = await inspectorApi.state(runId, namespace.packageId, namespace.namespace, after);
      if (request !== stateRequest.current) return;
      setPage((current) =>
        after === undefined || current === undefined
          ? result
          : { ...result, records: [...current.records, ...result.records] },
      );
    } catch (error) {
      if (request === stateRequest.current)
        onError(error instanceof Error ? error.message : "State could not be loaded.");
    } finally {
      if (request === stateRequest.current) setLoading(false);
    }
  };

  if (namespaces.length === 0) return null;
  return (
    <section className="fd-run-section" data-scroll-section="data">
      <div className="fd-section-heading fd-state-heading">
        <div>
          <h3>Data after this run</h3>
        </div>
        <Select
          label="State namespace"
          value={selectedKey ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            stateRequest.current += 1;
            setLoading(false);
            setSelectedKey(next || undefined);
            setPage(undefined);
            const namespace = namespaces.find((item) => `${item.packageId}:${item.namespace}` === next);
            if (namespace !== undefined) void load(namespace);
          }}
        >
          <option value="">Choose a table</option>
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
                    <ResultValue title={`Record: ${record.rowId}`} value={record.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.records.length === 0 ? (
            <div className="fd-table-empty">This table has no records.</div>
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

function pendingRuntimeWork(detail: SimulationRunDetail) {
  const pendingEvents = detail.scheduledEvents.filter((event) => event.status === "pending");
  const unresolvedCallbacks = detail.callbackDeliveries.filter((delivery) =>
    ["pending", "in_flight", "failed"].includes(delivery.status),
  );
  const total = detail.faults.length + pendingEvents.length + unresolvedCallbacks.length;
  return { pendingEvents, unresolvedCallbacks, total };
}

function RuntimeWork({ detail }: { readonly detail: SimulationRunDetail }) {
  const { pendingEvents, unresolvedCallbacks, total } = pendingRuntimeWork(detail);
  if (total === 0) return null;
  return (
    <details className="fd-runtime-work" data-scroll-section="runtime">
      <summary>
        <ChevronRight className="fd-disclosure-chevron" size={15} aria-hidden="true" />
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
}: {
  readonly runs: readonly SimulationRunSummary[];
  readonly selectedRunId: string | undefined;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const eligible = runs.filter((run) => run.reportAvailable);
  const candidateDefault = eligible.find((run) => run.runId === selectedRunId) ?? eligible[0];
  const baselineDefault = eligible.find((run) => run.runId !== candidateDefault?.runId);
  const [baselineRunId, setBaselineRunId] = useState(baselineDefault?.runId ?? "");
  const [candidateRunId, setCandidateRunId] = useState(candidateDefault?.runId ?? "");
  const [comparison, setComparison] = useState<SimulationRunComparison>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const compare = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setComparison(await inspectorApi.compareRuns(baselineRunId, candidateRunId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "The runs could not be compared.");
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
      aria-labelledby="compare-runs-title"
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
          <h2 id="compare-runs-title">Compare runs</h2>
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
            disabled={loading}
            value={baselineRunId}
            onChange={(event) => {
              setBaselineRunId(event.target.value);
              setComparison(undefined);
              setError(undefined);
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
            disabled={loading}
            value={candidateRunId}
            onChange={(event) => {
              setCandidateRunId(event.target.value);
              setComparison(undefined);
              setError(undefined);
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
      {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
      {comparison === undefined ? (
        <div className="fd-compare-empty">
          Choose two completed runs to compare their actions, data and results.
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
              <h3>Check differences</h3>
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
  canRerun,
  onCancel,
  cancelling,
  onOpenReport,
  onRerun,
  starting,
  onError,
}: {
  readonly summary: SimulationRunSummary;
  readonly canRerun: boolean;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = "run-event-details";

  useEffect(() => {
    let current = true;
    setLoading(true);
    setEntries([]);
    setNextSequence(1);
    setSelectedSequence(undefined);
    setDetailsOpen(false);
    Promise.all([inspectorApi.run(summary.runId), inspectorApi.evidence(summary.runId, 1, 300)])
      .then(([nextDetail, page]) => {
        if (!current) return;
        setDetail(nextDetail);
        setEntries(page.entries);
        setNextSequence(page.nextSequence);
        setSelectedSequence(preferredEvidenceSequence(page.entries));
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
          setSelectedSequence((value) => value ?? preferredEvidenceSequence(page.entries));
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

  const indexedEntries = useMemo(
    () => entries.map((entry) => ({ entry, searchText: evidenceSearchText(entry) })),
    [entries],
  );
  const filtered = indexedEntries
    .filter(({ entry, searchText }) => {
      if (kind !== "all" && entry.kind !== kind) return false;
      return matchesSearch(searchText, query);
    })
    .map(({ entry }) => entry);
  const selected = entries.find((entry) => entry.sequence === selectedSequence);
  const assertions = detail?.result?.assertionResults ?? [];
  const checkpoints = detail?.result?.checkpoints.filter((checkpoint) => checkpoint.kind !== "final") ?? [];
  const failedCheckpoints = checkpoints.filter((checkpoint) =>
    checkpoint.assertionResults.some((assertion) => assertion.status === "failed"),
  );

  return (
    <>
      <div className="fd-workspace-main fd-run-main">
        <div className="fd-run-titlebar">
          <div>
            <div className="fd-run-titleline">
              <h2>{titleFromId(summary.drillId)}</h2>
              <Status tone={resultTone(summary.verdict ?? summary.status)}>{resultLabel(summary)}</Status>
            </div>
          </div>
          <div className="fd-run-actions">
            <DataViewer
              title="Run details"
              label="Run details"
              value={{
                summary,
                ...(detail?.result === undefined
                  ? {}
                  : {
                      identity: detail.result.identity,
                      bindingEvidence: detail.result.bindingEvidence,
                      worldConsistency: detail.result.worldConsistency,
                      budgetUsage: detail.result.budgetUsage,
                    }),
              }}
            />
            {summary.reportAvailable ? (
              <>
                {canRerun ? (
                  <Button
                    size="compact"
                    onClick={() => onRerun({ drillId: summary.drillId, seed: summary.seed })}
                    disabled={starting}
                  >
                    {starting ? <Spinner label="Starting drill" /> : <RotateCcw size={15} />}
                    Rerun seed
                  </Button>
                ) : null}
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
        <ScrollArea
          label="Run results"
          resetKey={summary.runId}
          sections={
            loading
              ? []
              : [
                  ...(detail?.result === undefined ? [] : [{ id: "task", label: "Task" }]),
                  ...(assertions.length || checkpoints.length ? [{ id: "checks", label: "Checks" }] : []),
                  { id: "activity", label: "Activity" },
                  ...(detail?.stateNamespaces.length ? [{ id: "data", label: "Data after run" }] : []),
                  ...(detail !== undefined && pendingRuntimeWork(detail).total > 0
                    ? [{ id: "runtime", label: "World runtime" }]
                    : []),
                ]
          }
        >
          {loading ? (
            <div className="fd-subtle-loading fd-subtle-loading--fill">
              <Spinner label="Loading run" /> Loading evidence…
            </div>
          ) : (
            <>
              {detail?.result?.status === "runner_failed" ? (
                <InlineMessage tone="danger" title="The run could not finish">
                  {detail.result.error.message}
                </InlineMessage>
              ) : null}
              {detail?.result?.status === "cancelled" ? (
                <InlineMessage tone="warning">{detail.result.reason}</InlineMessage>
              ) : null}
              {detail?.result?.worldConsistency === "degraded" ? (
                <InlineMessage tone="warning">
                  This run has degraded world consistency. Review its details before relying on the result.
                </InlineMessage>
              ) : null}
              {detail?.result === undefined ? null : (
                <section className="fd-run-section" data-scroll-section="task">
                  <div className="fd-section-heading">
                    <h3>Task</h3>
                  </div>
                  {detail.result.interactions.length === 0 ? (
                    <p className="fd-muted-copy">The run ended before an interaction started.</p>
                  ) : (
                    detail.result.interactions.map((interaction) => (
                      <div className="fd-result-task" key={interaction.interactionId}>
                        <p>{interaction.task.instruction}</p>
                        {interaction.targetResult.status === "completed" ? null : (
                          <p className="fd-result-task__error">
                            Agent {titleFromId(interaction.targetResult.status).toLowerCase()}
                            {interaction.targetResult.error === undefined
                              ? "."
                              : `: ${interaction.targetResult.error.message}`}
                          </p>
                        )}
                        <div className="fd-result-actions">
                          <DataViewer
                            title={`Task input & agent response: ${interaction.interactionId}`}
                            value={interaction}
                            label="Input & response"
                          />
                        </div>
                      </div>
                    ))
                  )}
                </section>
              )}
              {assertions.length > 0 || checkpoints.length > 0 ? (
                <section className="fd-run-section" data-scroll-section="checks">
                  <div className="fd-section-heading">
                    <h3>Checks</h3>
                  </div>
                  <div className="fd-result-checks">
                    {assertions.map((assertion) => (
                      <CheckItem key={assertion.assertionId} assertion={assertion} />
                    ))}
                  </div>
                  {failedCheckpoints.map((checkpoint) => (
                    <div className="fd-result-checkpoint" key={checkpoint.checkpointId}>
                      <h4>Checks failed at {virtualTime(checkpoint.virtualTimeUs)} of world time</h4>
                      {checkpoint.assertionResults
                        .filter((assertion) => assertion.status === "failed")
                        .map((assertion) => (
                          <CheckItem key={assertion.assertionId} assertion={assertion} />
                        ))}
                    </div>
                  ))}
                  {checkpoints.length === 0 ? null : (
                    <DataViewer
                      title="Checks during the run"
                      value={checkpoints}
                      label="All checkpoint checks"
                    />
                  )}
                </section>
              ) : null}
              <section className="fd-timeline-section" data-scroll-section="activity">
                <div className="fd-timeline-toolbar">
                  <div>
                    <h3>Activity</h3>
                  </div>
                  <SearchField
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a tool call or event"
                  />
                  <Select
                    label="Evidence kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    <option value="all">All activity</option>
                    <option value="operation">Tool calls</option>
                    <option value="state_change">State changes</option>
                    <option value="verification">Checks</option>
                    <option value="event">Events</option>
                    <option value="callback">Callbacks</option>
                    <option value="fault">Faults</option>
                    <option value="clock">Clock</option>
                    <option value="lifecycle">Lifecycle</option>
                  </Select>
                  <DetailsTrigger
                    id={detailsId}
                    open={detailsOpen}
                    onClick={() => setDetailsOpen(!detailsOpen)}
                    disabled={selected === undefined}
                  >
                    Event details
                  </DetailsTrigger>
                </div>
                <div className="fd-timeline">
                  {filtered.map((entry) => (
                    <RowButton
                      type="button"
                      className="fd-timeline-entry"
                      key={entry.sequence}
                      aria-current={selectedSequence === entry.sequence ? "true" : undefined}
                      aria-expanded={detailsOpen && selectedSequence === entry.sequence}
                      aria-controls={detailsId}
                      onClick={() => {
                        setSelectedSequence(entry.sequence);
                        setDetailsOpen(true);
                      }}
                    >
                      <span className="fd-timeline-entry__sequence">{entry.sequence}</span>
                      <span className="fd-timeline-entry__mark" data-tone={eventTone(entry)}>
                        <EventIcon kind={entry.kind} />
                      </span>
                      <span className="fd-timeline-entry__body">
                        <strong>{evidenceLabel(entry)}</strong>
                        <small>
                          {entry.kind === "operation" ? `${titleFromId(entry.outcome.status)} · ` : ""}
                          {virtualTime(entry.virtualTimeUs)}
                        </small>
                      </span>
                      {entry.causeSequence === undefined ? null : (
                        <span className="fd-timeline-entry__cause">← {entry.causeSequence}</span>
                      )}
                    </RowButton>
                  ))}
                  {filtered.length === 0 ? (
                    <div className="fd-table-empty">No activity matches these filters.</div>
                  ) : null}
                </div>
                {nextSequence <= summary.evidenceSequence ? (
                  <div className="fd-load-more">
                    <Button size="compact" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? <Spinner label="Loading more evidence" /> : null}
                      Load more activity
                    </Button>
                  </div>
                ) : null}
              </section>
              {detail === undefined ? null : (
                <StateBrowser
                  key={summary.runId}
                  runId={summary.runId}
                  namespaces={detail.stateNamespaces}
                  onError={onError}
                />
              )}
              {detail === undefined ? null : <RuntimeWork detail={detail} />}
            </>
          )}
        </ScrollArea>
      </div>
      <DetailsPanel
        id={detailsId}
        title="Event details"
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      >
        <EventInspector entry={selected} />
      </DetailsPanel>
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
  project,
  runs,
  unavailableReports = [],
  requests,
  starting,
  cancelling,
  onCancel,
  onRerun,
  onOpenReport,
  onNavigateDrills,
  onError,
}: {
  readonly project: SimulationProject;
  readonly runs: readonly SimulationRunSummary[];
  readonly unavailableReports?: SimulationRunList["unavailable"];
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
  const indexedRuns = useMemo(() => runs.map((run) => ({ run, searchText: runSearchText(run) })), [runs]);
  const filtered = indexedRuns
    .filter(({ run, searchText }) => {
      if (status !== "all" && (run.verdict ?? run.status) !== status) return false;
      return matchesSearch(searchText, query);
    })
    .map(({ run }) => run);

  useEffect(() => {
    if (selectedId === undefined && runs[0] !== undefined) setSelectedId(runs[0].runId);
  }, [runs, selectedId]);

  if (runs.length === 0 && activeRequests.length === 0) {
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <PageIntro page="runs" />
        </header>
        <UnavailableReports reports={unavailableReports} />
        <EmptyState
          title={unavailableReports.length > 0 ? "No readable runs" : "No drill runs yet"}
          action={
            <Button variant="primary" onClick={onNavigateDrills}>
              <Play size={16} /> Choose a drill
            </Button>
          }
        >
          Run a drill to see what your agent did and whether its checks passed.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page="runs" />
        {runs.filter((run) => run.reportAvailable).length > 1 ? (
          <Button onClick={() => setCompareOpen(true)}>
            <GitCompareArrows size={16} /> Compare runs
          </Button>
        ) : null}
      </header>
      <UnavailableReports reports={unavailableReports} />
      {activeRequests.some((request) => request.runIds.length === 0) ? (
        <InlineMessage tone="info">
          Firedrill is preparing an isolated world for the selected drill.
        </InlineMessage>
      ) : null}
      <div className="fd-workspace fd-run-workspace fd-details-workspace">
        <aside className="fd-workspace-rail fd-run-rail">
          <div className="fd-rail-head">
            <strong>Runs</strong>
            <span>{runs.length}</span>
          </div>
          <div className="fd-run-filters">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Drill, target, scenario, seed…"
            />
            <Select label="Run result" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All results</option>
              <option value="running">Running</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="inconclusive">Inconclusive</option>
              <option value="runner_failed">Runner failed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </div>
          <div className="fd-rail-list">
            {filtered.map((run) => (
              <RowButton
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
              </RowButton>
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
            key={selected.runId}
            summary={selected}
            canRerun={project.drills.some(
              (drill) =>
                drill.id === selected.drillId &&
                project.targets.some(
                  (target) => target.id === drill.targetId && target.runAvailability === "ready",
                ),
            )}
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
        <ComparisonDialog runs={runs} selectedRunId={selected?.runId} onClose={() => setCompareOpen(false)} />
      ) : null}
    </section>
  );
}
