import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectorApi } from "./api";
import { createRunListGuard, emptyRunHistory, mergeRunHistory } from "./app";
import { type RunHistoryControls, RunsView } from "./features/runs";
import type { SimulationProject, SimulationRunList, SimulationRunSummary } from "./types";

function run(runId: string, overrides: Partial<SimulationRunSummary> = {}): SimulationRunSummary {
  return {
    schemaVersion: 1,
    runId,
    worldInstanceId: "world_history",
    drillId: "inspect-record",
    targetId: "agent",
    seed: "41",
    trial: 1,
    trialCount: 1,
    attempt: 1,
    attemptLimit: 1,
    status: "sealed",
    verdict: "passed",
    virtualTimeUs: 0,
    evidenceSequence: 1,
    reportAvailable: true,
    ...overrides,
  };
}

function page(ids: string[], nextCursor?: string, unavailable: string[] = []): SimulationRunList {
  return {
    schemaVersion: 1,
    runs: ids.map((id) => run(id)),
    unavailable: unavailable.map((runId) => ({
      runId,
      code: "reporter.REPORT_INVALID",
      message: "The saved report could not be verified.",
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function controls(overrides: Partial<RunHistoryControls> = {}): RunHistoryControls {
  return {
    hasMore: true,
    loadingOlder: false,
    refreshing: false,
    olderError: undefined,
    latestError: undefined,
    onLoadOlder: () => undefined,
    onRetryLatest: () => undefined,
    ...overrides,
  };
}

const project: SimulationProject = {
  schemaVersion: 1,
  world: {
    id: "history",
    seed: "41",
    buildHash: `sha256:${"a".repeat(64)}`,
    packageLockHash: `sha256:${"b".repeat(64)}`,
    baseline: { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] },
  },
  tools: [],
  scenarios: [],
  targets: [],
  drills: [],
  suites: [],
  diagnostics: [],
};

function view(
  runs: SimulationRunSummary[],
  history: RunHistoryControls,
  unavailableReports: SimulationRunList["unavailable"] = [],
) {
  return renderToStaticMarkup(
    <RunsView
      project={project}
      runs={runs}
      requests={[]}
      unavailableReports={unavailableReports}
      history={history}
      starting={false}
      cancelling={false}
      onCancel={() => undefined}
      onRerun={() => undefined}
      onOpenReport={() => undefined}
      onNavigateDrills={() => undefined}
      onError={() => undefined}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loaded run history", () => {
  it("retains older pages and the oldest continuation while polling only the newest page", () => {
    const first = mergeRunHistory(
      emptyRunHistory(),
      page(["run_new", "run_middle"], "cursor_first"),
      "latest",
      1,
    );
    const older = mergeRunHistory(first, page(["run_middle", "run_old"], "cursor_older"), "older", 2);
    const polled = mergeRunHistory(older, page(["run_newest", "run_new"], "cursor_latest"), "latest", 3);
    expect(polled.runs.map((item) => item.runId)).toEqual(["run_newest", "run_new", "run_middle", "run_old"]);
    expect(polled.nextCursor).toBe("cursor_older");
    expect(polled.loadedOlder).toBe(true);
  });

  it("updates first-page continuation before older pages are loaded and keeps an exhausted continuation exhausted", () => {
    const first = mergeRunHistory(emptyRunHistory(), page(["run_one"], "old_cursor"), "latest", 1);
    const latest = mergeRunHistory(first, page(["run_two"], "new_cursor"), "latest", 2);
    expect(latest.nextCursor).toBe("new_cursor");
    const end = mergeRunHistory(latest, page(["run_three"]), "older", 3);
    expect(
      mergeRunHistory(end, page(["run_four", "run_two"], "newer_cursor"), "latest", 4).nextCursor,
    ).toBeUndefined();
  });

  it("removes missing tracked attempts without inventing results and tombstones delayed older summaries", () => {
    const active = {
      ...page([], "cursor_first"),
      runs: [
        run("run_active", { requestId: "request_batch", status: "running", reportAvailable: false }),
        run("run_finished_tracked", { requestId: "request_batch", status: "sealed", reportAvailable: false }),
      ],
    };
    const first = mergeRunHistory(emptyRunHistory(), active, "latest", 1);
    const newest = page(
      Array.from({ length: 100 }, (_, index) => `run_new_${index}`),
      "cursor_new",
    );
    const completed = mergeRunHistory(first, newest, "latest", 3);
    expect(completed.runs).toHaveLength(100);
    expect(
      completed.runs.some((item) => item.runId === "run_active" || item.runId === "run_finished_tracked"),
    ).toBe(false);
    expect(completed.revisions.get("run_active")).toBe(3);
    const delayed = mergeRunHistory(
      completed,
      { ...active, runs: [...active.runs, run("run_old")] },
      "older",
      2,
    );
    expect(
      delayed.runs.some((item) => item.runId === "run_active" || item.runId === "run_finished_tracked"),
    ).toBe(false);
    expect(delayed.runs.some((item) => item.runId === "run_old")).toBe(true);
    const saved = mergeRunHistory(delayed, page(["run_active"]), "older", 4);
    expect(saved.runs.find((item) => item.runId === "run_active")).toMatchObject({
      status: "sealed",
      reportAvailable: true,
    });
  });

  it("does not remove a newer tracked summary when an earlier latest response omits it", () => {
    const first = mergeRunHistory(
      emptyRunHistory(),
      { ...page([]), runs: [run("run_active", { status: "running", reportAvailable: false })] },
      "older",
      3,
    );
    expect(
      mergeRunHistory(first, page(["run_saved"]), "latest", 2).runs.some(
        (item) => item.runId === "run_active",
      ),
    ).toBe(true);
  });

  it("can replace a missing active summary with concurrently fetched verified evidence, not stale activity", () => {
    const active = { ...page([]), runs: [run("run_active", { status: "running", reportAvailable: false })] };
    const first = mergeRunHistory(emptyRunHistory(), active, "latest", 1);
    const absent = mergeRunHistory(first, page(["run_newest"], "cursor_new"), "latest", 3);
    const recorded = mergeRunHistory(absent, page(["run_active"], "cursor_old"), "older", 2);
    expect(recorded.runs.find((item) => item.runId === "run_active")).toMatchObject({
      status: "sealed",
      reportAvailable: true,
    });
    expect(recorded.revisions.get("run_active")).toBe(3);
    const stale = mergeRunHistory(recorded, active, "older", 2);
    expect(stale.runs.find((item) => item.runId === "run_active")?.status).toBe("sealed");
  });

  it("reopens a gap even when earlier history was only partially loaded", () => {
    const first = mergeRunHistory(emptyRunHistory(), page(["run_known"], "cursor_first"), "latest", 1);
    const older = mergeRunHistory(first, page(["run_older"], "cursor_older"), "older", 2);
    const burst = mergeRunHistory(older, page(["run_newest"], "cursor_gap"), "latest", 3);
    expect(burst.nextCursor).toBe("cursor_gap");
    expect(burst.runs.map((item) => item.runId)).toEqual(["run_newest", "run_known", "run_older"]);
  });

  it("reopens exhausted history after a saved-report burst, ignoring overlap from tracked attempts", () => {
    const active = run("run_active", {
      requestId: "request_batch",
      status: "running",
      reportAvailable: false,
    });
    const first = mergeRunHistory(
      emptyRunHistory(),
      { ...page(["run_old"], "cursor_first"), runs: [active, run("run_old")] },
      "latest",
      1,
    );
    const exhausted = mergeRunHistory(
      first,
      { ...page(["run_oldest"]), runs: [active, run("run_oldest")] },
      "older",
      2,
    );
    const burst = page(
      Array.from({ length: 100 }, (_, index) => `run_burst_${index}`),
      "cursor_burst",
    );
    burst.runs.unshift(active);
    const reopened = mergeRunHistory(exhausted, burst, "latest", 3);
    expect(reopened.nextCursor).toBe("cursor_burst");
    expect(reopened.runs.some((item) => item.runId === "run_oldest")).toBe(true);
    expect(reopened.runs).toHaveLength(103);
    const continued = mergeRunHistory(reopened, page(["run_middle", "run_old", "run_oldest"]), "older", 4);
    expect(continued.runs.filter((item) => item.runId === "run_old")).toHaveLength(1);
    expect(continued.runs.some((item) => item.runId === "run_middle")).toBe(true);
  });

  it("recognizes unavailable-report overlap and also reopens for an unreadable-only burst", () => {
    const exhausted = mergeRunHistory(emptyRunHistory(), page([], undefined, ["run_known_bad"]), "older", 1);
    const overlap = mergeRunHistory(
      exhausted,
      page([], "cursor_overlap", ["run_new_bad", "run_known_bad"]),
      "latest",
      2,
    );
    expect(overlap.nextCursor).toBeUndefined();
    const burst = mergeRunHistory(overlap, page([], "cursor_burst", ["run_other_bad"]), "latest", 3);
    expect(burst.nextCursor).toBe("cursor_burst");
    expect(burst.unavailable).toHaveLength(3);
  });

  it("deduplicates active attempts repeated on saved pages without rolling back newer status", () => {
    const active = {
      ...page(["run_active"], "cursor_first"),
      runs: [run("run_active", { status: "running", reportAvailable: false })],
    };
    const first = mergeRunHistory(emptyRunHistory(), active, "latest", 1);
    const current = mergeRunHistory(first, page(["run_active"], "cursor_first"), "latest", 3);
    const delayed = { ...page(["run_old"], "cursor_older"), runs: [...active.runs, run("run_old")] };
    const merged = mergeRunHistory(current, delayed, "older", 2);
    expect(merged.runs.map((item) => item.runId)).toEqual(["run_active", "run_old"]);
    expect(merged.runs[0]).toMatchObject({ status: "sealed", reportAvailable: true });
    expect(merged.nextCursor).toBe("cursor_older");
  });

  it("continues through unreadable-only pages and deduplicates unavailable reports", () => {
    const first = mergeRunHistory(emptyRunHistory(), page([], "cursor_first", ["run_bad"]), "latest", 1);
    const older = mergeRunHistory(first, page([], "cursor_older", ["run_bad", "run_bad_older"]), "older", 2);
    const polled = mergeRunHistory(older, page([], "cursor_first", ["run_bad"]), "latest", 3);
    expect(polled.runs).toEqual([]);
    expect(polled.unavailable.map((item) => item.runId)).toEqual(["run_bad", "run_bad_older"]);
    expect(polled.nextCursor).toBe("cursor_older");
  });

  it("reconciles readable and unavailable reports using the newest request revision", () => {
    const first = mergeRunHistory(emptyRunHistory(), page(["run_one"]), "latest", 1);
    const invalid = mergeRunHistory(first, page([], undefined, ["run_one"]), "latest", 3);
    const stale = mergeRunHistory(invalid, page(["run_one"]), "older", 2);
    expect(stale.runs).toEqual([]);
    expect(stale.unavailable.map((item) => item.runId)).toEqual(["run_one"]);
    const repaired = mergeRunHistory(stale, page(["run_one"]), "older", 4);
    expect(repaired.unavailable).toEqual([]);
    expect(repaired.runs.map((item) => item.runId)).toEqual(["run_one"]);
  });
});

describe("run list request lifecycle", () => {
  it("accepts parallel continuation and latest requests, but ignores superseded latest responses", () => {
    const guard = createRunListGuard();
    const first = guard.begin("latest");
    const older = guard.begin("older");
    const latest = guard.begin("latest");
    expect(first.isCurrent()).toBe(false);
    expect(older.isCurrent()).toBe(true);
    expect(latest.isCurrent()).toBe(true);
    expect(latest.revision).toBeGreaterThan(older.revision);
  });

  it("rejects in-flight responses after a source refresh or unmount, including a later remount", () => {
    const guard = createRunListGuard();
    const latest = guard.begin("latest");
    const older = guard.begin("older");
    guard.invalidate();
    expect(latest.isCurrent()).toBe(false);
    expect(older.isCurrent()).toBe(false);
    const refreshed = guard.begin("latest");
    guard.dispose();
    expect(refreshed.isCurrent()).toBe(false);
    guard.activate();
    expect(refreshed.isCurrent()).toBe(false);
    expect(guard.begin("latest").isCurrent()).toBe(true);
  });

  it("does not apply a delayed page after source invalidation, and allows an explicit retry", async () => {
    const guard = createRunListGuard();
    let history = mergeRunHistory(emptyRunHistory(), page(["run_first"], "cursor_first"), "latest", 0);
    let resolvePage: ((value: SimulationRunList) => void) | undefined;
    const ticket = guard.begin("older");
    const delayed = new Promise<SimulationRunList>((resolve) => {
      resolvePage = resolve;
    }).then((result) => {
      if (ticket.isCurrent()) history = mergeRunHistory(history, result, "older", ticket.revision);
    });
    guard.invalidate();
    resolvePage?.(page(["run_stale"], "cursor_stale"));
    await delayed;
    expect(history.runs.map((item) => item.runId)).toEqual(["run_first"]);
    expect(history.nextCursor).toBe("cursor_first");
    const retry = guard.begin("older");
    if (retry.isCurrent()) history = mergeRunHistory(history, page(["run_older"]), "older", retry.revision);
    expect(history.runs.map((item) => item.runId)).toEqual(["run_first", "run_older"]);
  });
});

describe("saved run continuation UI", () => {
  beforeEach(() => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) }));

  it("keeps the shared 25-run page and labels search and results as loaded scope", () => {
    const markup = view(
      Array.from({ length: 30 }, (_, index) => run(`run_${index}`)),
      controls(),
    );
    expect(markup.match(/<button[^>]*class="[^"]*fd-run-list-item[^"]*"/g)).toHaveLength(25);
    expect(markup).toContain("1–25 of 30");
    expect(markup).toContain('aria-label="Search loaded runs"');
    expect(markup).toContain('aria-label="Loaded run result"');
    expect(markup).toContain("30 loaded");
    expect(markup).toContain("Load older runs");
    expect(markup).toContain('aria-label="Next loaded runs"');
  });

  it("keeps continuation available when an entire loaded page is unreadable", () => {
    const markup = view([], controls(), page([], "cursor", ["run_invalid"]).unavailable);
    expect(markup).toContain("No readable loaded runs");
    expect(markup).toContain("Load older runs");
    expect(markup).toContain("look for another saved result");
  });

  it("shows recoverable errors without replacing loaded runs, and disables loading while busy", () => {
    const markup = view(
      [run("run_kept")],
      controls({
        olderError: "The connection was interrupted.",
        latestError: "The newest page is unavailable.",
      }),
    );
    expect(markup).toContain("run_kept");
    expect(markup).toContain("Retry older runs");
    expect(markup).toContain("Retry latest runs");
    expect(markup).toContain("Previously loaded runs remain available.");
    expect(markup).toContain('role="alert"');
    const busy = view([run("run_kept")], controls({ loadingOlder: true }));
    expect(busy).toContain("Loading older runs…");
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Loading older runs/);
  });

  it("removes continuation and partial-scope labels at the end of saved history", () => {
    const markup = view([run("run_one")], controls({ hasMore: false }));
    expect(markup).not.toContain("Load older runs");
    expect(markup).not.toContain("Search loaded runs");
    expect(markup).toContain('aria-label="Search runs"');
  });
});

describe("run list request parameters", () => {
  it("requests only the newest default page unless a continuation is explicitly supplied", async () => {
    vi.stubGlobal("document", { querySelector: () => ({ content: "local-test-token" }) });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => page([]) });
    vi.stubGlobal("fetch", fetcher);
    await inspectorApi.runs();
    await inspectorApi.runs({ cursor: "opaque+/=cursor", limit: 100 });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/runs");
    const continuation = new URL(String(fetcher.mock.calls[1]?.[0]), "http://localhost");
    expect(continuation.searchParams.get("cursor")).toBe("opaque+/=cursor");
    expect(continuation.searchParams.get("limit")).toBe("100");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
