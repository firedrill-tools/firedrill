import { Clock3, Database, FileInput, Radio, TriangleAlert, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { DataViewer } from "../components/data-viewer";
import { DetailsPanel, DetailsTrigger } from "../components/details-panel";
import { PageIntro } from "../components/page-intro";
import { EmptyState, KeyValue, SearchField } from "../components/primitives";
import { SourceViewer } from "../components/source-viewer";
import { json, plural, titleFromId, virtualTime } from "../format";
import type { SimulationProject, SimulationScenario, SimulationSetup, SimulationTool } from "../types";
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
            <button
              type="button"
              className="fd-rail-item"
              aria-current={selected === "setup" ? "true" : undefined}
              onClick={() => onSelect("setup")}
            >
              <FileInput size={16} aria-hidden="true" />
              <span>
                <strong>World setup</strong>
              </span>
            </button>
          </>
        ) : null}

        {page === "world" && scenarios.length > 0 ? (
          <div className="fd-rail-section-label">Scenarios</div>
        ) : null}
        {scenarios.map((scenario) => (
          <button
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
          </button>
        ))}

        {page === "world" && tools.length > 0 ? <div className="fd-rail-section-label">Tools</div> : null}
        {tools.map((tool) => (
          <button
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
          </button>
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
    <div className="fd-table-scroll">
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
                <DataViewer title={`${tool.id}.${operation.id}`} value={operation} label={operation.id} />
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
    </div>
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
      <div className="fd-inspector-scroll">
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
      </div>
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
                <code>{actor.id}</code>
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
    return <p className="fd-muted-copy">No records are added or removed by this setup.</p>;
  }
  return (
    <div className="fd-world-table-wrap">
      <table className="fd-world-table fd-world-state-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Namespace</th>
            <th>Record</th>
            <th>Action</th>
            <th>Value</th>
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
              <td>{titleFromId(record.action)}</td>
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
    </div>
  );
}

function WorldWork({ setup }: { readonly setup: SimulationSetup }) {
  return (
    <div className="fd-world-work-grid">
      <section>
        <div className="fd-section-heading">
          <div>
            <h3>Starting faults</h3>
          </div>
        </div>
        {setup.faults.length === 0 ? (
          <p className="fd-muted-copy">No faults are active.</p>
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
      <section>
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
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SetupMain({
  title,
  setup,
  resolved,
}: {
  readonly title: string;
  readonly setup: SimulationSetup;
  readonly resolved: boolean;
}) {
  return (
    <div className="fd-workspace-main">
      <div className="fd-workspace-titlebar">
        <div>
          <h2>{title}</h2>
          <p>{resolved ? "World baseline with scenario changes" : "World baseline"}</p>
        </div>
      </div>
      <div className="fd-world-definition">
        <section className="fd-definition__section">
          <div className="fd-section-heading">
            <div>
              <h3>Actors and permissions</h3>
            </div>
          </div>
          <ActorsTable setup={setup} />
        </section>
        <section className="fd-definition__section">
          <div className="fd-section-heading">
            <div>
              <h3>Starting data changes</h3>
              <p>Applied in order before a drill starts. Data shows the resulting records.</p>
            </div>
          </div>
          <StateTable setup={setup} />
        </section>
        <WorldWork setup={setup} />
      </div>
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
      <div className="fd-inspector-scroll">
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
      </div>
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
          <SetupMain title={scenario.title ?? titleFromId(scenario.id)} setup={scenario} resolved />
        ) : tool !== undefined ? (
          <ToolMain tool={tool} />
        ) : (
          <SetupMain
            title={project.world.title ?? titleFromId(project.world.id)}
            setup={project.world.baseline}
            resolved={false}
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
