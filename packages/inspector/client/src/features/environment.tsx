import { Activity, ArrowRight, Database, Plug, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { inspectorApi } from "../api";
import { CodeDocument } from "../components/code-document";
import { DataViewer } from "../components/data-viewer";
import { PaginatedContent, Pagination, usePagination } from "../components/pagination";
import {
  Button,
  EmptyState,
  IconButton,
  InlineMessage,
  Input,
  PageLoader,
  RowButton,
  SearchField,
  Select,
  Spinner,
  Status,
} from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { SourceViewer } from "../components/source-viewer";
import type {
  EnvironmentActivityPage,
  EnvironmentCall,
  EnvironmentCallResult,
  EnvironmentConnections,
  EnvironmentStatePage,
  EnvironmentStatus,
  RunningEnvironment,
} from "../environment-types";
import { compactId, evidenceLabel, json, plural, virtualTime } from "../format";
import type { SimulationProject, SimulationTool } from "../types";
import { recordCell } from "./catalog-data";
import { ConnectionEndpoint, ConnectionSetup } from "./connection-setup";
import "./local-workspace.css";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local environment could not be read. Retry the request.";
}

export function useEnvironment() {
  const [status, setStatus] = useState<EnvironmentStatus>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const current = useRef(true);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const refresh = useCallback((): Promise<void> => {
    if (pending.current !== undefined) return pending.current;
    setRefreshing(true);
    const request = inspectorApi
      .environment()
      .then((next) => {
        if (current.current) {
          setStatus(next);
          setError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (current.current) setError(message(failure));
      })
      .finally(() => {
        pending.current = undefined;
        if (current.current) setRefreshing(false);
      });
    pending.current = request;
    return request;
  }, []);
  useEffect(() => {
    current.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2000);
    return () => {
      current.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  return { status, error, refreshing, refresh };
}
export type EnvironmentControls = ReturnType<typeof useEnvironment>;

export function EnvironmentBanner({
  environment,
  onVisit,
}: {
  readonly environment: EnvironmentControls;
  readonly onVisit: (href: string) => void;
}) {
  const { status, error } = environment;
  return (
    <div className="fd-environment-banner">
      <Database size={18} aria-hidden="true" />
      <div>
        {error !== undefined ? (
          <>
            <strong>Environment status unavailable</strong>
            <p>{error} Last known state is not current confirmation.</p>
          </>
        ) : status === undefined ? (
          <>
            <strong>Checking local environment</strong>
            <p>Reading the running world, if one is attached.</p>
          </>
        ) : status.available ? (
          <>
            <Status tone="info">Local environment running</Status>
            <p>
              {status.description.worldId} · {status.description.scenarioId ?? "World baseline"}
            </p>
          </>
        ) : (
          <>
            <strong>No environment running</strong>
            <p>Review the selected tools, then start the local environment.</p>
          </>
        )}
      </div>
      <Button
        onClick={() =>
          error !== undefined
            ? void environment.refresh()
            : onVisit(status?.available ? "/environment" : "/connect")
        }
      >
        {error !== undefined ? "Retry" : status?.available ? "Open environment" : "Get environment ready"}
        <ArrowRight size={15} />
      </Button>
    </div>
  );
}

export function EnvironmentUnavailable({ project }: { readonly project: SimulationProject }) {
  return (
    <div className="fd-local-section">
      <h2>Start the local environment</h2>
      <p>
        The inspector is showing source definitions for <code>{project.world.id}</code>. No live state or
        agent connection is attached. From this repository, run:
      </p>
      <CodeDocument content="firedrill serve" language="bash" context="Run in your repository terminal" />
      <p>
        Open the inspector URL printed by that command. It uses this repository’s tools and starting data; it
        does not start your agent or load an example.
      </p>
    </div>
  );
}

/** Validate before crossing the mutation boundary; values are never inferred from an operation name. */
export function toolCallInput(
  actorId: string,
  packageId: string,
  operationId: string,
  input: string,
  idempotencyKey: string,
): EnvironmentCall {
  if (!actorId || !packageId || !operationId)
    throw new Error("Choose an actor and operation before testing this tool.");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Arguments must be valid JSON. Fix the JSON, then test the tool again.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Arguments must be a JSON object, not an array or scalar.");
  return {
    actorId,
    packageId,
    operationId,
    arguments: value as Record<string, unknown>,
    ...(idempotencyKey.trim() === "" ? {} : { idempotencyKey }),
  };
}

export function TestTool({
  tool,
  project,
  environment,
  onVisit,
}: {
  readonly tool: SimulationTool;
  readonly project: SimulationProject;
  readonly environment: EnvironmentControls;
  readonly onVisit: (href: string) => void;
}) {
  const [operationId, setOperationId] = useState("");
  const [actorId, setActorId] = useState("");
  const [input, setInput] = useState("{}");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<EnvironmentCallResult>();
  const argumentId = useId();
  const runtime = environment.status?.available ? environment.status : undefined;
  const liveTool = runtime?.description.tools.find((item) => item.packageId === tool.id);
  const operation =
    liveTool?.operationContracts.find((item) => item.id === operationId) ?? liveTool?.operationContracts[0];
  const actor =
    runtime?.description.actors.find((item) => item.actorId === actorId) ?? runtime?.description.actors[0];
  const granted = actor?.grants.some(
    (grant) => grant.packageId === tool.id && grant.operationId === operation?.id,
  );
  if (environment.error !== undefined)
    return (
      <div className="fd-local-section">
        <InlineMessage tone="danger">{environment.error}</InlineMessage>
        <Button onClick={() => void environment.refresh()}>Retry environment</Button>
      </div>
    );
  if (environment.status === undefined) return <PageLoader label="Reading live tool contracts" />;
  if (runtime === undefined) return <EnvironmentUnavailable project={project} />;
  if (liveTool === undefined)
    return (
      <EmptyState
        title="This tool is not in the running environment"
        action={<Button onClick={() => onVisit("/environment")}>Open running environment</Button>}
      >
        The source and running build differ. Restart the local environment to load the current source before
        testing this tool.
      </EmptyState>
    );
  const call = async () => {
    setError(undefined);
    setResult(undefined);
    let request: EnvironmentCall;
    try {
      request = toolCallInput(actor?.actorId ?? "", tool.id, operation?.id ?? "", input, idempotencyKey);
    } catch (failure) {
      setError(message(failure));
      return;
    }
    setBusy(true);
    try {
      const next = await inspectorApi.callEnvironmentTool(request);
      if (next.worldInstanceId !== runtime.metadata.worldInstanceId)
        throw new Error("The environment changed during this call. Inspect activity before trying again.");
      setResult(next);
      await environment.refresh();
    } catch (failure) {
      setError(`${message(failure)} Inspect activity before retrying: the call may have reached the world.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollArea label="Test tool">
      <section className="fd-local-section">
        <h2>Test this tool directly</h2>
        <p>
          This sends a real call to the local synthetic environment as an operator. It can mutate state. It
          does not invoke or test your agent.
        </p>
        {runtime.description.buildHash !== project.world.buildHash ? (
          <InlineMessage tone="warning">
            The running build differs from current source. The form below uses the running tool’s contract.
          </InlineMessage>
        ) : null}
        <form
          className="fd-local-form"
          onSubmit={(event) => {
            event.preventDefault();
            void call();
          }}
        >
          <div className="fd-local-form-row">
            <div className="fd-local-field">
              <label htmlFor={`${argumentId}-operation`}>Operation</label>
              <Select
                id={`${argumentId}-operation`}
                label="Operation to test"
                value={operation?.id ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setOperationId(event.target.value);
                  setResult(undefined);
                }}
              >
                {liveTool.operationContracts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </Select>
            </div>
            <div className="fd-local-field">
              <label htmlFor={`${argumentId}-actor`}>Actor scope</label>
              <Select
                id={`${argumentId}-actor`}
                label="Tool call actor"
                value={actor?.actorId ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setActorId(event.target.value);
                  setResult(undefined);
                }}
              >
                {runtime.description.actors.map((item) => (
                  <option key={item.actorId} value={item.actorId}>
                    {item.actorId}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {operation?.description === undefined ? null : <p>{operation.description}</p>}
          {actor === undefined ? (
            <InlineMessage tone="warning">
              No actor is declared in this environment. Add an actor with explicit tool grants, then restart
              it.
            </InlineMessage>
          ) : (
            <p>
              Calling as <code>{actor.actorId}</code> in{" "}
              <code>{compactId(runtime.metadata.worldInstanceId, 28)}</code>.{" "}
              {granted
                ? "This actor is granted this operation."
                : "This actor has no grant for this operation; the runtime is expected to deny it."}
            </p>
          )}
          <div className="fd-local-connection-actions">
            {operation?.inputSchema === undefined ? null : (
              <DataViewer
                title={`${tool.id}.${operation.id} live input schema`}
                value={operation.inputSchema}
                label="Input schema"
              />
            )}
            {operation?.outputSchema === undefined ? null : (
              <DataViewer
                title={`${tool.id}.${operation.id} live output schema`}
                value={operation.outputSchema}
                label="Response schema"
              />
            )}
            {operation?.declaredErrors === undefined || operation.declaredErrors.length === 0 ? null : (
              <DataViewer
                title="Declared tool errors"
                value={operation.declaredErrors}
                label="Declared errors"
              />
            )}
          </div>
          <label className="fd-local-field" htmlFor={argumentId}>
            Arguments · JSON object
            <textarea
              id={argumentId}
              className="fd-local-input"
              spellCheck={false}
              value={input}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          {operation?.idempotency === "none" ? null : (
            <label className="fd-local-field" htmlFor={`${argumentId}-idempotency`}>
              Idempotency key{operation?.idempotency === "required" ? " (required)" : " (optional)"}
              <Input
                id={`${argumentId}-idempotency`}
                value={idempotencyKey}
                disabled={busy}
                onChange={(event) => setIdempotencyKey(event.target.value)}
              />
            </label>
          )}
          {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
          <div className="fd-local-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                actor === undefined ||
                operation === undefined ||
                (operation.idempotency === "required" && idempotencyKey.trim() === "")
              }
            >
              {busy ? <Spinner label="Calling tool" /> : null}Test tool
            </Button>
            <Button onClick={() => onVisit("/environment?tab=activity")}>View activity</Button>
          </div>
        </form>
        {result === undefined ? null : (
          <section className="fd-local-result" aria-live="polite">
            <InlineMessage
              tone={result.result.outcome.status === "ok" ? "success" : "warning"}
              title={`Tool call: ${result.result.outcome.status}`}
            >
              This is a tool response, not an agent-test verdict. Sensitive fields are redacted.
            </InlineMessage>
            <CodeDocument
              content={json(result.result.outcome)}
              language="json"
              context="Actual runtime response"
            />
          </section>
        )}
      </section>
    </ScrollArea>
  );
}

export function ResetEnvironmentDialog({
  runtime,
  onReset,
}: {
  readonly runtime: RunningEnvironment;
  readonly onReset: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  const close = () => {
    if (!busy) {
      setOpen(false);
      setConfirmation("");
      setError(undefined);
    }
  };
  const reset = async () => {
    if (confirmation !== runtime.metadata.worldInstanceId) return;
    setBusy(true);
    setError(undefined);
    try {
      await inspectorApi.resetEnvironment(confirmation);
      await onReset();
      setOpen(false);
      setConfirmation("");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <RotateCcw size={15} />
        Reset environment
      </Button>
      <dialog
        className="fd-dialog"
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onClose={close}
      >
        <div className="fd-dialog__head">
          <h2 id={`${id}-title`}>Reset the entire environment?</h2>
          <IconButton label="Close reset confirmation" onClick={close} disabled={busy}>
            <X size={17} />
          </IconButton>
        </div>
        <p id={`${id}-description`}>
          All current state changes and activity return to the starting baseline. Stop your connected agent
          before resetting. Saved drill reports and repository source are unchanged.
        </p>
        <label className="fd-reset-field" htmlFor={`${id}-confirmation`}>
          Type the exact environment ID to confirm<code>{runtime.metadata.worldInstanceId}</code>
          <Input
            id={`${id}-confirmation`}
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            aria-label="Environment ID confirmation"
          />
        </label>
        {error === undefined ? null : (
          <div className="fd-local-section">
            <InlineMessage tone="danger">{error}</InlineMessage>
          </div>
        )}
        <div className="fd-dialog__actions">
          <Button onClick={close} disabled={busy}>
            Keep environment
          </Button>
          <Button
            variant="danger"
            onClick={() => void reset()}
            disabled={busy || confirmation !== runtime.metadata.worldInstanceId}
          >
            {busy ? <Spinner label="Resetting environment" /> : null}Reset entire environment
          </Button>
        </div>
      </dialog>
    </>
  );
}

function LiveState({ runtime }: { readonly runtime: RunningEnvironment }) {
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [page, setPage] = useState<EnvironmentStatePage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const tables = runtime.description.tools.flatMap((tool) =>
    tool.stateNamespaces.map((namespace) => ({
      id: JSON.stringify([tool.packageId, namespace]),
      packageId: tool.packageId,
      namespace,
    })),
  );
  const matches = tables.filter((table) =>
    `${table.packageId} ${table.namespace}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const table = matches.find((item) => item.id === selected) ?? matches[0];
  const pagination = usePagination(matches, query);
  const after = cursors.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different table owns a fresh keyset cursor.
  useEffect(() => {
    setCursors([undefined]);
  }, [table?.id]);
  const packageId = table?.packageId;
  const namespace = table?.namespace;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit retry/refresh control.
  useEffect(() => {
    let current = true;
    let pending = false;
    const read = () => {
      if (packageId === undefined || namespace === undefined || pending) {
        if (packageId === undefined || namespace === undefined) setLoading(false);
        return;
      }
      pending = true;
      void inspectorApi
        .environmentState(packageId, namespace, runtime.description.generation, after)
        .then((next) => {
          if (!current) return;
          if (
            next.worldInstanceId !== runtime.metadata.worldInstanceId ||
            next.generation !== runtime.description.generation
          )
            throw new Error("The running environment changed. Refresh its status before continuing.");
          setPage(next);
          setError(undefined);
        })
        .catch((failure: unknown) => {
          if (current) setError(message(failure));
        })
        .finally(() => {
          pending = false;
          if (current) setLoading(false);
        });
    };
    setLoading(true);
    setPage(undefined);
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, 2000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [
    packageId,
    namespace,
    after,
    runtime.description.generation,
    runtime.metadata.worldInstanceId,
    revision,
  ]);
  return (
    <div className="fd-local-state-layout">
      <aside className="fd-workspace-rail">
        <div className="fd-rail-head">
          <strong>Live tables</strong>
        </div>
        <div className="fd-rail-search">
          <SearchField
            placeholder="Find a live table"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="fd-rail-list">
          {pagination.items.map((item) => (
            <RowButton
              className="fd-rail-item"
              key={item.id}
              aria-current={table?.id === item.id ? "true" : undefined}
              onClick={() => {
                setSelected(item.id);
                setCursors([undefined]);
              }}
            >
              <span>
                <strong>{item.namespace}</strong>
                <small>{item.packageId}</small>
              </span>
            </RowButton>
          ))}
        </div>
        <Pagination label="Live tables" variant="rail" {...pagination} />
      </aside>
      <div className="fd-workspace-main">
        <div className="fd-workspace-titlebar">
          <div>
            <h2>{table?.namespace ?? "No state tables"}</h2>
            <p>{table?.packageId} · live runtime state · sensitive fields redacted</p>
          </div>
          <IconButton
            label="Refresh live records"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={15} />
          </IconButton>
        </div>
        {error === undefined ? null : (
          <div className="fd-local-note">
            <InlineMessage tone="danger">{error}</InlineMessage>
          </div>
        )}
        <ScrollArea label="Live records" resetKey={`${table?.id}:${after ?? ""}`}>
          {loading ? (
            <PageLoader label="Reading live state" />
          ) : table === undefined ? (
            <EmptyState title="No matching live tables">
              The running tools may declare no persistent state. Clear the table search to see all declared
              namespaces.
            </EmptyState>
          ) : page === undefined ? (
            <EmptyState
              title="Live records unavailable"
              action={<Button onClick={() => setRevision((value) => value + 1)}>Retry</Button>}
            >
              Retry the live-state request. Starting source data has not been substituted.
            </EmptyState>
          ) : page.records.length === 0 ? (
            <EmptyState title="No live records">
              This table is currently empty. Tool calls may create records here.
            </EmptyState>
          ) : (
            <table className="fd-table">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Current values</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {page.records.map((row) => (
                  <tr key={row.rowId}>
                    <td>
                      <code>{row.rowId}</code>
                    </td>
                    <td>
                      <span className="fd-local-record-summary">
                        {Object.entries(row.value)
                          .map(([key, value]) => `${key}: ${recordCell(value)}`)
                          .join(" · ")}
                      </span>
                    </td>
                    <td>
                      <DataViewer
                        title={`Live ${table.namespace} / ${row.rowId}`}
                        value={row.value}
                        label="View record"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ScrollArea>
        <div className="fd-local-page-controls">
          <span>
            {plural(page?.records.length ?? 0, "record")} · page {cursors.length}
          </span>
          <div>
            <Button
              size="compact"
              disabled={loading || cursors.length === 1}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous records
            </Button>
            <Button
              size="compact"
              disabled={loading || page?.nextRowId === undefined}
              onClick={() => setCursors((value) => [...value, page?.nextRowId])}
            >
              Next records
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveActivity({ runtime }: { readonly runtime: RunningEnvironment }) {
  const [starts, setStarts] = useState<readonly number[]>([1]);
  const [page, setPage] = useState<EnvironmentActivityPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const from = starts.at(-1) ?? 1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit retry/refresh control.
  useEffect(() => {
    let current = true;
    let pending = false;
    const read = () => {
      if (pending) return;
      pending = true;
      void inspectorApi
        .environmentActivity(runtime.description.generation, from)
        .then((next) => {
          if (!current) return;
          if (
            next.worldInstanceId !== runtime.metadata.worldInstanceId ||
            next.generation !== runtime.description.generation
          )
            throw new Error("The environment reset. Refresh status to read its current activity.");
          setPage(next);
          setError(undefined);
        })
        .catch((failure: unknown) => {
          if (current) setError(message(failure));
        })
        .finally(() => {
          pending = false;
          if (current) setLoading(false);
        });
    };
    setLoading(true);
    setPage(undefined);
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, 2000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [runtime.metadata.worldInstanceId, runtime.description.generation, from, revision]);
  return (
    <>
      <div className="fd-local-toolbar">
        <p className="fd-local-count">
          Durable world journal · operator calls are separate from binding traffic
        </p>
        <Button onClick={() => setRevision((value) => value + 1)} disabled={loading}>
          <RefreshCw size={15} />
          Refresh activity
        </Button>
      </div>
      {error === undefined ? null : (
        <div className="fd-local-note">
          <InlineMessage tone="danger">{error}</InlineMessage>
        </div>
      )}
      <ScrollArea label="Live environment activity" resetKey={String(from)}>
        {loading ? (
          <PageLoader label="Reading durable activity" />
        ) : page === undefined ? (
          <EmptyState
            title="Activity unavailable"
            action={<Button onClick={() => setRevision((value) => value + 1)}>Retry</Button>}
          >
            No activity has been invented. Retry the journal request.
          </EmptyState>
        ) : page.entries.length === 0 ? (
          <EmptyState title="No activity on this page">
            Test a tool or connect your agent. Its calls and state changes will be recorded here.
          </EmptyState>
        ) : (
          <table className="fd-table">
            <thead>
              <tr>
                <th>Sequence</th>
                <th>Activity</th>
                <th>Origin</th>
                <th>World time</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((entry) => (
                <tr key={entry.sequence}>
                  <td>
                    <code>{entry.sequence}</code>
                  </td>
                  <td>
                    <strong>{evidenceLabel(entry)}</strong>
                    <p className="fd-local-count">
                      {entry.kind === "operation"
                        ? `Tool call · ${entry.outcome.status}`
                        : entry.kind.replaceAll("_", " ")}
                    </p>
                  </td>
                  <td>
                    {entry.initiator === "operator"
                      ? "Operator · test tool"
                      : entry.initiator === "binding"
                        ? "Binding traffic"
                        : "World runtime"}
                  </td>
                  <td>
                    <code>{virtualTime(entry.virtualTimeUs)}</code>
                  </td>
                  <td>
                    <DataViewer title={`Activity ${entry.sequence}`} value={entry} label="View evidence" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ScrollArea>
      <div className="fd-local-page-controls">
        <span>
          {plural(page?.entries.length ?? 0, "entry", "entries")} · from sequence {from}
        </span>
        <div>
          <Button
            size="compact"
            disabled={loading || starts.length === 1}
            onClick={() => setStarts((value) => value.slice(0, -1))}
          >
            Previous activity
          </Button>
          <Button
            size="compact"
            disabled={loading || (page?.entries.length ?? 0) < 50}
            onClick={() => setStarts((value) => [...value, page?.nextSequence ?? from])}
          >
            Next activity
          </Button>
        </div>
      </div>
      <p className="fd-local-note">
        Binding traffic proves a client called a tool, not that an agent passed a test. Run a drill for
        assertions and a saved result.
      </p>
    </>
  );
}

export function EnvironmentView({
  project,
  environment,
  tab,
  onVisit,
}: {
  readonly project: SimulationProject;
  readonly environment: EnvironmentControls;
  readonly tab: "state" | "activity";
  readonly onVisit: (href: string) => void;
}) {
  const runtime = environment.status?.available ? environment.status : undefined;
  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <h1>State & activity</h1>
        <div className="fd-local-connection-actions">
          {runtime === undefined || environment.error !== undefined ? null : (
            <ResetEnvironmentDialog runtime={runtime} onReset={environment.refresh} />
          )}
          <Button onClick={() => onVisit("/connect")}>
            <Plug size={15} />
            Connect agent
          </Button>
        </div>
      </header>
      {environment.error !== undefined ? (
        <InlineMessage tone="danger">
          {environment.error} <Button onClick={() => void environment.refresh()}>Retry</Button>
        </InlineMessage>
      ) : null}
      <div className="fd-local-frame">
        {environment.status === undefined ? (
          <PageLoader label="Reading environment status" />
        ) : runtime === undefined ? (
          <EnvironmentUnavailable project={project} />
        ) : (
          <>
            <div className="fd-workspace-titlebar">
              <div>
                <h2>{runtime.description.worldId}</h2>
                <p>
                  <code>{runtime.metadata.worldInstanceId}</code> ·{" "}
                  {runtime.description.scenarioId ?? "World baseline"} · generation{" "}
                  {runtime.description.generation}
                </p>
              </div>
              <Status tone={environment.error === undefined ? "info" : "warning"}>
                {environment.error === undefined ? "Running locally" : "Status unavailable"}
              </Status>
            </div>
            <nav className="fd-local-tabs" aria-label="Environment views">
              <Button variant="quiet" aria-pressed={tab === "state"} onClick={() => onVisit("/environment")}>
                <Database size={15} />
                Live state
              </Button>
              <Button
                variant="quiet"
                aria-pressed={tab === "activity"}
                onClick={() => onVisit("/environment?tab=activity")}
              >
                <Activity size={15} />
                Activity
              </Button>
            </nav>
            {tab === "state" ? (
              <LiveState
                key={`${runtime.metadata.worldInstanceId}:${runtime.description.generation}`}
                runtime={runtime}
              />
            ) : (
              <LiveActivity
                key={`${runtime.metadata.worldInstanceId}:${runtime.description.generation}`}
                runtime={runtime}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function ConnectAgentView({
  project,
  environment,
  onVisit,
}: {
  readonly project: SimulationProject;
  readonly environment: EnvironmentControls;
  readonly onVisit: (href: string) => void;
}) {
  const [connections, setConnections] = useState<EnvironmentConnections>();
  const [protocol, setProtocol] = useState("http");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const runtime = environment.status?.available ? environment.status : undefined;
  const worldId = runtime?.metadata.worldInstanceId;
  const connection =
    runtime?.connections.find((item) => item.protocol === protocol) ?? runtime?.connections[0];
  const revealedConnection =
    connections?.worldInstanceId === worldId
      ? connections?.connections.find((item) => item.protocol === connection?.protocol)
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection secrets must not survive a world switch.
  useEffect(() => {
    setConnections(undefined);
    setError(undefined);
  }, [worldId]);
  const reveal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await inspectorApi.environmentConnections();
      if (next.worldInstanceId !== worldId)
        throw new Error("The environment changed. Refresh its status before revealing connection values.");
      setConnections(next);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <h1>Connect agent</h1>
        <Button onClick={() => onVisit("/environment?tab=activity")}>
          View activity
          <ArrowRight size={15} />
        </Button>
      </header>
      <div className="fd-local-frame">
        <ScrollArea label="Agent connection instructions">
          {environment.error !== undefined ? (
            <div className="fd-local-section">
              <InlineMessage tone="danger">{environment.error}</InlineMessage>
              <Button onClick={() => void environment.refresh()}>Retry environment</Button>
            </div>
          ) : environment.status === undefined ? (
            <PageLoader label="Reading available connections" />
          ) : runtime === undefined ? (
            <EnvironmentUnavailable project={project} />
          ) : (
            <section className="fd-local-section">
              <h2>Point your existing agent at this environment</h2>
              <p>
                Point your agent’s existing tool connection at this local environment. Run your agent with its
                usual model and API key.
              </p>
              {runtime.connections.length === 0 ? (
                <InlineMessage tone="warning">
                  This environment has no exposed binding. Start it with an HTTP, MCP, or CLI binding before
                  connecting a separate agent process.
                </InlineMessage>
              ) : (
                <>
                  <nav className="fd-local-connection-actions" aria-label="Connection protocol">
                    {runtime.connections.map((item) => (
                      <Button
                        key={item.protocol}
                        aria-pressed={connection?.protocol === item.protocol}
                        onClick={() => setProtocol(item.protocol)}
                      >
                        {item.protocol.toUpperCase()}
                      </Button>
                    ))}
                  </nav>
                  {connection === undefined ? null : <ConnectionEndpoint connection={connection} />}
                  <div className="fd-local-connection-actions">
                    <Button
                      disabled={busy}
                      onClick={() => (connections === undefined ? void reveal() : setConnections(undefined))}
                    >
                      {busy ? <Spinner label="Reading connection values" /> : null}
                      {connections === undefined ? "Reveal connection values" : "Hide connection values"}
                    </Button>
                  </div>
                  <p>These values grant local tool access. Keep them out of source control.</p>
                </>
              )}
              {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
              {revealedConnection === undefined ? null : (
                <ConnectionSetup key={revealedConnection.protocol} connection={revealedConnection} />
              )}
            </section>
          )}
          <section className="fd-local-section">
            <h2>Check its actions</h2>
            <p>Run a task in your agent, then inspect its tool traffic and live state.</p>
          </section>
          <section className="fd-local-section">
            <h2>Make it repeatable with a drill</h2>
            <p>
              When the agent is connected, define its task and expected consequences in a drill. Each drill
              run has its own controlled world and saved result.
            </p>
            {project.targets.length === 0 ? null : (
              <PaginatedContent items={project.targets} label="Agent targets">
                {(targets) => (
                  <table className="fd-table">
                    <thead>
                      <tr>
                        <th>Target</th>
                        <th>Launch method</th>
                        <th>Inspector execution</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targets.map((target) => (
                        <tr key={target.id}>
                          <td>
                            <code>{target.id}</code>
                          </td>
                          <td>{target.kind}</td>
                          <td>
                            {target.runAvailability === "ready"
                              ? "Runnable target declared"
                              : "Caller-owned agent callback required"}
                          </td>
                          <td>
                            {target.source?.readable ? (
                              <SourceViewer kind="target" id={target.id} label="View target" />
                            ) : (
                              "Source unavailable"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </PaginatedContent>
            )}
            <Button onClick={() => onVisit("/drills")}>
              Open drills
              <ArrowRight size={15} />
            </Button>
          </section>
        </ScrollArea>
      </div>
    </section>
  );
}
