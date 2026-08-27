import {
  Braces,
  Cable,
  Clock3,
  Database,
  FileInput,
  Radio,
  Route as RouteIcon,
  TriangleAlert,
  UserRound,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { CodeBlock, KeyValue, SearchField } from "../components/primitives";
import { compactId, json, plural, titleFromId, virtualTime } from "../format";
import type { SimulationProject, SimulationScenario, SimulationSetup, SimulationTool } from "../types";

type WorldSelection = "setup" | `scenario:${string}` | `tool:${string}`;

interface SourceReference {
  readonly path: string;
  readonly contentHash: string;
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
}: {
  readonly project: SimulationProject;
  readonly selected: WorldSelection;
  readonly onSelect: (selection: WorldSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const scenarios = project.scenarios.filter((scenario) =>
    `${scenario.id} ${scenario.title ?? ""}`.toLowerCase().includes(normalized),
  );
  const tools = project.tools.filter((tool) => tool.id.toLowerCase().includes(normalized));

  return (
    <aside className="fd-workspace-rail">
      <div className="fd-rail-head">
        <strong>World contents</strong>
      </div>
      <div className="fd-rail-search">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a scenario or Tool"
        />
      </div>
      <div className="fd-rail-list">
        {normalized.length === 0 ? (
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
                <small>Starting state</small>
              </span>
            </button>
          </>
        ) : null}

        {scenarios.length > 0 ? <div className="fd-rail-section-label">Scenarios</div> : null}
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
              <small>{scenario.id}</small>
            </span>
            <em>{scenario.state.length}</em>
          </button>
        ))}

        {tools.length > 0 ? <div className="fd-rail-section-label">Tools</div> : null}
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
              <small>{tool.id}</small>
            </span>
            <em>{tool.operations.length}</em>
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
  return (
    <div className="fd-table-scroll">
      <table className="fd-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Fidelity</th>
            <th>Idempotency</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {tool.operations.map((operation) => (
            <tr key={operation.id}>
              <td>
                <code>{operation.id}</code>
              </td>
              <td>{titleFromId(operation.fidelity)}</td>
              <td>{titleFromId(operation.idempotency)}</td>
              <td className="fd-table__muted">{operation.description ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolInspector({ tool }: { readonly tool: SimulationTool }) {
  return (
    <aside className="fd-selection-inspector">
      <div className="fd-inspector-head">
        <div>
          <strong>{titleFromId(tool.id)}</strong>
          <code>
            {tool.id}@{tool.version}
          </code>
        </div>
      </div>
      <div className="fd-inspector-scroll">
        <section className="fd-inspector-section">
          <h3>Contract</h3>
          <dl>
            <KeyValue label="Operations">{tool.operations.length}</KeyValue>
            <KeyValue label="State">{tool.stateNamespaces.length}</KeyValue>
            <KeyValue label="Events">{tool.events.length}</KeyValue>
            <KeyValue label="Faults">{tool.faults.length}</KeyValue>
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
          <h3>Events and faults</h3>
          {tool.events.map((event) => (
            <div className="fd-definition-line" key={event}>
              <Radio size={14} />
              <code>{event}</code>
            </div>
          ))}
          {tool.faults.map((fault) => (
            <div className="fd-definition-line" key={fault}>
              <TriangleAlert size={14} />
              <code>{fault}</code>
            </div>
          ))}
          {tool.events.length === 0 && tool.faults.length === 0 ? (
            <p className="fd-muted-copy">No events or faults are declared.</p>
          ) : null}
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
        {tool.source === undefined ? null : <SourceSection source={tool.source} />}
      </div>
    </aside>
  );
}

function SourceSection({ source }: { readonly source: SourceReference }) {
  return (
    <section className="fd-inspector-section">
      <h3>Repository source</h3>
      <CodeBlock>{source.path}</CodeBlock>
      <p className="fd-hash" title={source.contentHash}>
        {compactId(source.contentHash, 22)}
      </p>
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
                  <pre className="fd-json-cell">{json(actor.attributes)}</pre>
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
                  <pre className="fd-json-cell">{json(record.value)}</pre>
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
            <h3>Active faults</h3>
            <p>Faults enabled when this world starts.</p>
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
            <h3>Initial events</h3>
            <p>Events scheduled by the setup before the agent acts.</p>
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
                  <small>
                    {virtualTime(event.atUs)} · actor {event.actorId}
                  </small>
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
  id,
  setup,
  resolved,
}: {
  readonly title: string;
  readonly id: string;
  readonly setup: SimulationSetup;
  readonly resolved: boolean;
}) {
  return (
    <div className="fd-workspace-main">
      <div className="fd-workspace-titlebar">
        <div>
          <h2>{title}</h2>
          <p>
            <code>{id}</code> · {resolved ? "resolved starting conditions" : "baseline starting conditions"}
          </p>
        </div>
        <div className="fd-compact-facts">
          <span>
            <UserRound size={14} /> {plural(setup.actors.length, "actor")}
          </span>
          <span>
            <Database size={14} /> {plural(setup.state.length, "state change")}
          </span>
          <span>
            <Clock3 size={14} /> {virtualTime(setup.virtualTimeUs)}
          </span>
        </div>
      </div>
      <div className="fd-world-definition">
        <section className="fd-definition__section">
          <div className="fd-section-heading">
            <div>
              <h3>Actors and permissions</h3>
              <p>Identities available to the agent and the operations each identity may call.</p>
            </div>
          </div>
          <ActorsTable setup={setup} />
        </section>
        <section className="fd-definition__section">
          <div className="fd-section-heading">
            <div>
              <h3>Starting state</h3>
              <p>Records applied before the drill begins.</p>
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
  resolved,
}: {
  readonly title: string;
  readonly setup: SimulationSetup;
  readonly source?: SourceReference;
  readonly resolved: boolean;
}) {
  return (
    <aside className="fd-selection-inspector">
      <div className="fd-inspector-head">
        <div>
          <strong>{title}</strong>
          <code>{resolved ? "resolved scenario" : "world baseline"}</code>
        </div>
      </div>
      <div className="fd-inspector-scroll">
        <section className="fd-inspector-section">
          <h3>Starting conditions</h3>
          <dl>
            <KeyValue label="Clock">{virtualTime(setup.virtualTimeUs)}</KeyValue>
            <KeyValue label="Actors">{setup.actors.length}</KeyValue>
            <KeyValue label="State">{setup.state.length}</KeyValue>
            <KeyValue label="Faults">{setup.faults.length}</KeyValue>
            <KeyValue label="Events">{setup.initialEvents.length}</KeyValue>
          </dl>
        </section>
        <section className="fd-inspector-section">
          <h3>{resolved ? "Resolved view" : "Compiled view"}</h3>
          <p className="fd-inspector-copy">
            {resolved
              ? "This view includes the world baseline plus this scenario's overrides. Repository source remains authoritative."
              : "This is the compiled world baseline. Repository source remains authoritative."}
          </p>
        </section>
        {source === undefined ? null : <SourceSection source={source} />}
      </div>
    </aside>
  );
}

function ToolMain({ tool }: { readonly tool: SimulationTool }) {
  return (
    <div className="fd-workspace-main">
      <div className="fd-workspace-titlebar">
        <div>
          <h2>{titleFromId(tool.id)}</h2>
          <p>
            <code>{tool.id}</code> · version {tool.version}
          </p>
        </div>
        <div className="fd-compact-facts">
          <span>
            <Cable size={14} /> {plural(tool.operations.length, "operation")}
          </span>
          <span>
            <Braces size={14} /> {plural(tool.stateNamespaces.length, "namespace")}
          </span>
          <span>
            <RouteIcon size={14} /> {plural(tool.httpRoutes.length, "HTTP route")}
          </span>
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

export function WorldView({ project }: { readonly project: SimulationProject }) {
  const [selected, setSelected] = useState<WorldSelection>("setup");
  const scenario = useMemo(() => selectedScenario(project, selected), [project, selected]);
  const tool = useMemo(() => selectedTool(project, selected), [project, selected]);
  const selection = scenario === undefined && tool === undefined && selected !== "setup" ? "setup" : selected;

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <div>
          <h1>World</h1>
        </div>
        {project.diagnostics.length === 0 ? null : (
          <span className="fd-page-diagnostic">
            <TriangleAlert size={15} aria-hidden="true" />
            {plural(project.diagnostics.length, "compiler diagnostic")}
          </span>
        )}
      </header>
      <div className="fd-workspace fd-world-workspace">
        <WorldRail project={project} selected={selection} onSelect={setSelected} />
        {scenario !== undefined ? (
          <>
            <SetupMain
              title={scenario.title ?? titleFromId(scenario.id)}
              id={scenario.id}
              setup={scenario}
              resolved
            />
            <SetupInspector
              title={scenario.title ?? titleFromId(scenario.id)}
              setup={scenario}
              {...(scenario.source === undefined ? {} : { source: scenario.source })}
              resolved
            />
          </>
        ) : tool !== undefined ? (
          <>
            <ToolMain tool={tool} />
            <ToolInspector tool={tool} />
          </>
        ) : (
          <>
            <SetupMain
              title={project.world.title ?? titleFromId(project.world.id)}
              id={project.world.id}
              setup={project.world.baseline}
              resolved={false}
            />
            <SetupInspector
              title={project.world.title ?? titleFromId(project.world.id)}
              setup={project.world.baseline}
              {...(project.world.source === undefined ? {} : { source: project.world.source })}
              resolved={false}
            />
          </>
        )}
      </div>
    </section>
  );
}
