import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { inspectorApi } from "./api";
import { Button, IconButton, PageLoader } from "./components/primitives";
import { AppShell } from "./components/shell";
import { CatalogView } from "./features/catalog";
import { DrillsView } from "./features/drills";
import { RunsView } from "./features/runs";
import { WorldView } from "./features/world";
import type {
  Notice,
  Route,
  SimulationProject,
  SimulationRunRequest,
  SimulationRunSummary,
  StartSimulationRun,
} from "./types";

function routeFromPath(path: string): Route {
  return path === "/drills" ||
    path === "/runs" ||
    path === "/schema" ||
    path === "/data" ||
    path === "/personas" ||
    path === "/scenarios" ||
    path === "/tools"
    ? path
    : "/world";
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
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [project, setProject] = useState<SimulationProject>();
  const [runs, setRuns] = useState<readonly SimulationRunSummary[]>([]);
  const [requests, setRequests] = useState<readonly SimulationRunRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const noticeId = useRef(0);
  const unavailableReports = useRef("");

  const notify = useCallback((tone: Notice["tone"], message: string) => {
    noticeId.current += 1;
    const id = noticeId.current;
    setNotices((value) => [...value, { id, tone, message }].slice(-3));
    window.setTimeout(() => setNotices((value) => value.filter((notice) => notice.id !== id)), 6_000);
  }, []);

  const showError = useCallback((message: string) => notify("danger", message), [notify]);

  const applyRunList = useCallback(
    (runList: Awaited<ReturnType<typeof inspectorApi.runs>>) => {
      setRuns(runList.runs);
      const nextUnavailable = runList.unavailable.map((report) => report.runId).join("\n");
      if (nextUnavailable !== "" && nextUnavailable !== unavailableReports.current) {
        const unsupported = runList.unavailable.every(
          (report) => report.code === "reporter.VERSION_UNSUPPORTED",
        );
        notify(
          "warning",
          unsupported
            ? `${runList.unavailable.length} saved report${runList.unavailable.length === 1 ? " uses an" : "s use an"} unsupported format. Original files are unchanged.`
            : `${runList.unavailable.length} local report${runList.unavailable.length === 1 ? "" : "s"} could not be verified. Saved files have not been changed.`,
        );
      }
      unavailableReports.current = nextUnavailable;
    },
    [notify],
  );

  const readRuntime = useCallback(async () => {
    const [runList, requestList] = await Promise.all([inspectorApi.runs(), inspectorApi.runRequests()]);
    applyRunList(runList);
    setRequests(requestList.requests);
  }, [applyRunList]);

  useEffect(() => {
    let current = true;
    Promise.all([inspectorApi.project(), inspectorApi.runs(), inspectorApi.runRequests()])
      .then(([nextProject, runList, requestList]) => {
        if (!current) return;
        setProject(nextProject);
        applyRunList(runList);
        setRequests(requestList.requests);
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
    };
  }, [applyRunList]);

  useEffect(() => {
    if (window.location.pathname !== route) window.history.replaceState({}, "", route);
  }, [route]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void readRuntime().catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [readRuntime]);

  const navigate = (next: Route) => {
    if (next === route) return;
    window.history.pushState({}, "", next);
    setRoute(next);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await inspectorApi.refreshProject();
      setProject(next);
      notify("success", "Repository source recompiled successfully.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Repository source could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  };

  const start = async (input: StartSimulationRun) => {
    setStarting(true);
    try {
      await inspectorApi.startRun(input);
      notify("info", "Drill run requested. Its live world will appear when ready.");
      navigate("/runs");
      try {
        await readRuntime();
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
      await readRuntime();
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

  return (
    <>
      <AppShell
        route={route}
        project={project}
        refreshing={refreshing}
        onNavigate={navigate}
        onRefresh={() => void refresh()}
      >
        {route === "/world" ? <WorldView project={project} /> : null}
        {route === "/scenarios" || route === "/tools" ? (
          <WorldView key={route} project={project} page={route === "/tools" ? "tools" : "scenarios"} />
        ) : null}
        {route === "/schema" || route === "/data" || route === "/personas" ? (
          <CatalogView
            key={route}
            project={project}
            page={route === "/schema" ? "schema" : route === "/data" ? "data" : "personas"}
          />
        ) : null}
        {route === "/drills" ? <DrillsView project={project} starting={starting} onStart={start} /> : null}
        {route === "/runs" ? (
          <RunsView
            project={project}
            runs={runs}
            requests={requests}
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
