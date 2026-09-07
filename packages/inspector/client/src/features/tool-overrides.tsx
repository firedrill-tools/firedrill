import { DataViewer } from "../components/data-viewer";
import { PaginatedContent } from "../components/pagination";
import { ScrollArea } from "../components/scroll-area";
import type { SimulationSetup } from "../types";
import "./tool-overrides.css";

type OverrideRule = NonNullable<SimulationSetup["toolOverrides"]>[number];

export function overrideScopeLabel(scope: OverrideRule["scope"]): string {
  if (scope.kind === "baseline") return "World baseline";
  if (scope.kind === "scenario") return `Scenario: ${scope.scenarioId}`;
  if (scope.kind === "drill") return `Drill: ${scope.drillId}`;
  return `Test-local setup: ${scope.drillId}`;
}

export function overrideOutcomeLabel(outcome: OverrideRule["outcome"]["kind"]): string {
  if (outcome === "return") return "Fixed response";
  if (outcome === "error") return "Simulated error";
  return "Original Tool behavior";
}

export function ToolOverrides({ rules }: { readonly rules: SimulationSetup["toolOverrides"] }) {
  if (rules === undefined || rules.length === 0) return null;
  return (
    <section className="fd-definition__section" data-scroll-section="tool-overrides">
      <h3>Tool overrides</h3>
      <p className="fd-tool-overrides-intro">
        Matching rules are checked from bottom to top across all pages. Fixed responses and errors skip the
        Tool’s original behavior and state changes.
      </p>
      <PaginatedContent items={rules} label="Tool override rules">
        {(pageRules) => (
          <ScrollArea label="Tool override rules" natural>
            <table className="fd-world-table fd-tool-overrides-table">
              <thead>
                <tr>
                  <th>Rule and operation</th>
                  <th>Matches</th>
                  <th>Behavior</th>
                  <th>Defined in</th>
                </tr>
              </thead>
              <tbody>
                {pageRules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <DataViewer
                        title={`Tool override: ${rule.id}`}
                        label={rule.id}
                        value={rule}
                        variant="link"
                      />
                      <code>
                        {rule.operation.packageId}.{rule.operation.operationId}
                      </code>
                    </td>
                    <td>
                      <div>
                        {rule.when?.actorId === undefined ? "Any actor" : `Actor: ${rule.when.actorId}`}
                      </div>
                      {rule.when?.arguments === undefined || Object.keys(rule.when.arguments).length === 0 ? (
                        <div>Any arguments</div>
                      ) : (
                        <DataViewer
                          title={`${rule.id}: matching arguments`}
                          label="Matching arguments"
                          value={rule.when.arguments}
                        />
                      )}
                      <div>
                        {rule.times === undefined
                          ? "Every matching call"
                          : `First ${rule.times} matching ${rule.times === 1 ? "call" : "calls"}`}
                      </div>
                    </td>
                    <td>
                      <div>{overrideOutcomeLabel(rule.outcome.kind)}</div>
                      {rule.outcome.kind === "return" ? (
                        <DataViewer
                          title={`${rule.id}: fixed response`}
                          label="View response"
                          value={rule.outcome.value}
                        />
                      ) : null}
                      {rule.outcome.kind === "error" ? (
                        <DataViewer
                          title={`${rule.id}: simulated error`}
                          label={rule.outcome.code}
                          value={rule.outcome}
                          variant="link"
                        />
                      ) : null}
                    </td>
                    <td>{overrideScopeLabel(rule.scope)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </PaginatedContent>
    </section>
  );
}
