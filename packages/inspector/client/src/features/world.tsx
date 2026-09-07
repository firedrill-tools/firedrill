import { Clock3, Database, FileInput, Radio, TriangleAlert, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { ActorIdentity } from "../components/actor-identity";
import { DataViewer } from "../components/data-viewer";
import { DetailsPanel, DetailsTrigger } from "../components/details-panel";
import { PageIntro } from "../components/page-intro";
import { EmptyState, KeyValue, RowButton, SearchField } from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { SourceViewer } from "../components/source-viewer";
import { json, plural, titleFromId, virtualTime } from "../format";
import type { SimulationProject, SimulationScenario, SimulationSetup, SimulationTool } from "../types";
import { startingRecords } from "./catalog-data";
import { describeSetupChanges } from "./setup-changes";
import { ToolOverrides } from "./tool-overrides";
import "./catalog-world.css";

type WorldSelection = "setup" | `scenario:${string}` | `tool:${string}`;

interface SourceReference {
  readonly path: string;
  readonly contentHash: string;
  readonly readable: boolean;
}

function uniquelyKeyed<T>(values: readonly T[], identity: (value: T) => string) {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const base = identity(value);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { key: `${base}\u0000${occurrence}`, value };
  });
}

function WorldRail({
  project,
  selected,
  onSelect,
  page,
}: {
  readonly project: SimulationProject;
  readonly selected: WorldSelection;
  readonly onSelect: (selection: WorldSelection) => void;
  readonly page: "world" | "scenarios" | "tools";
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const scenarios = (page === "tools" ? [] : project.scenarios).filter((scenario) =>
    `${scenario.id} ${scenario.title ?? ""}`.toLowerCase().includes(normalized),
  );
  const tools = (page === "scenarios" ? [] : project.tools).filter((tool) =>
    tool.id.toLowerCase().includes(normalized),
  );

  return (
    <aside className="fd-workspace-rail">
      <div className="fd-rail-head">
        <strong>{page === "tools" ? "Tools" : page === "scenarios" ? "Scenarios" : "World contents"}</strong>
      </div>
      <div className="fd-rail-search">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            page === "tools" ? "Find a tool" : page === "scenarios" ? "Find a scenario" : "Find world content"
          }
        />
      </div>
      <div className="fd-rail-list">
        {normalized.length === 0 && page === "world" ? (
          <>
            <div className="fd-rail-section-label">Setup</div>
            <RowButton
              type="button"
              className="fd-rail-item"
              aria-current={selected === "setup" ? "true" : undefined}
              onClick={() => onSelect("setup")}
            >
              <FileInput size={16} aria-hidden="true" />
              <span>
                <strong>World setup</strong>
              </span>
            </RowButton>
          </>
        ) : null}

        {page === "world" && scenarios.length > 0 ? (
          <div className="fd-rail-section-label">Scenarios</div>
        ) : null}
        {scenarios.map((scenario) => (
          <RowButton
            type="button"
            key={scenario.id}
            className="fd-rail-item"
            aria-current={selected === `scenario:${scenario.id}` ? "true" : undefined}
            onClick={() => onSelect(`scenario:${scenario.id}`)}
          >
            <Clock3 size={16} aria-hidden="true" />
            <span>
              <strong>{scenario.title ?? titleFromId(scenario.id)}</strong>
            </span>
          </RowButton>
        ))}

        {page === "world" && tools.length > 0 ? <div className="fd-rail-section-label">Tools</div> : null}
        {tools.map((tool) => (
          <RowButton
            type="button"
            key={tool.id}
            className="fd-rail-item"
            aria-current={selected === `tool:${tool.id}` ? "true" : undefined}
            onClick={() => onSelect(`tool:${tool.id}`)}
          >
            <Wrench size={16} aria-hidden="true" />
            <span>
              <strong>{titleFromId(tool.id)}</strong>
            </span>
          </RowButton>
        ))}
      </div>
      {normalized.length > 0 && scenarios.length === 0 && tools.length === 0 ? (
        <div className="fd-rail-empty">No world content matches “{query}”.</div>
      ) : null}
    </aside>
  );
}

function OperationTable({ tool }: { readonly tool: SimulationTool }) {
  const hasDescriptions = tool.operations.some((operation) => operation.description !== undefined);
  return (
    <ScrollArea label="Tool operations" resetKey={tool.id}>
      <table className="fd-table">
        <thead>
          <tr>
            <th>Operation</th>
            {hasDescriptions ? <th>Description</th> : null}
            <th>Request & response</th>
          </tr>
        </thead>
        <tbody>
          {tool.operations.map((operation) => (
            <tr key={operation.id}>
              <td className="fd-operation-name">
                <DataViewer
                  title={`${tool.id}.${operation.id}`}
                  value={operation}
                  label={operation.id}
                  variant="link"
                />
              </td>
              {hasDescriptions ? <td className="fd-table__muted">{operation.description ?? "—"}</td> : null}
              <td>
                <div className="fd-catalog-world-actions">
                  {operation.inputSchema === undefined ? (
                    <span>Input schema unavailable</span>
                  ) : (
                    <DataViewer
                      title={`${tool.id}.${operation.id} input schema`}
                      value={operation.inputSchema}
                      label="Inputs"
                    />
                  )}
                  {operation.outputSchema === undefined ? (
                    <span>Response schema unavailable</span>
                  ) : (
                    <DataViewer
                      title={`${tool.id}.${operation.id} response schema`}
                      value={operation.outputSchema}
                      label="Responses"
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function ToolInspector({ tool }: { readonly tool: SimulationTool }) {
  return (
    <div className="fd-details-content">
      <div className="fd-inspector-head">
        <div>
          <strong>{tool.id}</strong>
        </div>
      </div>
      <ScrollArea label="Tool details" resetKey={tool.id}>
        <section className="fd-inspector-section">
          <h3>Package</h3>
          <dl>
            <KeyValue label="Version">{tool.version}</KeyValue>
          </dl>
        </section>
        <section className="fd-inspector-section">
          <h3>State namespaces</h3>
          {tool.stateNamespaces.length === 0 ? (
            <p className="fd-muted-copy">This Tool declares no persistent state.</p>
          ) : (
            <ul className="fd-plain-list">
              {tool.stateNamespaces.map((namespace) => (
                <li key={namespace}>
                  <Database size={14} />
                  <code>{namespace}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="fd-inspector-section">
          <h3>Events</h3>
          {tool.events.map((event) => (
            <div className="fd-definition-line" key={event}>
              <Radio size={14} />
              <code>{event}</code>
            </div>
          ))}
          {tool.events.length === 0 ? <p className="fd-muted-copy">No events declared.</p> : null}
        </section>
        <section className="fd-inspector-section">
          <h3>Faults</h3>
          {tool.faults.map((fault) => (
            <div className="fd-definition-line" key={fault}>
              <TriangleAlert size={14} />
              <code>{fault}</code>
            </div>
          ))}
          {tool.faults.length === 0 ? <p className="fd-muted-copy">No faults declared.</p> : null}
        </section>
        <section className="fd-inspector-section">
          <h3>HTTP bindings</h3>
          {tool.httpRoutes.length === 0 ? (
            <p className="fd-muted-copy">No HTTP routes are declared.</p>
          ) : (
            <ul className="fd-route-list">
              {tool.httpRoutes.map((route) => (
                <li key={route.id}>
                  <span data-method={route.method}>{route.method}</span>
                  <code>{route.path}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
        {tool.source === undefined ? null : <SourceSection source={tool.source} kind="tool" id={tool.id} />}
      </ScrollArea>
    </div>
  );
}

function SourceSection({
  source,
  kind,
  id,
}: {
  readonly source: SourceReference;
  readonly kind: "world" | "scenario" | "tool";
  readonly id: string;
}) {
  return (
    <section className="fd-inspector-section">
      <h3>Repository source</h3>
      <p className="fd-catalog-world-source-path">
        <code>{source.path}</code>
      </p>
      <div className="fd-catalog-world-actions">
        {source.readable ? <SourceViewer kind={kind} id={id} /> : null}
        <DataViewer title={`${id} source provenance`} value={{ id, kind, ...source }} label="Provenance" />
      </div>
      {source.readable ? null : <p className="fd-inspector-copy">Installed package definition.</p>}
    </section>
  );
}

function ActorsTable({ setup }: { readonly setup: SimulationSetup }) {
  if (setup.actors.length === 0) {
    return <p className="fd-muted-copy">No actors are declared in this setup.</p>;
  }
  return (
    <div className="fd-world-table-wrap">
      <table className="fd-world-table">
        <thead>
          <tr>
            <th>Actor</th>
            <th>Allowed operations</th>
            <th>Attributes</th>
          </tr>
        </thead>
        <tbody>
          {setup.actors.map((actor) => (
            <tr key={actor.id}>
              <td>
                <ActorIdentity actor={actor} />
              </td>
              <td>
                {actor.grants.length === 0
                  ? "None"
                  : actor.grants.map((grant) => (
                      <code className="fd-inline-code" key={`${grant.packageId}.${grant.operationId}`}>
                        {grant.packageId}.{grant.operationId}
                      </code>
                    ))}
              </td>
              <td>
                {Object.keys(actor.attributes).length === 0 ? (
                  <span className="fd-table-empty">None</span>
                ) : (
                  <DataViewer
                    title={`${actor.id} attributes`}
                    value={actor.attributes}
                    label="View attributes"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StateTable({ setup }: { readonly setup: SimulationSetup }) {
  if (setup.state.length === 0) {
    return <p className="fd-muted-copy">No starting records.</p>;
  }
  return (
    <ScrollArea label="Starting records" natural className="fd-world-records">
      <table className="fd-world-table fd-world-state-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Table</th>
            <th>Record</th>
            <th>Starting record</th>
          </tr>
        </thead>
        <tbody>
          {uniquelyKeyed(setup.state, (record) => json(record)).map(({ key, value: record }) => (
            <tr key={key}>
              <td>
                <code>{record.packageId}</code>
              </td>
              <td>
                <code>{record.namespace}</code>
              </td>
              <td>
                <code>{record.rowId}</code>
              </td>
              <td>
                {record.action === "delete" ? (
                  <span className="fd-table-empty">—</span>
                ) : (
                  <DataViewer
                    title={`${record.namespace} / ${record.rowId}`}
                    value={record.value}
                    label="View record"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function WorldWork({ setup }: { readonly setup: SimulationSetup }) {
  return (
    <div className="fd-world-work-grid">
      <section data-scroll-section="failures">
        <div className="fd-section-heading">
          <div>
            <h3>Simulated failures</h3>
          </div>
        </div>
        {setup.faults.length === 0 ? (
          <p className="fd-muted-copy">No failures are enabled at the start.</p>
        ) : (
          <ul className="fd-world-item-list">
            {setup.faults.map((fault) => (
              <li key={`${fault.packageId}.${fault.faultId}`}>
                <TriangleAlert size={15} aria-hidden="true" />
                <code>
                  {fault.packageId}.{fault.faultId}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-scroll-section="events">
        <div className="fd-section-heading">
          <div>
            <h3>Scheduled events</h3>
          </div>
        </div>
        {setup.initialEvents.length === 0 ? (
          <p className="fd-muted-copy">No initial events are scheduled.</p>
        ) : (
          <ul className="fd-world-item-list">
            {uniquelyKeyed(setup.initialEvents, (event) => json(event)).map(({ key, value: event }) => (
              <li key={key}>
                <Radio size={15} aria-hidden="true" />
                <span>
                  <code>
                    {event.event.packageId}.{event.event.eventId}
                  </code>
                  <span className="fd-catalog-world-event-meta">
                    {virtualTime(event.atUs)} · actor {event.actorId}
                  </span>
                  <DataViewer title="Scheduled event" label="View event" value={event} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScenarioChanges({
  baseline,
  setup,
}: {
  readonly baseline: SimulationSetup;
  readonly setup: SimulationSetup;
}) {
  const changes = describeSetupChanges(baseline, setup);
  const updatedRecords = changes.state.filter((record) => record.action === "upsert").length;
  const removedRecords = changes.state.length - updatedRecords;
  return (
    <section className="fd-definition__section" data-scroll-section="changes">
      <h3>Changes from world baseline</h3>
      {!changes.hasChanges ? (
        <p>Uses the world baseline unchanged.</p>
      ) : (
        <ul className="fd-setup-changes">
          {changes.addedFaults.map((fault) => (
            <li key={`enable:${fault.packageId}.${fault.faultId}`}>
              Enables{" "}
              <code>
                {fault.packageId}.{fault.faultId}
              </code>
              .
            </li>
          ))}
          {changes.removedFaults.map((fault) => (
            <li key={`disable:${fault.packageId}.${fault.faultId}`}>
              Disables{" "}
              <code>
                {fault.packageId}.{fault.faultId}
              </code>
              .
            </li>
          ))}
          {updatedRecords > 0 ? <li>{plural(updatedRecords, "starting record")} added or updated.</li> : null}
          {removedRecords > 0 ? <li>{plural(removedRecords, "starting record")} removed.</li> : null}
          {changes.actors.length > 0 ? (
            <li>{plural(changes.actors.length, "actor")} added or changed.</li>
          ) : null}
          {changes.removedActors.length > 0 ? (
            <li>{plural(changes.removedActors.length, "actor")} removed.</li>
          ) : null}
          {changes.addedInitialEvents.length > 0 ? (
            <li>{plural(changes.addedInitialEvents.length, "event")} scheduled.</li>
          ) : null}
          {changes.removedInitialEvents.length > 0 ? (
            <li>{plural(changes.removedInitialEvents.length, "scheduled event")} removed.</li>
          ) : null}
          {changes.eventOrderChanged ? <li>The setup order of inherited scheduled events changes.</li> : null}
          {changes.changedToolOverrides.length > 0 ? (
            <li>{plural(changes.changedToolOverrides.length, "Tool override")} added or changed.</li>
          ) : null}
          {changes.removedToolOverrides.length > 0 ? (
            <li>{plural(changes.removedToolOverrides.length, "Tool override")} removed.</li>
          ) : null}
          {changes.toolOverrideOrderChanged ? (
            <li>The priority order of inherited Tool overrides changes.</li>
          ) : null}
          {changes.clockChanged ? (
            <li>
              Starting clock: {virtualTime(baseline.virtualTimeUs)} → {virtualTime(setup.virtualTimeUs)}.
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function SetupMain({
  title,
  setup,
  baseline,
}: {
  readonly title: string;
  readonly setup: SimulationSetup;
  readonly baseline?: SimulationSetup;
}) {
  const records = startingRecords(setup).map((record) => ({ ...record, action: "upsert" as const }));
  const sections = [
    ...(baseline === undefined ? [] : [{ id: "changes", label: "Changes" }]),
    { id: "data", label: "Starting data" },
    { id: "failures", label: "Failures" },
    { id: "events", label: "Events" },
    ...((setup.toolOverrides?.length ?? 0) === 0 ? [] : [{ id: "tool-overrides", label: "Tool overrides" }]),
    { id: "permissions", label: "Permissions" },
  ];
  return (
    <div className="fd-workspace-main">
      <div className="fd-workspace-titlebar">
        <div>
          <h2>{title}</h2>
          <p>
            {baseline === undefined
              ? "World starting setup"
              : "Starting setup, including inherited world data and permissions"}
          </p>
        </div>
      </div>
      <ScrollArea label="Starting setup" sections={sections}>
        {baseline === undefined ? null : <ScenarioChanges baseline={baseline} setup={setup} />}
        <section className="fd-definition__section" data-scroll-section="data">
          <div className="fd-section-heading">
            <div>
              <h3>Starting data</h3>
              <p>Records available before the agent runs. These are not execution results.</p>
            </div>
          </div>
          <StateTable setup={{ ...setup, state: records }} />
        </section>
        <WorldWork setup={setup} />
        <ToolOverrides rules={setup.toolOverrides} />
        <section className="fd-definition__section" data-scroll-section="permissions">
          <div className="fd-section-heading">
            <div>
              <h3>Actors and permissions</h3>
              <p>Identities used to call tools, and the operations each may perform.</p>
            </div>
          </div>
          <ActorsTable setup={setup} />
        </section>
      </ScrollArea>
    </div>
  );
}

function SetupInspector({
  title,
  setup,
  source,
  sourceKind,
  sourceId,
}: {
  readonly title: string;
  readonly setup: SimulationSetup;
  readonly source?: SourceReference;
  readonly sourceKind: "world" | "scenario";
  readonly sourceId: string;
}) {
  return (
    <div className="fd-details-content">
      <div className="fd-inspector-head">
        <div>
          <strong>{title}</strong>
        </div>
      </div>
      <ScrollArea label="Setup details" resetKey={sourceId}>
        <section className="fd-inspector-section">
          <h3>Starting conditions</h3>
          <dl>
            <KeyValue label="ID">
              <code>{sourceId}</code>
            </KeyValue>
            <KeyValue label="Clock">{virtualTime(setup.virtualTimeUs)}</KeyValue>
            <KeyValue label="Actors">{setup.actors.length}</KeyValue>
            <KeyValue label="Data changes">{setup.state.length}</KeyValue>
            <KeyValue label="Faults">{setup.faults.length}</KeyValue>
            <KeyValue label="Events">{setup.initialEvents.length}</KeyValue>
          </dl>
        </section>
        {source === undefined ? null : <SourceSection source={source} kind={sourceKind} id={sourceId} />}
      </ScrollArea>
    </div>
  );
}

function ToolMain({ tool }: { readonly tool: SimulationTool }) {
  return (
    <div className="fd-workspace-main">
      <div className="fd-workspace-titlebar">
        <div>
          <h2>{titleFromId(tool.id)}</h2>
        </div>
      </div>
      <OperationTable tool={tool} />
    </div>
  );
}

function selectedScenario(
  project: SimulationProject,
  selected: WorldSelection,
): SimulationScenario | undefined {
  if (!selected.startsWith("scenario:")) return undefined;
  const id = selected.slice("scenario:".length);
  return project.scenarios.find((scenario) => scenario.id === id);
}

function selectedTool(project: SimulationProject, selected: WorldSelection): SimulationTool | undefined {
  if (!selected.startsWith("tool:")) return undefined;
  const id = selected.slice("tool:".length);
  return project.tools.find((tool) => tool.id === id);
}

export function WorldView({
  project,
  page = "world",
}: {
  readonly project: SimulationProject;
  readonly page?: "world" | "scenarios" | "tools";
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `${page}-details`;
  const [selected, setSelected] = useState<WorldSelection>(() =>
    page === "tools" && project.tools[0] !== undefined
      ? `tool:${project.tools[0].id}`
      : page === "scenarios" && project.scenarios[0] !== undefined
        ? `scenario:${project.scenarios[0].id}`
        : "setup",
  );
  const scenario = useMemo(() => selectedScenario(project, selected), [project, selected]);
  const tool = useMemo(() => selectedTool(project, selected), [project, selected]);
  const selection = scenario === undefined && tool === undefined && selected !== "setup" ? "setup" : selected;

  if (
    (page === "scenarios" && project.scenarios.length === 0) ||
    (page === "tools" && project.tools.length === 0)
  ) {
    return (
      <section className="fd-page fd-page--workspace">
        <header className="fd-page-header">
          <PageIntro page={page} />
        </header>
        <EmptyState title={page === "scenarios" ? "No scenarios defined" : "No synthetic tools defined"}>
          {page === "scenarios"
            ? "Drills can use the world baseline directly. Add a scenario file when you need a different starting situation."
            : "Define tools in your repository, then refresh source to inspect their contracts here."}
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page={page} />
        {project.diagnostics.length === 0 ? null : (
          <span className="fd-page-diagnostic">
            <TriangleAlert size={15} aria-hidden="true" />
            {plural(project.diagnostics.length, "compiler diagnostic")}
          </span>
        )}
        <DetailsTrigger id={detailsId} open={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)} />
      </header>
      <div className="fd-workspace fd-world-workspace fd-details-workspace">
        <WorldRail
          project={project}
          selected={selection}
          onSelect={(next) => {
            setSelected(next);
            setDetailsOpen(false);
          }}
          page={page}
        />
        {scenario !== undefined ? (
          <SetupMain
            key={scenario.id}
            title={scenario.title ?? titleFromId(scenario.id)}
            setup={scenario}
            baseline={project.world.baseline}
          />
        ) : tool !== undefined ? (
          <ToolMain tool={tool} />
        ) : (
          <SetupMain
            key="baseline"
            title={project.world.title ?? titleFromId(project.world.id)}
            setup={project.world.baseline}
          />
        )}
        <DetailsPanel id={detailsId} title="Details" open={detailsOpen} onClose={() => setDetailsOpen(false)}>
          {scenario !== undefined ? (
            <SetupInspector
              title={scenario.title ?? titleFromId(scenario.id)}
              setup={scenario}
              {...(scenario.source === undefined ? {} : { source: scenario.source })}
              sourceKind="scenario"
              sourceId={scenario.id}
            />
          ) : tool !== undefined ? (
            <ToolInspector tool={tool} />
          ) : (
            <SetupInspector
              title={project.world.title ?? titleFromId(project.world.id)}
              setup={project.world.baseline}
              {...(project.world.source === undefined ? {} : { source: project.world.source })}
              sourceKind="world"
              sourceId={project.world.id}
            />
          )}
        </DetailsPanel>
      </div>
    </section>
  );
}
