import { Braces, Cable, Database, Radio, Route as RouteIcon, TriangleAlert, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { compactId, plural, titleFromId } from "../format";
import type { SimulationProject, SimulationTool } from "../types";
import { CodeBlock, EmptyState, KeyValue, SearchField, Status } from "../components/primitives";

function ToolRail({
  tools,
  selectedId,
  onSelect,
}: {
  readonly tools: readonly SimulationTool[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = tools.filter((tool) => tool.id.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="fd-workspace-rail">
      <div className="fd-rail-head">
        <strong>Tools</strong>
        <span>{tools.length}</span>
      </div>
      <div className="fd-rail-search">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a Tool"
        />
      </div>
      <div className="fd-rail-list">
        {filtered.map((tool) => (
          <button
            type="button"
            key={tool.id}
            className="fd-rail-item"
            aria-current={selectedId === tool.id ? "true" : undefined}
            onClick={() => onSelect(tool.id)}
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
      {filtered.length === 0 ? <div className="fd-rail-empty">No Tools match “{query}”.</div> : null}
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
        {tool.source === undefined ? null : (
          <section className="fd-inspector-section">
            <h3>Repository source</h3>
            <CodeBlock>{tool.source.path}</CodeBlock>
            <p className="fd-hash" title={tool.source.contentHash}>
              {compactId(tool.source.contentHash, 22)}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}

export function WorldView({ project }: { readonly project: SimulationProject }) {
  const [selectedId, setSelectedId] = useState(project.tools[0]?.id);
  const selected = useMemo(
    () => project.tools.find((tool) => tool.id === selectedId) ?? project.tools[0],
    [project.tools, selectedId],
  );

  if (project.tools.length === 0) {
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <div>
            <h1>World</h1>
            <p>{project.world.title ?? project.world.id}</p>
          </div>
        </header>
        <EmptyState title="No Tools in this world">
          Add a repository-defined Tool, then refresh the inspector. Source remains authoritative.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <div>
          <h1>World</h1>
          <p>
            {plural(project.tools.length, "Tool")} · {plural(project.drills.length, "drill")} · seed{" "}
            <code>{project.world.seed}</code>
          </p>
        </div>
        <Status tone={project.diagnostics.length === 0 ? "success" : "warning"}>
          {project.diagnostics.length === 0
            ? "Source valid"
            : plural(project.diagnostics.length, "diagnostic")}
        </Status>
      </header>
      <div className="fd-workspace fd-world-workspace">
        <ToolRail tools={project.tools} selectedId={selected?.id} onSelect={setSelectedId} />
        {selected === undefined ? null : (
          <div className="fd-workspace-main">
            <div className="fd-workspace-titlebar">
              <div>
                <h2>{titleFromId(selected.id)}</h2>
                <p>
                  <code>{selected.id}</code> · version {selected.version}
                </p>
              </div>
              <div className="fd-compact-facts">
                <span>
                  <Cable size={14} /> {plural(selected.operations.length, "operation")}
                </span>
                <span>
                  <Braces size={14} /> {plural(selected.stateNamespaces.length, "namespace")}
                </span>
                <span>
                  <RouteIcon size={14} /> {plural(selected.httpRoutes.length, "HTTP route")}
                </span>
              </div>
            </div>
            <OperationTable tool={selected} />
          </div>
        )}
        {selected === undefined ? null : <ToolInspector tool={selected} />}
      </div>
    </section>
  );
}
