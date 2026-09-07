import { PaginatedContent } from "../components/pagination";
import { Status } from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { compactId, titleFromId } from "../format";
import { runHref } from "../navigation";
import type { SimulationRunSummary } from "../types";
import { OlderRuns, resultLabel, resultTone, RunListWarning, type RunHistoryControls } from "./runs";
import "./scenario-runs.css";

export function ScenarioRuns({
  scenarioId,
  runs,
  history,
  unavailableRunCount = 0,
  onOpenRun,
}: {
  readonly scenarioId: string;
  readonly runs: readonly SimulationRunSummary[];
  readonly history?: RunHistoryControls | undefined;
  readonly unavailableRunCount?: number;
  readonly onOpenRun?: ((runId: string) => void) | undefined;
}) {
  // Historical evidence owns this association, not the current drill's scenario assignment.
  const matchingRuns = runs.filter((run) => run.scenarioId === scenarioId);
  const incomplete =
    history?.hasMore === true || history?.latestError !== undefined || unavailableRunCount > 0;
  return (
    <section
      className="fd-definition__section fd-scenario-runs"
      data-scroll-section="runs"
      aria-label="Scenario runs"
    >
      <div className="fd-section-heading">
        <div>
          <h3>Runs</h3>
          <p>Runs recorded with this scenario. Earlier runs may use an older definition.</p>
        </div>
      </div>
      <RunListWarning history={history} />
      {unavailableRunCount > 0 ? (
        <p role="status">Some reports could not be read; this list may be incomplete.</p>
      ) : null}
      {matchingRuns.length === 0 ? (
        <p>{incomplete ? "No loaded runs for this scenario." : "No runs recorded for this scenario."}</p>
      ) : (
        <PaginatedContent items={matchingRuns} label="Scenario runs" resetKey={scenarioId} pageSize={5}>
          {(pageRuns) => (
            <ScrollArea label="Scenario run results" natural>
              <table className="fd-table fd-table--catalog">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Drill</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="fd-table__actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRuns.map((run) => (
                    <tr key={run.runId}>
                      <td>
                        <code title={run.runId}>{compactId(run.runId, 23)}</code>
                      </td>
                      <td title={run.drillId}>{titleFromId(run.drillId)}</td>
                      <td>
                        <Status tone={resultTone(run.verdict ?? run.status)}>{resultLabel(run)}</Status>
                      </td>
                      <td className="fd-table__actions">
                        <a
                          className="fd-button fd-button--secondary fd-button--compact"
                          href={runHref(run.runId)}
                          aria-label={`Open run ${run.runId}`}
                          onClick={(event) => {
                            if (
                              onOpenRun === undefined ||
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            onOpenRun(run.runId);
                          }}
                        >
                          Open run
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </PaginatedContent>
      )}
      {history?.hasMore ? <p>Older project history may contain more runs for this scenario.</p> : null}
      <OlderRuns history={history} />
    </section>
  );
}
