import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { PageIntro } from "../components/page-intro";
import { CodeBlock, EmptyState, IconButton, SearchField, Select } from "../components/primitives";
import { SourceViewer } from "../components/source-viewer";
import { json } from "../format";
import type { SimulationProject } from "../types";
import { recordCell, schemaFields, startingRecords } from "./catalog-data";

function PageControls({
  page,
  total,
  onPage,
}: {
  readonly page: number;
  readonly total: number;
  readonly onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="fd-catalog-pagination">
      <span>
        {total === 0 ? "0 results" : `${page * 25 + 1}–${Math.min((page + 1) * 25, total)} of ${total}`}
      </span>
      <div>
        <IconButton label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}

export function CatalogView({
  project,
  page,
}: {
  readonly project: SimulationProject;
  readonly page: "schema" | "data" | "personas";
}) {
  const [scenarioId, setScenarioId] = useState("");
  const [tableId, setTableId] = useState("");
  const [query, setQuery] = useState("");
  const [tableQuery, setTableQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [tablePage, setTablePage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<string>();
  const scenario = project.scenarios.find((item) => item.id === scenarioId);
  const setup = scenario ?? project.world.baseline;
  const rows = useMemo(() => startingRecords(setup), [setup]);
  const tables = project.tools.flatMap((tool) =>
    tool.stateNamespaces.map((namespace) => ({
      id: JSON.stringify([tool.id, namespace]),
      tool,
      namespace,
      definition: tool.stateDefinitions?.find((state) => state.namespace === namespace),
    })),
  );
  const tableMatches = tables.filter((table) =>
    `${table.tool.id} ${table.namespace}`.toLowerCase().includes(tableQuery.trim().toLowerCase()),
  );
  const selected = tableMatches.find((table) => table.id === tableId) ?? tableMatches[0];
  const normalized = query.trim().toLowerCase();
  const currentRows = rows.filter(
    (row) =>
      row.packageId === selected?.tool.id &&
      row.namespace === selected.namespace &&
      `${row.rowId} ${JSON.stringify(row.value)}`.toLowerCase().includes(normalized),
  );
  const fields = schemaFields(selected?.definition?.schema ?? {}).filter((field) =>
    `${field.name} ${field.type}`.toLowerCase().includes(normalized),
  );
  const actors = setup.actors.filter((actor) =>
    `${actor.id} ${JSON.stringify(actor.attributes)}`.toLowerCase().includes(normalized),
  );
  const count = page === "schema" ? fields.length : page === "data" ? currentRows.length : actors.length;
  const index = Math.min(pageIndex, Math.max(0, Math.ceil(count / 25) - 1));
  const columns = [...new Set(currentRows.flatMap((row) => Object.keys(row.value)))];
  const selectedRecord = currentRows.find((row) => row.rowId === selectedRow);
  const currentTablePage = Math.min(tablePage, Math.max(0, Math.ceil(tableMatches.length / 25) - 1));
  const chooseTable = (id: string) => {
    setTableId(id);
    setPageIndex(0);
    setSelectedRow(undefined);
    setQuery("");
  };
  const source = scenario?.source ?? project.world.source;

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page={page} />
      </header>
      <div
        className={`fd-workspace fd-catalog-workspace${page === "personas" ? " fd-catalog-workspace--single" : ""}`}
      >
        {page === "personas" ? null : (
          <aside className="fd-workspace-rail">
            <div className="fd-rail-head">
              <strong>Tables</strong>
            </div>
            <div className="fd-rail-search">
              <SearchField
                placeholder="Find a table or tool"
                value={tableQuery}
                onChange={(event) => {
                  setTableQuery(event.target.value);
                  setTablePage(0);
                }}
              />
            </div>
            <div className="fd-rail-list">
              {tableMatches.slice(currentTablePage * 25, (currentTablePage + 1) * 25).map((table) => (
                <button
                  type="button"
                  key={table.id}
                  className="fd-rail-item"
                  aria-current={selected?.id === table.id ? "true" : undefined}
                  onClick={() => chooseTable(table.id)}
                >
                  <span>
                    <strong>{table.namespace}</strong>
                    <small>{table.tool.id}</small>
                  </span>
                </button>
              ))}
              {tableMatches.length === 0 ? (
                <p className="fd-rail-empty">No declared tables match this search.</p>
              ) : null}
            </div>
            <PageControls page={currentTablePage} total={tableMatches.length} onPage={setTablePage} />
          </aside>
        )}
        <div className="fd-workspace-main">
          <div className="fd-workspace-titlebar">
            <div>
              <h2>{page === "personas" ? "Identities" : (selected?.namespace ?? "No tables")}</h2>
              <p>
                {page === "schema"
                  ? `${selected?.tool.id ?? ""} · declared schema`
                  : `${scenario?.title ?? scenario?.id ?? "World baseline"} · starting ${page === "data" ? "records" : "identities"}`}
              </p>
            </div>
            {page === "schema" ? (
              selected?.tool.source?.readable ? (
                <SourceViewer kind="tool" id={selected.tool.id} />
              ) : null
            ) : source?.readable ? (
              <SourceViewer
                kind={scenario === undefined ? "world" : "scenario"}
                id={scenario?.id ?? project.world.id}
              />
            ) : null}
          </div>
          <div className="fd-catalog-toolbar">
            <SearchField
              placeholder={
                page === "schema"
                  ? "Search fields"
                  : page === "data"
                    ? "Search record values"
                    : "Search identities"
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPageIndex(0);
              }}
            />
            {page === "schema" ? null : (
              <Select
                label="Starting situation"
                value={scenario?.id ?? ""}
                onChange={(event) => {
                  setScenarioId(event.target.value);
                  setPageIndex(0);
                  setSelectedRow(undefined);
                }}
              >
                <option value="">World baseline</option>
                {project.scenarios.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title ?? item.id}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div className="fd-catalog-content">
            {page === "schema" ? (
              selected?.definition === undefined ? (
                <EmptyState title="No schema available">
                  This catalog does not contain a schema for this table. Refresh repository source to load its
                  definition.
                </EmptyState>
              ) : (
                <>
                  <div className="fd-table-scroll">
                    <table className="fd-table fd-table--catalog">
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>Type</th>
                          <th>Required</th>
                          <th>Definition</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.slice(index * 25, (index + 1) * 25).map((field) => (
                          <tr key={field.name}>
                            <td>
                              <code>{field.name}</code>
                            </td>
                            <td>
                              <code>{field.type}</code>
                            </td>
                            <td>{field.required ? "Required" : "Optional"}</td>
                            <td>
                              <details>
                                <summary>View constraints</summary>
                                <CodeBlock>{json(field.definition)}</CodeBlock>
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {fields.length === 0 ? (
                    <p className="fd-catalog-note">
                      No top-level fields match. References, unions, and nested structures remain available in
                      the full schema.
                    </p>
                  ) : null}
                  <details className="fd-catalog-disclosure">
                    <summary>Full declared schema</summary>
                    <CodeBlock>{json(selected.definition.schema)}</CodeBlock>
                  </details>
                </>
              )
            ) : null}
            {page === "data" ? (
              currentRows.length === 0 ? (
                <EmptyState title={normalized === "" ? "No starting records" : "No matching records"}>
                  {normalized === ""
                    ? "This table starts empty in the selected situation. Tools may create records during a run."
                    : "No records match your search."}
                </EmptyState>
              ) : (
                <>
                  <div className="fd-table-scroll">
                    <table className="fd-table fd-table--catalog">
                      <thead>
                        <tr>
                          <th>Record</th>
                          {columns.map((column) => (
                            <th key={column}>{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {currentRows.slice(index * 25, (index + 1) * 25).map((row) => (
                          <tr key={row.rowId} aria-selected={selectedRow === row.rowId}>
                            <td>
                              <button
                                type="button"
                                className="fd-record-link"
                                onClick={() =>
                                  setSelectedRow(selectedRow === row.rowId ? undefined : row.rowId)
                                }
                              >
                                {row.rowId}
                              </button>
                            </td>
                            {columns.map((column) => (
                              <td key={column}>
                                <span className="fd-record-cell" title={recordCell(row.value[column])}>
                                  {recordCell(row.value[column])}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {selectedRecord === undefined ? (
                    <p className="fd-catalog-note">
                      Select a record to inspect all fields, including nested objects and lists.
                    </p>
                  ) : (
                    <section className="fd-catalog-record">
                      <h3>{selectedRecord.rowId}</h3>
                      <CodeBlock>{json(selectedRecord.value)}</CodeBlock>
                    </section>
                  )}
                </>
              )
            ) : null}
            {page === "personas" ? (
              actors.length === 0 ? (
                <EmptyState title="No matching identities">
                  Declare actors and their attributes in your world or scenario source. Customer records
                  belong under Data.
                </EmptyState>
              ) : (
                <div className="fd-table-scroll">
                  <table className="fd-table fd-table--catalog">
                    <thead>
                      <tr>
                        <th>Identity</th>
                        <th>Attributes</th>
                        <th>Allowed operations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actors.slice(index * 25, (index + 1) * 25).map((actor) => (
                        <tr key={actor.id}>
                          <td>
                            <code>{actor.id}</code>
                          </td>
                          <td>
                            {Object.keys(actor.attributes).length === 0 ? (
                              "No attributes declared"
                            ) : (
                              <CodeBlock>{json(actor.attributes)}</CodeBlock>
                            )}
                          </td>
                          <td>
                            {actor.grants.length === 0 ? (
                              "No operations permitted"
                            ) : (
                              <ul className="fd-plain-list">
                                {actor.grants.map((grant) => (
                                  <li key={`${grant.packageId}.${grant.operationId}`}>
                                    <code>
                                      {grant.packageId}.{grant.operationId}
                                    </code>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </div>
          <PageControls page={index} total={count} onPage={setPageIndex} />
        </div>
      </div>
    </section>
  );
}
