import type { Route, SimulationRunDetail } from "./types";

export type RunSelection =
  | { readonly kind: "automatic" }
  | { readonly kind: "explicit"; readonly runId: string }
  | { readonly kind: "invalid"; readonly message: string };

export interface InspectorLocation {
  readonly route: Route;
  readonly search: string;
}

export function runHref(runId: string): string {
  return `/runs?run=${encodeURIComponent(runId)}`;
}

export function readInspectorLocation(location: {
  readonly pathname: string;
  readonly search: string;
}): InspectorLocation {
  const route = location.pathname;
  if (
    route === "/world" ||
    route === "/drills" ||
    route === "/runs" ||
    route === "/schema" ||
    route === "/data" ||
    route === "/personas" ||
    route === "/scenarios" ||
    route === "/tools"
  ) {
    return { route, search: location.search };
  }
  return { route: "/world", search: "" };
}

export function navigateInspector(
  href: string,
  browser: {
    readonly location: Pick<Location, "pathname" | "search" | "href">;
    readonly history: Pick<History, "pushState" | "replaceState">;
  },
  replace = false,
): InspectorLocation {
  const next = readInspectorLocation(new URL(href, browser.location.href));
  const nextHref = `${next.route}${next.search}`;
  if (`${browser.location.pathname}${browser.location.search}` !== nextHref) {
    if (replace) browser.history.replaceState({}, "", nextHref);
    else browser.history.pushState({}, "", nextHref);
  }
  return next;
}

export function readRunSelection(search: string): RunSelection {
  const values = new URLSearchParams(search).getAll("run");
  if (values.length === 0) return { kind: "automatic" };
  // Same bounded identifier accepted by the server's RunId contract; the server validates again.
  if (values.length !== 1 || !/^run_[A-Za-z0-9][A-Za-z0-9_-]{5,95}$/.test(values[0] ?? "")) {
    return {
      kind: "invalid",
      message:
        "This link does not contain one valid run ID. Choose a run from the list or open a saved run link.",
    };
  }
  return { kind: "explicit", runId: values[0] ?? "" };
}

export function readScenarioId(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("scenario");
  if (values.length === 0) return undefined;
  // The compiled project validates existence. Preserve explicit invalid/missing IDs
  // rather than silently choosing a default. Empty cannot be a compiled scenario ID.
  return values.length === 1 ? values[0] : "";
}

export function scenarioHref(route: "/world" | "/scenarios", scenarioId: string | undefined): string {
  return scenarioId === undefined ? route : `${route}?scenario=${encodeURIComponent(scenarioId)}`;
}

/** Resolve the requested identity, never substituting the first loaded run. */
export async function resolveLinkedRun(
  runId: string,
  read: (runId: string) => Promise<SimulationRunDetail>,
): Promise<SimulationRunDetail> {
  const selection = readRunSelection(new URLSearchParams({ run: runId }).toString());
  if (selection.kind !== "explicit") throw new Error("This link does not contain a valid run ID.");
  const detail = await read(runId);
  if (
    detail.summary.runId !== runId ||
    (detail.result !== undefined && detail.result.identity.runId !== runId)
  ) {
    throw new Error(
      "The returned result does not match the requested run. Retry this run or choose another saved result.",
    );
  }
  return detail;
}
