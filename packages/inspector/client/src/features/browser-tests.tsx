import { Download, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { browserApi, InspectorApiError } from "../api";
import type {
  BrowserAvailability,
  BrowserReportPage,
  BrowserRequest,
  BrowserSavedPage,
  BrowserTestResult,
} from "../browser-types";
import { CodeDocument } from "../components/code-document";
import { DataViewer } from "../components/data-viewer";
import { PaginatedContent, Pagination } from "../components/pagination";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  InlineMessage,
  Input,
  PageLoader,
  RowButton,
  Spinner,
} from "../components/primitives";
import { ValueDiff } from "../components/value-diff";
import "./browser-tests.css";

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The browser request could not complete. Retry this action.";
}

function BrowserResult({ result }: { readonly result: BrowserTestResult }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    section.current?.scrollIntoView({ block: "start" });
  }, []);
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState<string>();
  const download = async (path: string) => {
    setError(undefined);
    setDownloading(path);
    try {
      const blob =
        path === "bundle"
          ? await browserApi.bundle(result.runId)
          : await browserApi.artifact(result.runId, path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = path === "bundle" ? `${result.runId}.tar.gz` : path;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setDownloading(undefined);
    }
  };
  return (
    <section ref={section} className="fd-browser-result" aria-label="Browser result">
      <div className="fd-browser-section-heading">
        <h2>
          {result.definition.title ?? result.definition.id} — {result.status}
        </h2>
        <span>{(result.durationMs / 1000).toFixed(1)}s</span>
      </div>
      {result.definition.assertions.length === 0 ? (
        <p>No independent assertions were configured; this is not a passing test.</p>
      ) : (
        <PaginatedContent
          items={result.definition.assertions}
          label="Browser assertions"
          resetKey={result.runId}
          pageSize={5}
        >
          {(assertions) => (
            <div className="fd-browser-assertions">
              {assertions.map((configured) => {
                const assertion = result.assertions.find((item) => item.id === configured.id);
                if (!assertion)
                  return (
                    <div key={configured.id}>
                      <h3>{configured.id} — Not evaluated</h3>
                      <p>Execution stopped before this check was reached.</p>
                    </div>
                  );
                return (
                  <div key={assertion.id}>
                    <h3>
                      {assertion.id} — {assertion.passed ? "Passed" : "Failed"}
                    </h3>
                    <ValueDiff
                      before={assertion.expected}
                      after={assertion.actual}
                      beforeLabel="Expected"
                      afterLabel="Actual"
                    />
                    {assertion.actualTruncation || assertion.expectedTruncation ? (
                      <p>
                        Long values are shown as shortened previews. The assertion compared the complete page
                        value.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </PaginatedContent>
      )}
      {result.errors.map((error) => (
        <InlineMessage tone="danger" key={`${error.code}:${error.message}`}>
          {error.message}
        </InlineMessage>
      ))}
      <p className="fd-browser-note">
        Browser assertions check the page. Use a drill to also verify tool calls and synthetic world state.
      </p>
      <div className="fd-local-connection-actions">
        <Button onClick={() => void download("bundle")} disabled={downloading !== undefined}>
          <Download size={15} />
          Download report bundle
        </Button>
      </div>
      <PaginatedContent
        items={result.artifacts.filter((artifact) => artifact.path !== "index.html")}
        label="Browser artifacts"
        resetKey={result.runId}
        pageSize={8}
      >
        {(artifacts) => (
          <div className="fd-browser-artifacts">
            {artifacts.map((artifact) => (
              <Button
                key={artifact.path}
                onClick={() => void download(artifact.path)}
                disabled={downloading !== undefined}
              >
                <Download size={14} />
                {artifact.path}
                {downloading === artifact.path ? <Spinner label="Downloading artifact" /> : null}
              </Button>
            ))}
          </div>
        )}
      </PaginatedContent>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
    </section>
  );
}

export function BrowserTestsView() {
  const fieldId = useId();
  const [availability, setAvailability] = useState<BrowserAvailability>();
  const [saved, setSaved] = useState<BrowserSavedPage>();
  const [reports, setReports] = useState<BrowserReportPage>();
  const [savedPage, setSavedPage] = useState(0);
  const [reportPage, setReportPage] = useState(0);
  const [selection, setSelection] = useState<BrowserSavedPage["items"][number]>();
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [url, setUrl] = useState("");
  const [task, setTask] = useState("");
  const [expected, setExpected] = useState("");
  const [allowModel, setAllowModel] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const [origins, setOrigins] = useState("");
  const [video, setVideo] = useState(false);
  const [trace, setTrace] = useState(false);
  const [stepTimeoutSeconds, setStepTimeoutSeconds] = useState("30");
  const [request, setRequest] = useState<BrowserRequest>();
  const [result, setResult] = useState<BrowserTestResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedPath, setSavedPath] = useState<string>();
  const composer = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const running = request?.status === "running";
  const requestId = request?.requestId;
  const requestStatus = request?.status;
  const needsAgent =
    selection === undefined ||
    (selection.definition.steps.length === 0 && Boolean(selection.definition.task));
  const parameterNames = [
    ...new Set(
      (selection?.definition.steps ?? []).flatMap((step) =>
        step.action === "fill" && step.parameter ? [step.parameter] : [],
      ),
    ),
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly rereads optional-package availability.
  useEffect(() => {
    let active = true;
    void browserApi
      .availability()
      .then((value) => {
        if (active) {
          setAvailability(value);
          if (value.activeRequestId)
            setRequest((current) =>
              current?.requestId === value.activeRequestId
                ? current
                : { requestId: value.activeRequestId ?? "", status: "running", events: [] },
            );
        }
      })
      .catch((failure) => {
        if (active) setError(message(failure));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed run or source save invalidates both paginated collections.
  useEffect(() => {
    if (!availability?.available) return;
    let active = true;
    void Promise.all([browserApi.saved(savedPage), browserApi.reports(reportPage)])
      .then(([tests, history]) => {
        if (active) {
          setSavedPage((page) => Math.min(page, Math.max(0, Math.ceil(tests.total / 10) - 1)));
          setReportPage((page) => Math.min(page, Math.max(0, Math.ceil(history.total / 10) - 1)));
          setSaved(tests);
          setReports(history);
        }
      })
      .catch((failure) => {
        if (active) setError(message(failure));
      });
    return () => {
      active = false;
    };
  }, [availability?.available, savedPage, reportPage, revision]);
  useEffect(() => {
    if (requestId === undefined || requestStatus !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await browserApi.status(requestId);
        if (!active) return;
        setRequest(next);
        if (next.result) {
          setResult(next.result);
          setRevision((value) => value + 1);
        }
        if (next.error) setError(next.error.message);
        if (next.status === "running") timer = setTimeout(() => void poll(), 750);
      } catch (failure) {
        if (active) {
          if (failure instanceof InspectorApiError && failure.status === 404) {
            setRequest((current) =>
              current?.requestId === requestId ? { ...current, status: "failed" } : current,
            );
            setError(
              "The inspector no longer owns this browser request. Open its saved result below, or start a new test.",
            );
            setRevision((value) => value + 1);
            return;
          }
          setError(message(failure));
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [requestId, requestStatus]);
  const act = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      const started = await browserApi.start({
        ...(selection === undefined
          ? {
              definition: {
                schemaVersion: 1 as const,
                id: "browser-task",
                startUrl: url.trim(),
                task: task.trim(),
                assertions:
                  expected.trim() === ""
                    ? []
                    : [
                        {
                          id: "expected-page-text",
                          kind: "text" as const,
                          selector: { by: "css" as const, value: "body" },
                          expected: expected.trim(),
                          contains: true,
                        },
                      ],
              },
            }
          : { path: selection.path }),
        useAgent: needsAgent,
        allowModel: needsAgent && allowModel,
        allowRemote,
        allowedOrigins: origins
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
        parameters,
        stepTimeoutMs: Number(stepTimeoutSeconds) * 1000,
        capture: { screenshot: "always", video: video ? "always" : "off", trace: trace ? "always" : "off" },
      });
      setRequest({ ...started, events: [] });
      setResult(undefined);
      setSavedPath(undefined);
    });
  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <div className="fd-page-intro">
          <h1>Browser tests</h1>
          <p>Exercise your agent through its real UI, then check what appeared on the page.</p>
        </div>
        <Button
          onClick={() => {
            setError(undefined);
            setRevision((value) => value + 1);
          }}
          disabled={busy}
        >
          <RefreshCw size={15} />
          Refresh
        </Button>
      </header>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      {availability === undefined ? (
        <PageLoader label="Checking browser tools" />
      ) : !availability.available ? (
        <div className="fd-browser-workspace">
          <EmptyState title="Add browser testing when you need it">
            The rest of Firedrill works without a browser. Install the optional package and Chromium, then
            restart the inspector.
          </EmptyState>
          <CodeDocument
            content="pnpm add -D @firedrill-tools/browser-tests\npnpm dlx playwright@1.62.1 install chromium"
            language="bash"
            context="Install browser testing"
          />
        </div>
      ) : (
        <div className="fd-browser-workspace">
          <div className="fd-browser-compose">
            <div className="fd-browser-form" ref={composer}>
              <div className="fd-browser-section-heading">
                <h2>
                  {selection ? (selection.definition.title ?? selection.definition.id) : "New browser test"}
                </h2>
                {selection ? (
                  <Button
                    size="compact"
                    onClick={() => {
                      setSelection(undefined);
                      setParameters({});
                    }}
                    disabled={running || busy}
                  >
                    New test
                  </Button>
                ) : null}
              </div>
              {selection ? (
                <>
                  <p>
                    Run the steps in <code>{selection.path}</code>.
                  </p>
                  <p>
                    {selection.definition.steps.length} saved steps · {selection.definition.assertions.length}{" "}
                    assertions
                  </p>
                  <DataViewer title={selection.path} value={selection.definition} label="View test source" />
                </>
              ) : (
                <>
                  <label className="fd-local-field" htmlFor={`${fieldId}-url`}>
                    Application URL
                    <Input
                      id={`${fieldId}-url`}
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="http://localhost:3000"
                      disabled={running || busy}
                    />
                  </label>
                  <label className="fd-local-field" htmlFor={`${fieldId}-task`}>
                    What should the browser do?
                    <textarea
                      className="fd-input"
                      id={`${fieldId}-task`}
                      rows={4}
                      value={task}
                      onChange={(event) => setTask(event.target.value)}
                      placeholder="Describe the task to perform in your app."
                      disabled={running || busy}
                    />
                  </label>
                  <label className="fd-local-field" htmlFor={`${fieldId}-expected`}>
                    Expected page text (optional)
                    <Input
                      id={`${fieldId}-expected`}
                      value={expected}
                      onChange={(event) => setExpected(event.target.value)}
                      placeholder="Text that must appear for the test to pass"
                      disabled={running || busy}
                    />
                  </label>
                </>
              )}
              {parameterNames.length === 0 ? null : (
                <section className="fd-browser-parameters">
                  <h3>Runtime inputs</h3>
                  <p>Used for this test only, never saved in its source.</p>
                  <PaginatedContent
                    items={parameterNames}
                    label="Runtime inputs"
                    resetKey={selection?.path ?? "new"}
                    pageSize={5}
                  >
                    {(names) =>
                      names.map((name) => (
                        <label className="fd-local-field" key={name} htmlFor={`${fieldId}-param-${name}`}>
                          {name}
                          <Input
                            id={`${fieldId}-param-${name}`}
                            type="password"
                            autoComplete="off"
                            value={parameters[name] ?? ""}
                            disabled={running || busy}
                            onChange={(event) =>
                              setParameters((previous) => ({ ...previous, [name]: event.target.value }))
                            }
                          />
                        </label>
                      ))
                    }
                  </PaginatedContent>
                </section>
              )}
              {needsAgent ? (
                !availability.agentAvailable || !availability.apiKeyConfigured ? (
                  <InlineMessage tone="info">
                    Natural-language tasks use the optional Firedrill Agent. Install{" "}
                    <code>@firedrill-tools/agent</code>, set <code>ANTHROPIC_API_KEY</code> in the terminal,
                    and restart the inspector. Saved steps need neither.
                  </InlineMessage>
                ) : (
                  <label className="fd-browser-check">
                    <input
                      type="checkbox"
                      checked={allowModel}
                      onChange={(event) => setAllowModel(event.target.checked)}
                      disabled={running || busy}
                    />
                    Use my configured model key for this task (up to $2).
                  </label>
                )
              ) : (
                <p>Saved steps run without a model or an API key.</p>
              )}
              <label className="fd-browser-check">
                <input
                  type="checkbox"
                  checked={allowRemote}
                  onChange={(event) => setAllowRemote(event.target.checked)}
                  disabled={running || busy}
                />
                Allow a remote application I am authorized to test.
              </label>
              <label className="fd-local-field" htmlFor={`${fieldId}-origins`}>
                Other allowed origins (optional)
                <Input
                  id={`${fieldId}-origins`}
                  value={origins}
                  onChange={(event) => setOrigins(event.target.value)}
                  placeholder="Separate origins with commas"
                  disabled={running || busy}
                />
              </label>
              <div className="fd-browser-capture">
                <label className="fd-browser-check">
                  <input
                    type="checkbox"
                    checked={video}
                    onChange={(event) => setVideo(event.target.checked)}
                    disabled={running || busy}
                  />
                  Record video
                </label>
                <label className="fd-browser-check">
                  <input
                    type="checkbox"
                    checked={trace}
                    onChange={(event) => setTrace(event.target.checked)}
                    disabled={running || busy}
                  />
                  Capture trace
                </label>
              </div>
              <label className="fd-local-field" htmlFor={`${fieldId}-wait`}>
                Wait for each action or assertion (seconds)
                <Input
                  id={`${fieldId}-wait`}
                  type="number"
                  min={1}
                  max={60}
                  value={stepTimeoutSeconds}
                  onChange={(event) => setStepTimeoutSeconds(event.target.value)}
                  disabled={running || busy}
                />
              </label>
              <p>Captured pages may contain sensitive data. Keep reports local until reviewed.</p>
              <div className="fd-local-connection-actions">
                {running ? (
                  <Button variant="danger" onClick={() => setCancelOpen(true)} disabled={busy}>
                    <Square size={14} />
                    Stop test
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => void start()}
                    disabled={
                      busy ||
                      !Number.isInteger(Number(stepTimeoutSeconds)) ||
                      Number(stepTimeoutSeconds) < 1 ||
                      Number(stepTimeoutSeconds) > 60 ||
                      parameterNames.some((name) => !Object.hasOwn(parameters, name)) ||
                      (selection === undefined && (!url.trim() || !task.trim())) ||
                      (needsAgent &&
                        (!allowModel || !availability.agentAvailable || !availability.apiKeyConfigured))
                    }
                  >
                    <Play size={15} />
                    {busy ? "Starting…" : "Run browser test"}
                  </Button>
                )}
              </div>
            </div>
            <section className="fd-browser-preview" aria-label="Browser activity">
              <h2>{running ? "Live browser" : result ? "Recorded browser actions" : "Browser activity"}</h2>
              {request?.frame ? (
                <img
                  src={`data:image/jpeg;base64,${request.frame.base64}`}
                  alt="Current page in the controlled test browser"
                />
              ) : (
                <div className="fd-browser-placeholder">
                  {running
                    ? "Opening the application…"
                    : result
                      ? "Open the captured screenshot or recording in this result below."
                      : "The browser appears here while your test runs."}
                </div>
              )}
              {request || result ? (
                <PaginatedContent
                  items={running ? (request?.events ?? []) : (result?.events ?? request?.events ?? [])}
                  label="Browser actions"
                  resetKey={
                    running
                      ? (request?.requestId ?? "active")
                      : (result?.runId ?? request?.requestId ?? "result")
                  }
                  pageSize={10}
                >
                  {(events) => (
                    <ol className="fd-browser-events">
                      {events.map((event) => (
                        <li key={event.sequence}>{event.message}</li>
                      ))}
                    </ol>
                  )}
                </PaginatedContent>
              ) : null}
            </section>
          </div>
          {result ? <BrowserResult key={result.runId} result={result} /> : null}
          {result && !running ? (
            <section className="fd-browser-save">
              <h2>Reuse this flow</h2>
              {!result.replayable ? (
                <InlineMessage tone="warning">
                  This recording needs source review before reuse. {result.replayIssues.join(" ")}
                </InlineMessage>
              ) : savedPath ? (
                <InlineMessage tone="success">
                  Saved <code>{savedPath}</code>. Review it before committing.
                </InlineMessage>
              ) : (
                <>
                  <label className="fd-local-field" htmlFor={`${fieldId}-save`}>
                    Test ID
                    <Input
                      id={`${fieldId}-save`}
                      value={saveName}
                      onChange={(event) => setSaveName(event.target.value)}
                      placeholder="first-conversation"
                    />
                  </label>
                  <Button
                    disabled={busy || !saveName.trim()}
                    onClick={() =>
                      void act(async () => {
                        const saved = await browserApi.saveReport(result.runId, saveName.trim());
                        setSavedPath(saved.path);
                        setRevision((value) => value + 1);
                      })
                    }
                  >
                    Save reusable test
                  </Button>
                </>
              )}
            </section>
          ) : null}
          <section className="fd-browser-collection">
            <h2>Saved tests</h2>
            {saved?.items.length === 0 ? (
              <p>
                No saved browser tests yet. Save a completed flow or add a <code>.browser.json</code> file.
              </p>
            ) : (
              saved?.items.map((test) => (
                <RowButton
                  key={test.path}
                  disabled={running || busy}
                  onClick={() => {
                    setSelection(test);
                    setParameters({});
                    composer.current?.scrollIntoView({ block: "start" });
                    setAllowModel(false);
                  }}
                >
                  {test.definition.title ?? test.definition.id}
                  <span>
                    {test.definition.steps.length} steps · {test.definition.assertions.length} assertions
                  </span>
                </RowButton>
              ))
            )}
            {saved?.diagnostics.map((diagnostic) => (
              <InlineMessage key={diagnostic.path} tone="warning">
                {diagnostic.path}: {diagnostic.message}
              </InlineMessage>
            ))}
            <Pagination
              label="Saved browser tests"
              page={savedPage}
              pageSize={10}
              total={saved?.total ?? 0}
              onPageChange={setSavedPage}
              disabled={busy}
            />
          </section>
          <section className="fd-browser-collection">
            <h2>Recent results</h2>
            {reports?.items.length === 0 ? (
              <p>Browser results will appear here after the first test.</p>
            ) : (
              reports?.items.map((report) => (
                <RowButton
                  key={report.runId}
                  disabled={busy || running}
                  onClick={() =>
                    void act(async () => {
                      setSavedPath(undefined);
                      const selectedReport = await browserApi.report(report.runId);
                      setRequest(undefined);
                      setResult(selectedReport);
                    })
                  }
                >
                  {report.title}
                  <span>
                    {report.status} · {report.passedAssertions}/{report.assertions} checks ·{" "}
                    {new Date(report.startedAt).toLocaleString()}
                  </span>
                </RowButton>
              ))
            )}
            {reports?.diagnostics.map((diagnostic) => (
              <InlineMessage key={diagnostic.path} tone="warning">
                {diagnostic.message}
              </InlineMessage>
            ))}
            <Pagination
              label="Browser results"
              page={reportPage}
              pageSize={10}
              total={reports?.total ?? 0}
              onPageChange={setReportPage}
              disabled={busy}
            />
          </section>
        </div>
      )}
      <ConfirmDialog
        open={cancelOpen}
        title="Stop this browser test?"
        description="The browser will close. Completed actions are not undone; available evidence will be saved."
        confirmLabel="Stop test"
        busy={busy}
        onClose={() => setCancelOpen(false)}
        onConfirm={() =>
          void act(async () => {
            if (request) await browserApi.cancel(request.requestId);
            setCancelOpen(false);
          })
        }
      />
    </section>
  );
}
