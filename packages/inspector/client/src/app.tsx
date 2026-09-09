import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { inspectorApi } from "./api";
import { Button, IconButton, PageLoader } from "./components/primitives";
import { AppShell } from "./components/shell";
import { BrowserTestsView } from "./features/browser-tests";
import { CatalogView } from "./features/catalog";
import { DrillsView } from "./features/drills";
import {
  ConnectAgentView,
  EnvironmentBanner,
  EnvironmentView,
  TestTool,
  useEnvironment,
} from "./features/environment";
import { type RunHistoryControls, RunsView } from "./features/runs";
import { ToolsView } from "./features/tools";
import { WorldView } from "./features/world";
import {
  navigateInspector,
  readInspectorLocation,
  readRunSelection,
  readScenarioId,
  readToolSelection,
  runHref,
  scenarioHref,
} from "./navigation";
import type {
  Notice,
  Route,
  SimulationProject,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunSummary,
  StartSimulationRun,
} from "./types";

export interface RunHistory {
  readonly runs: readonly SimulationRunSummary[];
  readonly unavailable: SimulationRunList["unavailable"];
  readonly nextCursor: string | undefined;
  readonly loadedOlder: boolean;
  readonly revisions: ReadonlyMap<string, number>;
}

export function emptyRunHistory(): RunHistory {
  return { runs: [], unavailable: [], nextCursor: undefined, loadedOlder: false, revisions: new Map() };
}

/** Poll only the newest page; continuation retains its own oldest-loaded cursor and every prior page. */
export function mergeRunHistory(
  previous: RunHistory,
  page: SimulationRunList,
  direction: "latest" | "older",
  revision: number,
): RunHistory {
  const runs = new Map(previous.runs.map((run) => [run.runId, run]));
  const unavailable = new Map(previous.unavailable.map((report) => [report.runId, report]));
  const revisions = new Map(previous.revisions);
  const tracked = (run: SimulationRunSummary) =>
    run.requestId !== undefined || ["queued", "running", "cancelling"].includes(run.status);
  if (direction === "latest") {
    const present = new Set(page.runs.map((run) => run.runId));
    for (const run of previous.runs) {
      if (!tracked(run) || present.has(run.runId) || (revisions.get(run.runId) ?? -1) > revision) continue;
      // Every tracked attempt is returned on every page. Its absence is not a recorded terminal verdict.
      runs.delete(run.runId);
      revisions.set(run.runId, revision);
    }
  }
  const knownSavedIds = new Set([
    ...previous.runs.filter((run) => run.reportAvailable && !tracked(run)).map((run) => run.runId),
    ...previous.unavailable.map((report) => report.runId),
  ]);
  const incomingSavedIds = [
    ...page.runs.filter((run) => run.reportAvailable && !tracked(run)).map((run) => run.runId),
    ...page.unavailable.map((report) => report.runId),
  ];
  const reopenContinuation =
    direction === "latest" &&
    previous.loadedOlder &&
    page.nextCursor !== undefined &&
    incomingSavedIds.length > 0 &&
    !incomingSavedIds.some((id) => knownSavedIds.has(id));
  for (const run of page.runs) {
    const previousRevision = revisions.get(run.runId) ?? -1;
    // A missing active summary is only an unknown, not evidence contradicting a
    // verified saved report that was fetched concurrently from an older page.
    if (
      previousRevision > revision &&
      (runs.has(run.runId) || unavailable.has(run.runId) || !run.reportAvailable || tracked(run))
    )
      continue;
    runs.set(run.runId, run);
    unavailable.delete(run.runId);
    revisions.set(run.runId, Math.max(previousRevision, revision));
  }
  for (const report of page.unavailable) {
    if ((revisions.get(report.runId) ?? -1) > revision) continue;
    unavailable.set(report.runId, report);
    runs.delete(report.runId);
    revisions.set(report.runId, revision);
  }
  const runOrder =
    direction === "latest" ? [...page.runs, ...previous.runs] : [...previous.runs, ...page.runs];
  const unavailableOrder =
    direction === "latest"
      ? [...page.unavailable, ...previous.unavailable]
      : [...previous.unavailable, ...page.unavailable];
  return {
    runs: [...new Set(runOrder.map((run) => run.runId))].flatMap((id) => {
      const run = runs.get(id);
      return run === undefined ? [] : [run];
    }),
    unavailable: [...new Set(unavailableOrder.map((report) => report.runId))].flatMap((id) => {
      const report = unavailable.get(id);
      return report === undefined ? [] : [report];
    }),
    nextCursor:
      direction === "older" || !previous.loadedOlder || reopenContinuation
        ? page.nextCursor
        : previous.nextCursor,
    loadedOlder: previous.loadedOlder || direction === "older",
    revisions,
  };
}

/** Independent request lanes can overlap, but superseded requests and previous source generations cannot apply. */
export function createRunListGuard() {
  let generation = 0;
  let sequence = 0;
  let active = true;
  const lanes = new Map<string, number>();
  return {
    begin(lane: "latest" | "older" | "source") {
      const epoch = generation;
      const revision = ++sequence;
      lanes.set(lane, revision);
      return { revision, isCurrent: () => active && generation === epoch && lanes.get(lane) === revision };
    },
    invalidate() {
      generation += 1;
    },
    activate() {
      active = true;
      generation += 1;
    },
    dispose() {
      active = false;
      generation += 1;
    },
  };
}

function Notices({
  notices,
  onDismiss,
}: {
  readonly notices: readonly Notice[];
  readonly onDismiss: (id: number) => void;
}) {
  return (
    <div className="fd-notices" aria-live="polite">
      {notices.map((notice) => {
        const Icon =
          notice.tone === "success"
            ? CheckCircle2
            : notice.tone === "warning"
              ? AlertTriangle
              : notice.tone === "danger"
                ? XCircle
                : Info;
        return (
          <div className="fd-notice" data-tone={notice.tone} key={notice.id}>
            <Icon size={17} aria-hidden="true" />
            <span>{notice.message}</span>
            <IconButton label="Dismiss" onClick={() => onDismiss(notice.id)}>
              <X size={15} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [location, setLocation] = useState(() => readInspectorLocation(window.location));
  const route = location.route;
  const environment = useEnvironment();
  const [project, setProject] = useState<SimulationProject>();
  const [history, setHistory] = useState<RunHistory>(emptyRunHistory);
  const [requests, setRequests] = useState<readonly SimulationRunRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const noticeId = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [latestError, setLatestError] = useState<string>();
  const [runListGuard] = useState(createRunListGuard);
  const latestPending = useRef<Promise<void> | undefined>(undefined);
  const olderPending = useRef(false);
  const sourceRefreshing = useRef(false);

  const notify = useCallback((tone: Notice["tone"], message: string) => {
    noticeId.current += 1;
    const id = noticeId.current;
    setNotices((value) => [...value, { id, tone, message }].slice(-3));
    window.setTimeout(() => setNotices((value) => value.filter((notice) => notice.id !== id)), 6_000);
  }, []);

  const showError = useCallback((message: string) => notify("danger", message), [notify]);

  const readRuntime = useCallback(
    (force = false): Promise<void> => {
      if (sourceRefreshing.current && !force) return Promise.resolve();
      if (latestPending.current !== undefined && !force) return latestPending.current;
      const ticket = runListGuard.begin("latest");
      const pending = Promise.all([inspectorApi.runs(), inspectorApi.runRequests()])
        .then(([runList, requestList]) => {
          if (!ticket.isCurrent()) return;
          setHistory((previous) => mergeRunHistory(previous, runList, "latest", ticket.revision));
          setRequests(requestList.requests);
          setLatestError(undefined);
        })
        .catch((error: unknown) => {
          if (!ticket.isCurrent()) return;
          setLatestError(error instanceof Error ? error.message : "The latest runs could not be refreshed.");
          throw error;
        })
        .finally(() => {
          if (latestPending.current === pending) latestPending.current = undefined;
        });
      latestPending.current = pending;
      return pending;
    },
    [runListGuard],
  );

  const loadOlderRuns = async () => {
    if (history.nextCursor === undefined || olderPending.current || sourceRefreshing.current) return;
    const ticket = runListGuard.begin("older");
    olderPending.current = true;
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const page = await inspectorApi.runs({ cursor: history.nextCursor });
      if (ticket.isCurrent())
        setHistory((previous) => mergeRunHistory(previous, page, "older", ticket.revision));
    } catch (error) {
      if (ticket.isCurrent())
        setOlderError(error instanceof Error ? error.message : "Older runs could not be loaded.");
    } finally {
      if (ticket.isCurrent()) {
        olderPending.current = false;
        setLoadingOlder(false);
      }
    }
  };

  useEffect(() => {
    let current = true;
    runListGuard.activate();
    Promise.all([inspectorApi.project(), readRuntime(true)])
      .then(([nextProject]) => {
        if (!current) return;
        setProject(nextProject);
      })
      .catch((error: unknown) => {
        if (current)
          setFatal(error instanceof Error ? error.message : "The local inspector could not start.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      runListGuard.dispose();
      latestPending.current = undefined;
      olderPending.current = false;
    };
  }, [readRuntime, runListGuard]);

  useEffect(() => {
    if (window.location.pathname !== location.route)
      window.history.replaceState({}, "", `${location.route}${location.search}`);
  }, [location]);

  useEffect(() => {
    const onPopState = () => setLocation(readInspectorLocation(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void readRuntime().catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [readRuntime]);

  const visit = (href: string, replace = false) => {
    setLocation(navigateInspector(href, window, replace));
  };

  const navigate = (next: Route) => {
    if (next !== route) visit(next);
  };
  const openRun = (runId: string) => visit(runHref(runId));
  const selectScenario = (scenarioId: string | undefined) => {
    if (route === "/world" || route === "/scenarios") visit(scenarioHref(route, scenarioId), true);
  };

  const refresh = async () => {
    if (sourceRefreshing.current) return;
    sourceRefreshing.current = true;
    runListGuard.invalidate();
    latestPending.current = undefined;
    olderPending.current = false;
    setLoadingOlder(false);
    setOlderError(undefined);
    const ticket = runListGuard.begin("source");
    setRefreshing(true);
    try {
      const next = await inspectorApi.refreshProject();
      if (!ticket.isCurrent()) return;
      setProject(next);
      notify("success", "Repository source recompiled successfully.");
      await readRuntime(true).catch(() => undefined);
    } catch (error) {
      if (ticket.isCurrent())
        showError(error instanceof Error ? error.message : "Repository source could not be refreshed.");
    } finally {
      if (ticket.isCurrent()) {
        sourceRefreshing.current = false;
        setRefreshing(false);
      }
    }
  };

  const start = async (input: StartSimulationRun) => {
    setStarting(true);
    try {
      await inspectorApi.startRun(input);
      notify("info", "Drill run requested. Its live world will appear when ready.");
      navigate("/runs");
      try {
        await readRuntime(true);
      } catch {
        showError(
          "The run was accepted, but its results could not be refreshed yet. Do not submit it again; wait for results or refresh this page.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The drill could not be started.";
      showError(message);
      return message;
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (requestId: string) => {
    setCancelling(true);
    try {
      await inspectorApi.cancelRun(requestId);
      await readRuntime(true);
      notify("warning", "Cancellation requested. Partial evidence will remain available.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "The drill run could not be cancelled.");
    } finally {
      setCancelling(false);
    }
  };

  const openReport = async (runId: string) => {
    const target = window.open("about:blank", "_blank");
    if (target === null) {
      try {
        const blob = await inspectorApi.report(runId);
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${runId}.html`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        notify(
          "info",
          "The browser blocked a new tab. The report was downloaded instead; open the HTML file to read it.",
        );
      } catch (error) {
        showError(error instanceof Error ? error.message : "The local report could not be downloaded.");
      }
      return;
    }
    target.opener = null;
    target.document.title = "Loading Firedrill report";
    try {
      const blob = await inspectorApi.report(runId);
      const url = URL.createObjectURL(blob);
      target.location.replace(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      target.close();
      showError(error instanceof Error ? error.message : "The local report could not be opened.");
    }
  };

  if (loading) return <PageLoader />;
  if (fatal !== undefined || project === undefined) {
    return (
      <div className="fd-fatal">
        <img src="/brand/firedrill-logo.svg" alt="Firedrill" />
        <h1>Inspector could not open</h1>
        <p>{fatal ?? "The compiled project is unavailable."}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  }

  const historyControls: RunHistoryControls = {
    hasMore: history.nextCursor !== undefined,
    loadingOlder,
    refreshing,
    olderError,
    latestError,
    onLoadOlder: () => void loadOlderRuns(),
    onRetryLatest: () => void readRuntime().catch(() => undefined),
  };
  const scenarioId = readScenarioId(location.search);

  return (
    <>
      <AppShell
        route={route}
        project={project}
        refreshing={refreshing}
        onNavigate={navigate}
        onRefresh={() => void refresh()}
      >
        {route === "/world" ? (
          <WorldView
            project={project}
            runs={history.runs}
            runHistory={historyControls}
            unavailableRunCount={history.unavailable.length}
            onOpenRun={openRun}
            {...(scenarioId === undefined ? {} : { scenarioId })}
            onSelectScenario={selectScenario}
          />
        ) : null}
        {route === "/tools" ? (
          <ToolsView
            project={project}
            selection={readToolSelection(location.search)}
            onVisit={visit}
            runtimeSummary={<EnvironmentBanner environment={environment} onVisit={visit} />}
            {...(environment.error === undefined && environment.status?.available
              ? {
                  liveApps: {
                    worldInstanceId: environment.status.metadata.worldInstanceId,
                    apps: environment.status.apps,
                  },
                }
              : {})}
            testTool={(tool) => (
              <TestTool
                key={`${tool.id}:${environment.status?.available ? `${environment.status.metadata.worldInstanceId}:${environment.status.description.generation}` : "source"}`}
                tool={tool}
                project={project}
                environment={environment}
                onVisit={visit}
              />
            )}
          />
        ) : null}
        {route === "/environment" ? (
          <EnvironmentView
            project={project}
            environment={environment}
            tab={new URLSearchParams(location.search).get("tab") === "activity" ? "activity" : "state"}
            onVisit={visit}
            onSourceChanged={refresh}
          />
        ) : null}
        {route === "/connect" ? (
          <ConnectAgentView project={project} environment={environment} onVisit={visit} />
        ) : null}
        {route === "/scenarios" ? (
          <WorldView
            key={route}
            project={project}
            page="scenarios"
            runs={history.runs}
            runHistory={historyControls}
            unavailableRunCount={history.unavailable.length}
            onOpenRun={openRun}
            {...(scenarioId === undefined ? {} : { scenarioId })}
            onSelectScenario={selectScenario}
          />
        ) : null}
        {route === "/schema" || route === "/data" || route === "/personas" ? (
          <CatalogView
            key={route}
            project={project}
            page={route === "/schema" ? "schema" : route === "/data" ? "data" : "personas"}
          />
        ) : null}
        {route === "/drills" ? <DrillsView project={project} starting={starting} onStart={start} /> : null}
        {route === "/browser-tests" ? <BrowserTestsView /> : null}
        {route === "/runs" ? (
          <RunsView
            project={project}
            runs={history.runs}
            requests={requests}
            unavailableReports={history.unavailable}
            history={historyControls}
            selection={readRunSelection(location.search)}
            onSelectRun={openRun}
            onClearSelection={() => visit("/runs")}
            starting={starting}
            cancelling={cancelling}
            onCancel={(requestId) => void cancel(requestId)}
            onRerun={(input) => void start(input)}
            onOpenReport={(runId) => void openReport(runId)}
            onNavigateDrills={() => navigate("/drills")}
            onError={showError}
          />
        ) : null}
      </AppShell>
      <Notices
        notices={notices}
        onDismiss={(id) => setNotices((value) => value.filter((notice) => notice.id !== id))}
      />
    </>
  );
}
