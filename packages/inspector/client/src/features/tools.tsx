import { ArrowLeft, ArrowRight, FileCode, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DataViewer } from "../components/data-viewer";
import { Pagination, usePagination } from "../components/pagination";
import { Button, EmptyState, RowButton, SearchField, Select } from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { SourceViewer } from "../components/source-viewer";
import { plural, titleFromId } from "../format";
import { type ToolTab, toolHref } from "../navigation";
import type { SimulationProject, SimulationTool } from "../types";
import { recordCell, startingRecords } from "./catalog-data";
import { ToolImplementation } from "./tool-implementation";
import { ToolInterfaces } from "./tool-interfaces";
import { OperationTable } from "./world";
import "./local-workspace.css";

export function ToolStartingData({
  project,
  tool,
}: {
  readonly project: SimulationProject;
  readonly tool: SimulationTool;
}) {
  const [scenarioId, setScenarioId] = useState("");
  const [query, setQuery] = useState("");
  const scenario = project.scenarios.find((item) => item.id === scenarioId);
  const rows = startingRecords(scenario ?? project.world.baseline).filter(
    (row) =>
      row.packageId === tool.id &&
      `${row.namespace} ${row.rowId} ${JSON.stringify(row.value)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const pagination = usePagination(rows, `${tool.id}:${scenarioId}:${query}`);
  return (
    <>
      <div className="fd-local-toolbar">
        <SearchField
          placeholder="Search starting records"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          label="Starting situation"
          value={scenarioId}
          onChange={(event) => setScenarioId(event.target.value)}
        >
          <option value="">World baseline</option>
          {project.scenarios.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title ?? item.id}
            </option>
          ))}
        </Select>
      </div>
      <p className="fd-local-note">
        Source-defined starting records, not live state. Calls do not change these definitions.
      </p>
      <ScrollArea
        label="Tool starting data"
        resetKey={`${tool.id}:${scenarioId}:${query}:${pagination.page}`}
      >
        {rows.length === 0 ? (
          <EmptyState title={query === "" ? "No starting records" : "No matching records"}>
            {query === ""
              ? "This tool starts empty in the selected situation. Its operations may create records."
              : "Change your search to see other starting records."}
          </EmptyState>
        ) : (
          <table className="fd-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Record</th>
                <th>Values</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((row) => (
                <tr key={JSON.stringify([row.namespace, row.rowId])}>
                  <td>
                    <code>{row.namespace}</code>
                  </td>
                  <td>
                    <code>{row.rowId}</code>
                  </td>
                  <td>
                    <span className="fd-local-record-summary">
                      {Object.entries(row.value)
                        .map(([key, value]) => `${key}: ${recordCell(value)}`)
                        .join(" · ")}
                    </span>
                  </td>
                  <td>
                    <DataViewer
                      title={`${row.namespace} / ${row.rowId}`}
                      value={row.value}
                      label="View record"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ScrollArea>
      <Pagination label="Starting records" {...pagination} />
    </>
  );
}

function ToolBehavior({ tool }: { readonly tool: SimulationTool }) {
  return (
    <>
      <ToolInterfaces tool={tool} />
      <div className="fd-local-contract-summary">
        <span>{plural(tool.operations.length, "operation")}</span>
        <span>{plural(tool.stateNamespaces.length, "state table")}</span>
        <span>{plural(tool.events.length, "event type")}</span>
        <span>{plural(tool.faults.length, "declared fault")}</span>
        {tool.definition === undefined ? null : (
          <DataViewer title={`${tool.id} full contract`} value={tool.definition} label="Full contract" />
        )}
      </div>
      {tool.operations.length === 0 ? (
        <EmptyState title="No operations declared">
          Add operations to the tool source, then refresh repository source.
        </EmptyState>
      ) : (
        <OperationTable tool={tool} />
      )}
    </>
  );
}

export function ToolsView({
  project,
  selection,
  onVisit,
  runtimeSummary,
  testTool,
}: {
  readonly project: SimulationProject;
  readonly selection: { readonly id: string | undefined; readonly tab: ToolTab };
  readonly onVisit: (href: string) => void;
  readonly runtimeSummary?: ReactNode;
  readonly testTool: (tool: SimulationTool) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const filtered = project.tools.filter((tool) =>
    `${tool.id} ${tool.operations.map((op) => `${op.id} ${op.description ?? ""}`).join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const pagination = usePagination(filtered, `${project.world.buildHash}:${query}`, 12);
  const tool = project.tools.find((item) => item.id === selection.id);
  if (selection.id !== undefined && tool === undefined)
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <h1>Tool unavailable</h1>
        </header>
        <EmptyState
          title="This tool is not in the current source"
          action={<Button onClick={() => onVisit("/tools")}>Back to tools</Button>}
        >
          It may have been removed or renamed. No other tool has been selected in its place.
        </EmptyState>
      </section>
    );
  if (tool !== undefined)
    return (
      <section className="fd-page fd-page--workspace">
        <header className="fd-page-header fd-tool-detail-header">
          <div>
            <Button variant="link" size="compact" onClick={() => onVisit("/tools")}>
              <ArrowLeft size={14} />
              All tools
            </Button>
            <h1>{titleFromId(tool.id)}</h1>
            <p>
              <code>{tool.id}</code> · v{tool.version}
            </p>
          </div>
          <Button onClick={() => onVisit("/environment")}>
            Live state & activity
            <ArrowRight size={15} />
          </Button>
        </header>
        <div className="fd-local-frame">
          <nav className="fd-local-tabs" aria-label="Tool detail views">
            {(
              [
                ["behavior", "Behavior"],
                ["data", "Starting data"],
                ["test", "Test tool"],
                ["source", "Source"],
              ] as const
            ).map(([tab, label]) => (
              <Button
                key={tab}
                variant="quiet"
                aria-pressed={selection.tab === tab}
                onClick={() => onVisit(toolHref(tool.id, tab))}
              >
                {label}
              </Button>
            ))}
          </nav>
          {selection.tab === "behavior" ? (
            <ToolBehavior tool={tool} />
          ) : selection.tab === "data" ? (
            <ToolStartingData key={tool.id} project={project} tool={tool} />
          ) : selection.tab === "test" ? (
            testTool(tool)
          ) : (
            <ToolImplementation key={tool.id} tool={tool} />
          )}
        </div>
      </section>
    );
  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <h1>Tools</h1>
        <Button onClick={() => onVisit("/connect")}>
          Connect agent
          <ArrowRight size={15} />
        </Button>
      </header>
      {runtimeSummary}
      <div className="fd-local-frame">
        <div className="fd-local-toolbar">
          <SearchField
            placeholder="Find a tool or operation"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="fd-local-count">
            {filtered.length} {filtered.length === 1 ? "tool" : "tools"} in this world
          </span>
          <Button onClick={() => onVisit("/world")}>
            <FileCode size={15} />
            World setup
          </Button>
        </div>
        <ScrollArea label="Tools" resetKey={`${query}:${pagination.page}`}>
          {filtered.length === 0 ? (
            <EmptyState
              title={query === "" ? "No tools selected" : "No matching tools"}
              action={
                query === "" ? (
                  <Button onClick={() => onVisit("/world")}>View world setup</Button>
                ) : (
                  <Button onClick={() => setQuery("")}>Clear search</Button>
                )
              }
            >
              {query === ""
                ? "Select tool packages or define a local tool in your repository, then refresh source. No example is loaded automatically."
                : "Search by tool name, operation, or behavior."}
            </EmptyState>
          ) : (
            <div className="fd-tool-directory">
              {pagination.items.map((item) => (
                <RowButton
                  className="fd-tool-directory__item"
                  key={item.id}
                  onClick={() => onVisit(toolHref(item.id))}
                >
                  <Wrench size={19} aria-hidden="true" />
                  <div>
                    <h2>{titleFromId(item.id)}</h2>
                    <code>{item.id}</code>
                    {item.operations[0]?.description === undefined ? null : (
                      <p>{item.operations[0].description}</p>
                    )}
                    <span className="fd-tool-directory__metadata">
                      {plural(item.operations.length, "operation")} ·{" "}
                      {plural(item.stateNamespaces.length, "state table")} · v{item.version}
                    </span>
                  </div>
                </RowButton>
              ))}
            </div>
          )}
        </ScrollArea>
        <Pagination label="Tools" {...pagination} />
      </div>
      <div className="fd-local-source-note">
        <p>
          Tools and starting data come from your repository. Edit source with your coding agent, then refresh
          it here.
        </p>
        {project.world.source?.readable ? (
          <SourceViewer kind="world" id={project.world.id} label="View world source" />
        ) : null}
      </div>
    </section>
  );
}
