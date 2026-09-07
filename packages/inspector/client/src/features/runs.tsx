import {
  Activity,
  ArrowLeft,
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
import { CheckComparison, checksForReview } from "../components/check-comparison";
import { DataViewer } from "../components/data-viewer";
import { DetailsPanel, DetailsTrigger } from "../components/details-panel";
import { PageIntro } from "../components/page-intro";
import { PaginatedContent, Pagination, pageBounds, usePagination } from "../components/pagination";
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
import { hasRunAttachments, RunAttachments } from "../components/run-attachments";
import { ScrollArea } from "../components/scroll-area";
import { ValueDiff } from "../components/value-diff";
import { compactId, evidenceLabel, plural, titleFromId, virtualTime } from "../format";
import { type RunSelection, resolveLinkedRun } from "../navigation";
import { evidenceSearchText, matchesSearch, preferredEvidenceSequence, runSearchText } from "../search";
import type {
  EvidenceEntry,
  SimulationProject,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunSummary,
  SimulationStatePage,
  StartSimulationRun,
  StateNamespace,
} from "../types";
import "./runs.css";
import { RunComparison } from "./run-comparison";
import { overrideOutcomeLabel, overrideScopeLabel } from "./tool-overrides";

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

export function resultTone(value?: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (value === "passed") return "success";
  if (value === "failed" || value === "runner_failed") return "danger";
  if (value === "inconclusive" || value === "cancelling") return "warning";
  if (value === "running") return "info";
  return "neutral";
}

export function resultLabel(run: SimulationRunSummary): string {
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
            <ValueDiff
              before={entry.before}
              after={entry.after}
              beforeLabel="Before"
              afterLabel="After"
              label="Record changes"
            />
          </section>
        ) : null}
        {entry.kind === "operation" ? (
          <section className="fd-inspector-section">
            <h3>Tool call</h3>
            <dl>
              <KeyValue label="Outcome">{titleFromId(entry.outcome.status)}</KeyValue>
              {entry.actorId === undefined ? null : <KeyValue label="Actor">{entry.actorId}</KeyValue>}
              {entry.toolOverride === undefined ? null : (
                <>
                  <KeyValue label="Override rule">{entry.toolOverride.id}</KeyValue>
                  <KeyValue label="Defined in">{overrideScopeLabel(entry.toolOverride.scope)}</KeyValue>
                  <KeyValue label="Override behavior">
                    {overrideOutcomeLabel(entry.toolOverride.outcome)}
                  </KeyValue>
                  <KeyValue label="Matching call">{entry.toolOverride.matchIndex}</KeyValue>
                </>
              )}
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
  const [rowPage, setRowPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const stateRequest = useRef(0);
  const selected = namespaces.find((item) => `${item.packageId}:${item.namespace}` === selectedKey);
  const rowCount =
    page === undefined
      ? 0
      : page.nextRowId === undefined
        ? page.records.length
        : Math.max(selected?.records ?? 0, page.records.length);
  const rows = pageBounds(rowCount, rowPage, 25);

  const load = async (namespace: StateNamespace, after?: string, nextPage = 0) => {
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
      setRowPage(nextPage);
    } catch (error) {
      if (request === stateRequest.current)
        onError(error instanceof Error ? error.message : "State could not be loaded.");
    } finally {
      if (request === stateRequest.current) setLoading(false);
    }
  };

  const changeRowPage = (nextPage: number) => {
    if (loading || page === undefined || selected === undefined) return;
    if (nextPage * rows.pageSize < page.records.length) {
      setRowPage(nextPage);
    } else if (page.nextRowId !== undefined) {
      void load(selected, page.nextRowId, nextPage);
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
            setRowPage(0);
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
          <ScrollArea label="Run state records" resetKey={`${selectedKey}:${rows.page}`} natural>
            <table className="fd-table fd-state-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {page.records.slice(rows.start, rows.end).map((record) => (
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
          </ScrollArea>
          <Pagination
            label="State rows"
            {...rows}
            total={rowCount}
            onPageChange={changeRowPage}
            disabled={loading}
          />
          {loading ? (
            <div className="fd-subtle-loading">
              <Spinner label="Loading state page" /> Loading rows…
            </div>
          ) : null}
          {page.records.length === 0 ? (
            <div className="fd-table-empty">This table has no records.</div>
          ) : null}
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
            <PaginatedContent items={detail.faults} label="Active faults">
              {(faults) => (
                <ul>
                  {faults.map((fault) => (
                    <li key={`${fault.packageId}:${fault.faultId}`}>
                      <code>
                        {fault.packageId}.{fault.faultId}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </PaginatedContent>
          </section>
        )}
        {pendingEvents.length === 0 ? null : (
          <section>
            <h4>Pending events</h4>
            <PaginatedContent items={pendingEvents} label="Pending events">
              {(events) => (
                <ul>
                  {events.map((event) => (
                    <li key={event.id}>
                      <code>
                        {event.event.packageId}.{event.event.eventId}
                      </code>
                      <span>due {virtualTime(event.dueUs)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PaginatedContent>
          </section>
        )}
        {unresolvedCallbacks.length === 0 ? null : (
          <section>
            <h4>Callback deliveries</h4>
            <PaginatedContent items={unresolvedCallbacks} label="Callback deliveries">
              {(deliveries) => (
                <ul>
                  {deliveries.map((delivery) => (
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
              )}
            </PaginatedContent>
          </section>
        )}
      </div>
    </details>
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
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedSequence, setSelectedSequence] = useState<number>();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = "run-event-details";

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt intentionally retries this run without changing its identity.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError(undefined);
    setDetail(undefined);
    setEntries([]);
    setNextSequence(1);
    setSelectedSequence(undefined);
    setDetailsOpen(false);
    Promise.all([
      resolveLinkedRun(summary.runId, inspectorApi.run),
      inspectorApi.evidence(summary.runId, 1, 300),
    ])
      .then(([nextDetail, page]) => {
        if (!current) return;
        setDetail(nextDetail);
        setEntries(page.entries);
        setNextSequence(page.nextSequence);
        setSelectedSequence(preferredEvidenceSequence(page.entries));
      })
      .catch((error: unknown) => {
        if (current)
          setLoadError(error instanceof Error ? error.message : "Run evidence could not be loaded.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [summary.runId, loadAttempt]);

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
  const activity = usePagination(filtered, `${summary.runId}:${kind}:${query}`);
  const selected = entries.find((entry) => entry.sequence === selectedSequence);
  const assertions = checksForReview(detail?.result?.assertionResults ?? []);
  const checkpoints = detail?.result?.checkpoints.filter((checkpoint) => checkpoint.kind !== "final") ?? [];
  const failedCheckpointChecks = checkpoints.flatMap((checkpoint) =>
    checkpoint.assertionResults
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => ({ checkpoint, assertion })),
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
                  ...(detail?.result !== undefined && hasRunAttachments(detail.result)
                    ? [{ id: "attachments", label: "Attachments" }]
                    : []),
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
          ) : loadError !== undefined ? (
            <InlineMessage tone="danger" title="Run could not be opened">
              <p>{loadError}</p>
              <Button onClick={() => setLoadAttempt((value) => value + 1)}>Retry run</Button>
            </InlineMessage>
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
                    <PaginatedContent
                      items={detail.result.interactions}
                      label="Task interactions"
                      resetKey={summary.runId}
                    >
                      {(interactions) =>
                        interactions.map((interaction) => (
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
                      }
                    </PaginatedContent>
                  )}
                </section>
              )}
              {assertions.length > 0 || checkpoints.length > 0 ? (
                <section className="fd-run-section" data-scroll-section="checks">
                  <div className="fd-section-heading">
                    <h3>Checks</h3>
                  </div>
                  <PaginatedContent items={assertions} label="Final checks" resetKey={summary.runId}>
                    {(pageAssertions) => (
                      <div className="fd-result-checks">
                        {pageAssertions.map((assertion) => (
                          <CheckItem key={assertion.assertionId} assertion={assertion} />
                        ))}
                      </div>
                    )}
                  </PaginatedContent>
                  <PaginatedContent
                    items={failedCheckpointChecks}
                    label="Failed checkpoint checks"
                    resetKey={summary.runId}
                  >
                    {(checks) =>
                      checks.map(({ checkpoint, assertion }, index) => (
                        <div
                          className="fd-result-checkpoint"
                          key={`${checkpoint.checkpointId}:${assertion.assertionId}`}
                        >
                          {index === 0 ||
                          checks[index - 1]?.checkpoint.checkpointId !== checkpoint.checkpointId ? (
                            <h4>Checks failed at {virtualTime(checkpoint.virtualTimeUs)} of world time</h4>
                          ) : null}
                          <CheckItem assertion={assertion} />
                        </div>
                      ))
                    }
                  </PaginatedContent>
                  {checkpoints.length === 0 ? null : (
                    <DataViewer
                      title="Checks during the run"
                      value={checkpoints}
                      label="All checkpoint checks"
                    />
                  )}
                </section>
              ) : null}
              {detail?.result === undefined ? null : (
                <RunAttachments
                  key={`attachments:${summary.runId}`}
                  runId={summary.runId}
                  result={detail.result}
                  reportAvailable={summary.reportAvailable}
                />
              )}
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
                  {activity.items.map((entry) => (
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
                          {entry.kind === "operation" && entry.toolOverride !== undefined
                            ? `Override ${entry.toolOverride.id} · `
                            : ""}
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
                <Pagination label="Loaded activity" {...activity} />
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
                  key={`state:${summary.runId}`}
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

export interface RunHistoryControls {
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly refreshing: boolean;
  readonly olderError: string | undefined;
  readonly latestError: string | undefined;
  readonly onLoadOlder: () => void;
  readonly onRetryLatest: () => void;
}

export function OlderRuns({ history }: { readonly history: RunHistoryControls | undefined }) {
  if (history === undefined || !history.hasMore) return null;
  return (
    <>
      {history.olderError === undefined ? null : (
        <div className="fd-rail-empty" role="alert">
          Older runs could not be loaded. {history.olderError}
        </div>
      )}
      <div className="fd-load-more">
        <Button
          size="compact"
          disabled={history.loadingOlder || history.refreshing}
          onClick={history.onLoadOlder}
        >
          {history.loadingOlder ? <Spinner label="Loading older runs" /> : null}
          {history.loadingOlder
            ? "Loading older runs…"
            : history.olderError === undefined
              ? "Load older runs"
              : "Retry older runs"}
        </Button>
      </div>
    </>
  );
}

export function RunListWarning({ history }: { readonly history: RunHistoryControls | undefined }) {
  if (history?.latestError === undefined) return null;
  return (
    <InlineMessage tone="warning" title="Latest runs could not be refreshed">
      <p>{history.latestError} Previously loaded runs remain available.</p>
      <Button size="compact" disabled={history.refreshing} onClick={history.onRetryLatest}>
        Retry latest runs
      </Button>
    </InlineMessage>
  );
}

export function RunsView({
  project,
  runs,
  unavailableReports = [],
  history,
  selection = { kind: "automatic" },
  onSelectRun,
  onClearSelection,
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
  readonly history?: RunHistoryControls;
  readonly selection?: RunSelection;
  readonly onSelectRun?: (runId: string) => void;
  readonly onClearSelection?: () => void;
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
  const selectionKey = selection.kind === "explicit" ? selection.runId : selection.kind;
  const [comparison, setComparison] = useState({ key: selectionKey, open: false });
  if (comparison.key !== selectionKey) setComparison({ key: selectionKey, open: false });
  const compareOpen = comparison.key === selectionKey && comparison.open;
  const setCompareOpen = (open: boolean) => setComparison({ key: selectionKey, open });
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [linked, setLinked] = useState<{
    readonly key: string;
    readonly run?: SimulationRunSummary;
    readonly error?: string;
  }>();
  const requestedRunId = selection.kind === "explicit" ? selection.runId : undefined;
  const knownRequestedRun = runs.find((run) => run.runId === requestedRunId);
  const lookupKey = `${requestedRunId ?? ""}:${lookupAttempt}`;
  const missingRequestedRun = requestedRunId !== undefined && knownRequestedRun === undefined;
  useEffect(() => {
    if (!missingRequestedRun || requestedRunId === undefined) return;
    let current = true;
    void resolveLinkedRun(requestedRunId, inspectorApi.run).then(
      (detail) => {
        if (current) setLinked({ key: lookupKey, run: detail.summary });
      },
      (error: unknown) => {
        if (current)
          setLinked({
            key: lookupKey,
            error: error instanceof Error ? error.message : "The requested run could not be opened.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [missingRequestedRun, requestedRunId, lookupKey]);

  const linkedRun = linked?.key === lookupKey ? linked.run : undefined;
  const linkedError = linked?.key === lookupKey ? linked.error : undefined;
  const selectionError =
    selection.kind === "invalid"
      ? selection.message
      : knownRequestedRun === undefined
        ? linkedError
        : undefined;
  const selected =
    selection.kind === "automatic"
      ? (runs.find((run) => run.runId === selectedId) ?? runs[0])
      : selection.kind === "explicit" && selectionError === undefined
        ? (knownRequestedRun ?? linkedRun)
        : undefined;
  const visibleRuns =
    linkedRun === undefined || runs.some((run) => run.runId === linkedRun.runId)
      ? runs
      : [linkedRun, ...runs];
  const activeRequests = requests.filter((request) =>
    ["starting", "running", "cancelling"].includes(request.status),
  );
  const indexedRuns = useMemo(
    () => visibleRuns.map((run) => ({ run, searchText: runSearchText(run) })),
    [visibleRuns],
  );
  const filtered = indexedRuns
    .filter(({ run, searchText }) => {
      if (status !== "all" && (run.verdict ?? run.status) !== status) return false;
      return matchesSearch(searchText, query);
    })
    .map(({ run }) => run);
  const runPage = usePagination(filtered, `${status}:${query}`);

  useEffect(() => {
    if (selectedId === undefined && runs[0] !== undefined) setSelectedId(runs[0].runId);
  }, [runs, selectedId]);

  if (runs.length === 0 && activeRequests.length === 0 && selection.kind === "automatic") {
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <PageIntro page="runs" />
        </header>
        <UnavailableReports reports={unavailableReports} />
        <RunListWarning history={history} />
        <EmptyState
          title={
            history?.hasMore
              ? "No readable loaded runs"
              : unavailableReports.length > 0
                ? "No readable runs"
                : "No drill runs yet"
          }
          action={
            <Button variant="primary" onClick={onNavigateDrills}>
              <Play size={16} /> Choose a drill
            </Button>
          }
        >
          {history?.hasMore
            ? "The loaded reports could not be opened. Load older runs to look for another saved result."
            : "Run a drill to see what your agent did and whether its checks passed."}
        </EmptyState>
        <OlderRuns history={history} />
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page="runs" />
        {compareOpen ? (
          <Button onClick={() => setCompareOpen(false)}>
            <ArrowLeft size={16} /> Back to runs
          </Button>
        ) : visibleRuns.filter((run) => run.reportAvailable).length > 1 ? (
          <Button onClick={() => setCompareOpen(true)}>
            <GitCompareArrows size={16} /> Compare runs
          </Button>
        ) : null}
      </header>
      <UnavailableReports reports={unavailableReports} />
      <RunListWarning history={history} />
      {activeRequests.some((request) => request.runIds.length === 0) ? (
        <InlineMessage tone="info">
          Firedrill is preparing an isolated world for the selected drill.
        </InlineMessage>
      ) : null}
      {compareOpen ? (
        <>
          {history?.hasMore ? (
            <div className="fd-unavailable-reports">
              <p>Comparison selectors include only loaded runs.</p>
            </div>
          ) : null}
          <RunComparison runs={visibleRuns} selectedRunId={selected?.runId} />
          <OlderRuns history={history} />
        </>
      ) : (
        <div className="fd-workspace fd-run-workspace fd-details-workspace">
          <aside className="fd-workspace-rail fd-run-rail">
            <div className="fd-rail-head">
              <strong>Runs</strong>
              <span>
                {visibleRuns.length}
                {history?.hasMore ? " loaded" : ""}
              </span>
            </div>
            <div className="fd-run-filters">
              <SearchField
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={history?.hasMore ? "Search loaded runs" : "Search runs"}
                placeholder={history?.hasMore ? "Search loaded runs…" : "Drill, target, scenario, seed…"}
              />
              <Select
                label={history?.hasMore ? "Loaded run result" : "Run result"}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">{history?.hasMore ? "All loaded results" : "All results"}</option>
                <option value="running">Running</option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
                <option value="inconclusive">Inconclusive</option>
                <option value="runner_failed">Runner failed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </div>
            <div className="fd-rail-list">
              {runPage.items.map((run) => (
                <RowButton
                  type="button"
                  className="fd-run-list-item"
                  key={run.runId}
                  aria-current={selected?.runId === run.runId ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(run.runId);
                    onSelectRun?.(run.runId);
                  }}
                >
                  <span className="fd-run-list-item__top">
                    <strong>{titleFromId(run.drillId)}</strong>
                    <Status tone={resultTone(run.verdict ?? run.status)}>{resultLabel(run)}</Status>
                  </span>
                  <code>{compactId(run.runId, 19)}</code>
                </RowButton>
              ))}
            </div>
            <Pagination label={history?.hasMore ? "Loaded runs" : "Runs"} {...runPage} variant="rail" />
            {filtered.length === 0 ? (
              <div className="fd-rail-empty">
                {history?.hasMore ? "No loaded runs match these filters." : "No runs match these filters."}
              </div>
            ) : null}
            <OlderRuns history={history} />
          </aside>
          {selectionError !== undefined ? (
            <EmptyState
              title="Run unavailable"
              action={
                <>
                  {selection.kind === "explicit" ? (
                    <Button onClick={() => setLookupAttempt((value) => value + 1)}>Retry run</Button>
                  ) : null}
                  {onClearSelection === undefined ? null : (
                    <Button onClick={onClearSelection}>View loaded runs</Button>
                  )}
                </>
              }
            >
              <span role="alert">{selectionError}</span>
            </EmptyState>
          ) : selected === undefined && selection.kind === "explicit" ? (
            <EmptyState title="Opening requested run">
              <span role="status">
                <Spinner label="Loading requested run" /> Looking up {selection.runId}…
              </span>
            </EmptyState>
          ) : selected === undefined ? (
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
      )}
    </section>
  );
}
