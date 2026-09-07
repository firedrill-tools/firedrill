import { useMemo, useState } from "react";
import { ActorIdentity } from "../components/actor-identity";
import { DataViewer } from "../components/data-viewer";
import { PageIntro } from "../components/page-intro";
import { PaginatedContent, Pagination, usePagination } from "../components/pagination";
import { EmptyState, RowButton, SearchField, Select } from "../components/primitives";
import { ScrollArea } from "../components/scroll-area";
import { SourceViewer } from "../components/source-viewer";
import type { SimulationProject } from "../types";
import { recordCell, schemaFields, startingRecords } from "./catalog-data";
import "./catalog-world.css";

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
    `${actor.id} ${actor.description ?? ""} ${JSON.stringify(actor.attributes)}`
      .toLowerCase()
      .includes(normalized),
  );
  const resetKey = `${project.world.id}:${page}:${scenario?.id ?? ""}:${selected?.id ?? ""}:${query}`;
  const fieldPagination = usePagination(fields, resetKey);
  const rowPagination = usePagination(currentRows, resetKey);
  const actorPagination = usePagination(actors, resetKey);
  const pagination = page === "schema" ? fieldPagination : page === "data" ? rowPagination : actorPagination;
  const columns = [...new Set(currentRows.flatMap((row) => Object.keys(row.value)))];
  const tablePagination = usePagination(tableMatches, `${project.world.id}:${tableQuery}`);
  const chooseTable = (id: string) => {
    setTableId(id);
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
                }}
              />
            </div>
            <div className="fd-rail-list">
              {tablePagination.items.map((table) => (
                <RowButton
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
                </RowButton>
              ))}
              {tableMatches.length === 0 ? (
                <p className="fd-rail-empty">No declared tables match this search.</p>
              ) : null}
            </div>
            <Pagination label="Tables" {...tablePagination} variant="rail" />
          </aside>
        )}
        <div className="fd-workspace-main">
          <div className="fd-workspace-titlebar">
            <div>
              <h2>{page === "personas" ? "Identities" : (selected?.namespace ?? "No tables")}</h2>
            </div>
            <div className="fd-catalog-world-actions">
              {page === "schema" && selected?.definition !== undefined ? (
                <DataViewer
                  title={`${selected.tool.id} / ${selected.namespace} schema`}
                  value={selected.definition.schema}
                  label="Full schema"
                />
              ) : null}
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
              }}
            />
            {page === "schema" ? null : (
              <Select
                label="Starting situation"
                value={scenario?.id ?? ""}
                onChange={(event) => {
                  setScenarioId(event.target.value);
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
          <ScrollArea
            label={
              page === "schema"
                ? "Schema fields"
                : page === "data"
                  ? "Starting data"
                  : "Actors and permissions"
            }
            resetKey={`${resetKey}:${pagination.page}`}
          >
            {page === "schema" ? (
              selected?.definition === undefined ? (
                <EmptyState title="No schema available">
                  This catalog does not contain a schema for this table. Refresh repository source to load its
                  definition.
                </EmptyState>
              ) : (
                <>
                  <div>
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
                        {fieldPagination.items.map((field) => (
                          <tr key={field.name}>
                            <td>
                              <code>{field.name}</code>
                            </td>
                            <td>
                              <code>{field.type}</code>
                            </td>
                            <td>{field.required ? "Required" : "Optional"}</td>
                            <td>
                              <DataViewer
                                title={`${selected.namespace}.${field.name}`}
                                value={field.definition}
                                label="View definition"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {fields.length === 0 ? (
                    <p className="fd-catalog-note">
                      No top-level fields match. Open the full schema for references and nested structures.
                    </p>
                  ) : null}
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
                <div>
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
                      {rowPagination.items.map((row) => (
                        <tr key={row.rowId}>
                          <td>
                            <DataViewer
                              title={`${row.namespace} / ${row.rowId}`}
                              value={row.value}
                              label={row.rowId}
                            />
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
              )
            ) : null}
            {page === "personas" ? (
              actors.length === 0 ? (
                <EmptyState title="No matching identities">
                  Declare actors and their attributes in your world or scenario source. Customer records
                  belong under Data.
                </EmptyState>
              ) : (
                <div>
                  <table className="fd-table fd-table--catalog">
                    <thead>
                      <tr>
                        <th>Identity</th>
                        <th>Attributes</th>
                        <th>Allowed operations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actorPagination.items.map((actor) => (
                        <tr key={actor.id}>
                          <td>
                            <ActorIdentity actor={actor} />
                          </td>
                          <td>
                            {Object.keys(actor.attributes).length === 0 ? (
                              "No attributes declared"
                            ) : (
                              <DataViewer
                                title={`${actor.id} attributes`}
                                value={actor.attributes}
                                label="View attributes"
                              />
                            )}
                          </td>
                          <td>
                            {actor.grants.length === 0 ? (
                              "No operations permitted"
                            ) : (
                              <PaginatedContent
                                items={actor.grants}
                                label={`Allowed operations for ${actor.id}`}
                                resetKey={`${project.world.id}:${scenario?.id ?? ""}:${actor.id}`}
                              >
                                {(grants) => (
                                  <ul className="fd-plain-list">
                                    {grants.map((grant) => (
                                      <li key={`${grant.packageId}.${grant.operationId}`}>
                                        <code>
                                          {grant.packageId}.{grant.operationId}
                                        </code>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </PaginatedContent>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </ScrollArea>
          <Pagination
            label={page === "schema" ? "Fields" : page === "data" ? "Records" : "Identities"}
            {...pagination}
          />
        </div>
      </div>
    </section>
  );
}
