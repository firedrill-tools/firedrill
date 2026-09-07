import { useEffect, useMemo, useState } from "react";
import { inspectorApi } from "../api";
import { checkExpectation } from "../components/check-comparison";
import { PaginatedContent } from "../components/pagination";
import { Button, InlineMessage, Select, Status } from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { formatDiffValue, ValueDiff } from "../components/value-diff";
import { titleFromId } from "../format";
import type { SimulationRunComparison, SimulationRunDetail, SimulationRunSummary } from "../types";
import "./run-comparison.css";

type RunResult = NonNullable<SimulationRunDetail["result"]>;
type CheckResult = RunResult["assertionResults"][number];
type RunPair = { readonly baselineRunId: string; readonly candidateRunId: string };
type ComparisonData = {
  readonly comparison: SimulationRunComparison;
  readonly baseline: SimulationRunDetail & { readonly result: RunResult };
  readonly candidate: SimulationRunDetail & { readonly result: RunResult };
};

/** Prefer another report with the same test inputs; list order alone is not compatibility. */
export function defaultComparisonRuns(
  runs: readonly SimulationRunSummary[],
  selectedRunId: string | undefined,
): RunPair {
  const eligible = runs.filter((run) => run.reportAvailable);
  const candidate = eligible.find((run) => run.runId === selectedRunId) ?? eligible[0];
  const others = eligible.filter((run) => run.runId !== candidate?.runId);
  const sameTest = (run: SimulationRunSummary) =>
    run.drillId === candidate?.drillId && run.scenarioId === candidate?.scenarioId;
  const baseline =
    others.find(
      (run) => sameTest(run) && run.seed === candidate?.seed && run.targetId === candidate?.targetId,
    ) ??
    others.find((run) => sameTest(run) && run.seed === candidate?.seed) ??
    others.find(sameTest) ??
    others.find((run) => run.drillId === candidate?.drillId) ??
    others[0];
  return { baselineRunId: baseline?.runId ?? "", candidateRunId: candidate?.runId ?? "" };
}

/** Saved run details contain verified report values; no live or raw database snapshot is needed. */
export async function loadRunComparison({ baselineRunId, candidateRunId }: RunPair): Promise<ComparisonData> {
  const [comparison, baseline, candidate] = await Promise.all([
    inspectorApi.compareRuns(baselineRunId, candidateRunId),
    inspectorApi.run(baselineRunId),
    inspectorApi.run(candidateRunId),
  ]);
  if (
    comparison.baseline.runId !== baselineRunId ||
    comparison.candidate.runId !== candidateRunId ||
    baseline.summary.runId !== baselineRunId ||
    candidate.summary.runId !== candidateRunId
  ) {
    throw new Error("The returned reports do not match the selected runs. Retry the comparison.");
  }
  if (baseline.result === undefined || candidate.result === undefined) {
    throw new Error("A saved report is no longer available. Retry, or select another run.");
  }
  return {
    comparison,
    baseline: { ...baseline, result: baseline.result },
    candidate: { ...candidate, result: candidate.result },
  };
}

/** Pair checks by checkpoint and assertion, retaining expectation-only changes and missing sides. */
export function comparisonChecks(
  baseline: Pick<RunResult, "checkpoints">,
  candidate: Pick<RunResult, "checkpoints">,
) {
  const rows = new Map<
    string,
    {
      key: string;
      checkpointId: string;
      assertionId: string;
      baseline?: CheckResult;
      candidate?: CheckResult;
    }
  >();
  for (const [side, result] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    for (const checkpoint of result.checkpoints) {
      for (const check of checkpoint.assertionResults) {
        const key = JSON.stringify([checkpoint.checkpointId, check.assertionId]);
        const row = rows.get(key) ?? {
          key,
          checkpointId: checkpoint.checkpointId,
          assertionId: check.assertionId,
        };
        rows.set(key, { ...row, [side]: check });
      }
    }
  }
  return [...rows.values()].map((row) => {
    const statusChanged = row.baseline?.status !== row.candidate?.status;
    const actualChanged = formatDiffValue(row.baseline?.actual) !== formatDiffValue(row.candidate?.actual);
    const expectedChanged =
      formatDiffValue(row.baseline?.expected) !== formatDiffValue(row.candidate?.expected);
    const kindChanged = row.baseline?.kind !== row.candidate?.kind;
    return {
      ...row,
      statusChanged,
      actualChanged,
      expectedChanged,
      kindChanged,
      changed: statusChanged || actualChanged || expectedChanged || kindChanged,
    };
  });
}

function resultTone(status: string | undefined) {
  if (status === "passed") return "success";
  if (status === "failed" || status === "runner_failed" || status === "invalid") return "danger";
  if (status === "inconclusive") return "warning";
  return "neutral";
}

function ResultStatus({ value }: { readonly value: string | undefined }) {
  return value === undefined ? (
    <span>Not recorded</span>
  ) : (
    <Status tone={resultTone(value)}>{titleFromId(value)}</Status>
  );
}

function expectation(check: CheckResult | undefined) {
  if (check === undefined) return { value: undefined, condition: "Check not recorded." };
  const expected = checkExpectation(check);
  // A recognized equals envelope is unwrapped too, but the single-check view omits its obvious condition.
  return {
    ...expected,
    condition:
      expected.condition ??
      (expected.value !== check.expected ? "Actual must equal the expected value." : undefined),
  };
}

function ComparedCheck({ row }: { readonly row: ReturnType<typeof comparisonChecks>[number] }) {
  const before = expectation(row.baseline);
  const after = expectation(row.candidate);
  const changes = [
    row.statusChanged && "Status changed",
    row.actualChanged && "Actual changed",
    row.expectedChanged && "Expectation changed",
    row.kindChanged && "Check kind changed",
  ].filter(Boolean);
  return (
    <article className="fd-run-comparison__check">
      <header>
        <h4 title={row.assertionId}>{titleFromId(row.assertionId)}</h4>
        <p>
          Checkpoint: <code>{row.checkpointId}</code>
          {changes.length === 0 ? " · Unchanged" : ` · ${changes.join(" · ")}`}
        </p>
      </header>
      <dl className="fd-run-comparison__sides">
        {(["baseline", "candidate"] as const).map((side) => (
          <div key={side}>
            <dt>{titleFromId(side)}</dt>
            <dd>
              <ResultStatus value={row[side]?.status} />
              {row.kindChanged && row[side] !== undefined ? <code>{row[side].kind}</code> : null}
            </dd>
          </div>
        ))}
      </dl>
      <h5>Actual values{row.actualChanged ? "" : " (unchanged)"}</h5>
      <ValueDiff
        before={row.baseline?.actual}
        after={row.candidate?.actual}
        beforeLabel="Baseline actual"
        afterLabel="Candidate actual"
        label={`${row.checkpointId} / ${row.assertionId} actual values`}
      />
      {row.expectedChanged || row.kindChanged ? (
        <>
          <h5>Expected values and conditions{row.expectedChanged ? " changed" : ""}</h5>
          {before.condition === undefined && after.condition === undefined ? null : (
            <dl className="fd-run-comparison__sides fd-run-comparison__conditions">
              <div>
                <dt>Baseline condition</dt>
                <dd>{before.condition ?? "Defined by the check kind."}</dd>
              </div>
              <div>
                <dt>Candidate condition</dt>
                <dd>{after.condition ?? "Defined by the check kind."}</dd>
              </div>
            </dl>
          )}
          {row.expectedChanged ? (
            <ValueDiff
              before={before.value}
              after={after.value}
              beforeLabel="Baseline expected"
              afterLabel="Candidate expected"
              label={`${row.checkpointId} / ${row.assertionId} expected values`}
            />
          ) : (
            <p>Expected value unchanged.</p>
          )}
        </>
      ) : (
        <div className="fd-run-comparison__expected">
          <h5>Expected in both runs</h5>
          {before.condition === undefined || row.baseline?.diff.operator === "equals" ? null : (
            <p className="fd-run-comparison__note">{before.condition}</p>
          )}
          <ScrollArea label="Expected value shared by both runs" natural>
            <pre>{formatDiffValue(before.value)}</pre>
          </ScrollArea>
        </div>
      )}
    </article>
  );
}

function RunIdentity({
  label,
  run,
}: {
  readonly label: string;
  readonly run: SimulationRunComparison["baseline"];
}) {
  return (
    <section className="fd-run-comparison__identity" aria-label={`${label} run`}>
      <div className="fd-run-comparison__identity-heading">
        <h3>{label}</h3>
        <ResultStatus value={run.verdict ?? run.status} />
      </div>
      <code className="fd-run-comparison__run-id">{run.runId}</code>
      <dl>
        <div>
          <dt>Drill</dt>
          <dd>{run.drillId}</dd>
        </div>
        <div>
          <dt>Scenario</dt>
          <dd>{run.scenarioId ?? "World baseline"}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{run.targetId}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd>{run.seed}</dd>
        </div>
      </dl>
    </section>
  );
}

type CountChange = SimulationRunComparison["changes"]["eventCounts"][number];

function CountTable({
  rows,
  label,
  subjectLabel,
}: {
  readonly rows: readonly CountChange[];
  readonly label: string;
  readonly subjectLabel: string;
}) {
  return (
    <PaginatedContent items={rows} label={label}>
      {(pageRows) => (
        <ScrollArea label={label} natural>
          <table className="fd-run-comparison__table">
            <thead>
              <tr>
                <th scope="col">{subjectLabel}</th>
                <th scope="col">Baseline</th>
                <th scope="col">Candidate</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.subject}>
                  <th scope="row">
                    <code>{row.subject}</code>
                  </th>
                  <td>{row.baseline}</td>
                  <td>{row.candidate}</td>
                  <td>
                    {row.delta > 0 ? "+" : ""}
                    {row.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </PaginatedContent>
  );
}

/** The report view is separate from loading so every displayed value comes from the same selected pair. */
export function RunComparisonReport({ comparison, baseline, candidate }: ComparisonData) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const checks = useMemo(
    () => comparisonChecks(baseline.result, candidate.result),
    [baseline.result, candidate.result],
  );
  const changedChecks = checks.filter((check) => check.changed);
  const visibleChecks = showUnchanged ? checks : changedChecks;
  const pairKey = JSON.stringify([comparison.baseline.runId, comparison.candidate.runId]);
  const compatibilityLabel = {
    exact_inputs: "Matching test inputs",
    descriptive_only: "Different test inputs",
    incompatible: "Inputs are not comparable",
  }[comparison.compatibility.status];
  const finalData =
    comparison.changes.stateChanged === undefined
      ? "Final data comparison not recorded."
      : comparison.changes.stateChanged
        ? "Final data changed."
        : "Final data unchanged.";
  return (
    <div className="fd-run-comparison__report">
      <div className="fd-run-comparison__identities">
        <RunIdentity label="Baseline" run={comparison.baseline} />
        <RunIdentity label="Candidate" run={comparison.candidate} />
      </div>
      <section className="fd-run-comparison__section" data-scroll-section="inputs">
        <h3>Input compatibility</h3>
        <p>
          <strong>{compatibilityLabel}.</strong> {comparison.compatibility.explanation}
        </p>
        {comparison.compatibility.status === "exact_inputs" ? (
          <p className="fd-run-comparison__note">
            The simulated world is deterministic for these inputs. Model-generated responses may still vary.
          </p>
        ) : null}
      </section>
      <section className="fd-run-comparison__section" data-scroll-section="checks">
        <div className="fd-run-comparison__section-heading">
          <h3>
            Checks{" "}
            <span>
              {changedChecks.length} changed · {checks.length} total
            </span>
          </h3>
          <label className="fd-run-comparison__toggle">
            <input
              type="checkbox"
              checked={showUnchanged}
              onChange={(event) => setShowUnchanged(event.target.checked)}
            />
            Show unchanged checks
          </label>
        </div>
        {visibleChecks.length === 0 ? (
          <p>
            {checks.length === 0
              ? "No checks were recorded in either run."
              : "No check changes. Show unchanged checks to inspect their recorded values."}
          </p>
        ) : (
          <PaginatedContent
            items={visibleChecks}
            label="Compared checks"
            resetKey={`${pairKey}:${showUnchanged}`}
          >
            {(pageChecks) => (
              <div>
                {pageChecks.map((row) => (
                  <ComparedCheck key={row.key} row={row} />
                ))}
              </div>
            )}
          </PaginatedContent>
        )}
      </section>
      <section className="fd-run-comparison__section" data-scroll-section="operations">
        <h3>Operation changes</h3>
        {comparison.changes.operationCounts.length === 0 ? (
          <p>No operation count or error count changes.</p>
        ) : (
          <PaginatedContent
            items={comparison.changes.operationCounts}
            label="Operation changes"
            resetKey={pairKey}
          >
            {(rows) => (
              <ScrollArea label="Operation counts and errors" natural>
                <table className="fd-run-comparison__table fd-run-comparison__table--operations">
                  <thead>
                    <tr>
                      <th scope="col">Operation</th>
                      <th scope="col">Baseline calls</th>
                      <th scope="col">Candidate calls</th>
                      <th scope="col">Call change</th>
                      <th scope="col">Baseline errors</th>
                      <th scope="col">Candidate errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.subject}>
                        <th scope="row">
                          <code>{row.subject}</code>
                        </th>
                        <td>{row.baseline}</td>
                        <td>{row.candidate}</td>
                        <td>
                          {row.delta > 0 ? "+" : ""}
                          {row.delta}
                        </td>
                        <td>{row.baselineErrors}</td>
                        <td>{row.candidateErrors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            )}
          </PaginatedContent>
        )}
      </section>
      <section className="fd-run-comparison__section" data-scroll-section="data">
        <h3>Final data and events</h3>
        <p>
          {finalData}{" "}
          {comparison.changes.stateChanged === undefined
            ? "Both runs need a recorded final state hash to compare final data."
            : "This compares recorded state hashes, not a field-by-field snapshot."}
        </p>
        {comparison.changes.stateChangeCounts.length === 0 ? (
          <p className="fd-run-comparison__note">No state mutation count changes.</p>
        ) : (
          <>
            <h4>State mutation counts</h4>
            <p className="fd-run-comparison__note">
              Mutation counts describe writes during each run, not the final record values.
            </p>
            <CountTable
              rows={comparison.changes.stateChangeCounts}
              label="State mutation changes"
              subjectLabel="State collection"
            />
          </>
        )}
        {comparison.changes.eventCounts.length === 0 ? (
          <p className="fd-run-comparison__note">No event count changes.</p>
        ) : (
          <>
            <h4>Event counts</h4>
            <CountTable rows={comparison.changes.eventCounts} label="Event changes" subjectLabel="Event" />
          </>
        )}
      </section>
      {comparison.changes.interactions.length === 0 ? null : (
        <section className="fd-run-comparison__section" data-scroll-section="interactions">
          <h3>Interaction status changes</h3>
          <PaginatedContent
            items={comparison.changes.interactions}
            label="Interaction changes"
            resetKey={pairKey}
          >
            {(rows) => (
              <ScrollArea label="Interaction status changes" natural>
                <table className="fd-run-comparison__table">
                  <thead>
                    <tr>
                      <th scope="col">Interaction</th>
                      <th scope="col">Baseline</th>
                      <th scope="col">Candidate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.interactionId}>
                        <th scope="row">
                          <code>{row.interactionId}</code>
                        </th>
                        <td>{row.baseline === undefined ? "Not recorded" : titleFromId(row.baseline)}</td>
                        <td>{row.candidate === undefined ? "Not recorded" : titleFromId(row.candidate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            )}
          </PaginatedContent>
        </section>
      )}
    </div>
  );
}

export function RunComparison({
  runs,
  selectedRunId,
}: {
  readonly runs: readonly SimulationRunSummary[];
  readonly selectedRunId: string | undefined;
}) {
  const eligible = useMemo(() => runs.filter((run) => run.reportAvailable), [runs]);
  const [selection, setSelection] = useState<
    (RunPair & { readonly sourceRunId: string | undefined }) | undefined
  >();
  const pair =
    selection?.sourceRunId === selectedRunId &&
    selection !== undefined &&
    eligible.some((run) => run.runId === selection.baselineRunId) &&
    eligible.some((run) => run.runId === selection.candidateRunId)
      ? selection
      : defaultComparisonRuns(eligible, selectedRunId);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify([pair.baselineRunId, pair.candidateRunId, retry]);
  const [loaded, setLoaded] = useState<{ key: string; data?: ComparisonData; error?: string } | undefined>();
  useEffect(() => {
    if (pair.baselineRunId === "" || pair.candidateRunId === "") return;
    let current = true;
    void loadRunComparison({ baselineRunId: pair.baselineRunId, candidateRunId: pair.candidateRunId })
      .then((data) => {
        if (current) setLoaded({ key: requestKey, data });
      })
      .catch((error: unknown) => {
        if (current)
          setLoaded({
            key: requestKey,
            error: error instanceof Error ? error.message : "The saved reports could not be loaded.",
          });
      });
    return () => {
      current = false;
    };
  }, [pair.baselineRunId, pair.candidateRunId, requestKey]);
  const response = loaded?.key === requestKey ? loaded : undefined;
  const loading = eligible.length >= 2 && response === undefined;
  return (
    <div className="fd-workspace-main fd-run-comparison">
      <header className="fd-run-comparison__header">
        <h2>Compare runs</h2>
        <p>Compare an earlier result with another attempt of the same drill.</p>
        {eligible.length < 2 ? null : (
          <div className="fd-run-comparison__selectors">
            {(["baseline", "candidate"] as const).map((side) => {
              const selectedKey = side === "baseline" ? "baselineRunId" : "candidateRunId";
              const otherKey = side === "baseline" ? "candidateRunId" : "baselineRunId";
              return (
                <div key={side}>
                  <span>{titleFromId(side)}</span>
                  <Select
                    label={`${titleFromId(side)} run`}
                    value={pair[selectedKey]}
                    onChange={(event) =>
                      setSelection({ ...pair, [selectedKey]: event.target.value, sourceRunId: selectedRunId })
                    }
                  >
                    {eligible.map((run) => (
                      <option key={run.runId} value={run.runId} disabled={run.runId === pair[otherKey]}>
                        {run.drillId} · {run.runId} · {titleFromId(run.verdict ?? run.status)}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </header>
      <ScrollArea
        label="Run comparison"
        resetKey={requestKey}
        sections={
          response?.data === undefined
            ? []
            : [
                { id: "inputs", label: "Inputs" },
                { id: "checks", label: "Checks" },
                { id: "operations", label: "Operations" },
                { id: "data", label: "Data and events" },
                ...(response.data.comparison.changes.interactions.length === 0
                  ? []
                  : [{ id: "interactions", label: "Interactions" }]),
              ]
        }
      >
        <div className="fd-run-comparison__body" aria-busy={loading}>
          {eligible.length < 2 ? (
            <p>
              At least two saved reports are needed to compare runs. Complete another run, then return here.
            </p>
          ) : response?.error !== undefined ? (
            <InlineMessage tone="danger" title="Could not compare runs">
              <p>{response.error}</p>
              <Button size="compact" onClick={() => setRetry((attempt) => attempt + 1)}>
                Retry comparison
              </Button>
            </InlineMessage>
          ) : response?.data === undefined ? (
            <p role="status">Comparing saved reports…</p>
          ) : (
            <RunComparisonReport key={requestKey} {...response.data} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
