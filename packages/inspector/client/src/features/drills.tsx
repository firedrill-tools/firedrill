import { ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DataViewer } from "../components/data-viewer";
import { PageIntro } from "../components/page-intro";
import {
  Button,
  CodeBlock,
  EmptyState,
  IconButton,
  InlineMessage,
  Input,
  KeyValue,
  RowButton,
  SearchField,
  Spinner,
} from "../components/primitives";
import { SourceViewer } from "../components/source-viewer";
import { plural, titleFromId, virtualTime } from "../format";
import type { SimulationDrill, SimulationProject, SimulationSuite, StartSimulationRun } from "../types";
import { describeExpectation } from "./drill-expectations";

type Selection =
  | { readonly kind: "drill"; readonly value: SimulationDrill }
  | { readonly kind: "suite"; readonly value: SimulationSuite };

function selectedSuiteDrills(project: SimulationProject, suite: SimulationSuite): readonly SimulationDrill[] {
  if (suite.drills.length === 0 && suite.tags.length === 0) return project.drills;
  const explicit = new Set(suite.drills);
  return project.drills.filter(
    (drill) => explicit.has(drill.id) || drill.tags.some((tag) => suite.tags.includes(tag)),
  );
}

function RunDialog({
  selection,
  open,
  busy,
  onClose,
  onRun,
}: {
  readonly selection: Selection | undefined;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRun: (input: StartSimulationRun) => Promise<string | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [seed, setSeed] = useState("");
  const [trials, setTrials] = useState("");
  const [retries, setRetries] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [error, setError] = useState<string>();
  const [advanced, setAdvanced] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) {
      setSeed("");
      setTrials("");
      setRetries("");
      setConcurrency("");
      setError(undefined);
      setAdvanced(false);
      dialog.current?.showModal();
    }
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  const submit = async () => {
    if (selection === undefined) return;
    const fields = [
      { label: "Repeats", value: trials, minimum: 1, maximum: 10_000 },
      { label: "Retries", value: retries, minimum: 0, maximum: 10 },
      { label: "Parallel runs", value: concurrency, minimum: 1, maximum: 64 },
    ].map((field) => ({ ...field, parsed: field.value === "" ? undefined : Number(field.value) }));
    const invalid = fields.find(
      (field) =>
        field.parsed !== undefined &&
        (!Number.isSafeInteger(field.parsed) || field.parsed < field.minimum || field.parsed > field.maximum),
    );
    if (invalid !== undefined) {
      setError(`${invalid.label} must be an integer from ${invalid.minimum} through ${invalid.maximum}.`);
      return;
    }
    if (seed !== "" && (!/^(0|[1-9]\d{0,19})$/.test(seed) || BigInt(seed) > 18_446_744_073_709_551_615n)) {
      setError("Seed must be a whole number from 0 to 18446744073709551615.");
      return;
    }
    const common = {
      ...(seed === "" ? {} : { seed }),
      ...(fields[0]?.parsed === undefined ? {} : { trials: fields[0].parsed }),
      ...(fields[1]?.parsed === undefined ? {} : { retries: fields[1].parsed }),
      ...(fields[2]?.parsed === undefined ? {} : { concurrency: fields[2].parsed }),
    };
    try {
      setError(
        await onRun(
          selection.kind === "drill"
            ? { drillId: selection.value.id, ...common }
            : { suiteId: selection.value.id, ...common },
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drill could not be started.");
    }
  };
  return (
    <dialog
      ref={dialog}
      className="fd-dialog fd-run-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (open && !busy) onClose();
      }}
    >
      <div className="fd-dialog__head">
        <div>
          <h2 id={`${id}-title`}>Run {selection?.kind ?? "drill"}</h2>
          <span>{selection?.value.title ?? selection?.value.id}</span>
        </div>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X size={17} />
        </IconButton>
      </div>
      <p className="fd-dialog__lead">
        Start the agent with the task and synthetic data defined in your files. Results appear under Runs.
        Your agent’s model usage may incur costs.
      </p>
      <details
        className="fd-run-advanced"
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary>Advanced options</summary>
        <p>
          Leave fields empty to keep your source-defined defaults. Each repeat starts with a fresh synthetic
          world.
        </p>
        <div className="fd-run-fields">
          <label className="fd-field" htmlFor={`${id}-seed`}>
            <span>Seed</span>
            <small>Controls the world’s starting randomness, not the model.</small>
            <Input
              id={`${id}-seed`}
              aria-label="Seed"
              inputMode="numeric"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
            />
          </label>
          <label className="fd-field" htmlFor={`${id}-trials`}>
            <span>Repeats</span>
            <small>How many times to run each drill.</small>
            <Input
              id={`${id}-trials`}
              aria-label="Repeats"
              type="number"
              min="1"
              max="10000"
              value={trials}
              onChange={(event) => setTrials(event.target.value)}
            />
          </label>
          <label className="fd-field" htmlFor={`${id}-retries`}>
            <span>Retries</span>
            <small>Keep every attempt in the results.</small>
            <Input
              id={`${id}-retries`}
              aria-label="Retries"
              type="number"
              min="0"
              max="10"
              value={retries}
              onChange={(event) => setRetries(event.target.value)}
            />
          </label>
          <label className="fd-field" htmlFor={`${id}-concurrency`}>
            <span>Parallel runs</span>
            <small>Maximum repeats running at once.</small>
            <Input
              id={`${id}-concurrency`}
              aria-label="Parallel runs"
              type="number"
              min="1"
              max="64"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            />
          </label>
        </div>
      </details>
      {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
      <div className="fd-dialog__actions">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? <Spinner label="Starting drill" /> : <Play size={16} />}Run
        </Button>
      </div>
    </dialog>
  );
}

function DrillDetails({
  drill,
  project,
}: {
  readonly drill: SimulationDrill;
  readonly project: SimulationProject;
}) {
  const target = project.targets.find((candidate) => candidate.id === drill.targetId);
  const scenario = project.scenarios.find((candidate) => candidate.id === drill.scenarioId);
  const execution = drill.execution;
  return (
    <div className="fd-definition fd-drill-definition">
      <section className="fd-definition__intro fd-drill-context">
        <dl>
          <KeyValue label="Agent">{titleFromId(drill.targetId)}</KeyValue>
          <KeyValue label="Starting scenario">
            {scenario?.title ?? drill.scenarioId ?? "Defined in this drill"}
          </KeyValue>
        </dl>
      </section>
      <section className="fd-definition__section">
        <h3>Task</h3>
        {execution === undefined ? (
          <p>
            Task details are not available in this saved catalog. View the source file to read the
            instructions.
          </p>
        ) : (
          <div className="fd-drill-tasks">
            {execution.interactions.map((interaction) => (
              <article className="fd-drill-task" key={interaction.id}>
                <p className="fd-drill-task__instruction">{interaction.task.instruction}</p>
                <p className="fd-drill-task__timing">
                  As {interaction.actorId} ·{" "}
                  {interaction.afterStartUs === 0
                    ? "At the start"
                    : `After ${virtualTime(interaction.afterStartUs)} of world time`}
                </p>
                {interaction.task.input === undefined ? null : (
                  <DataViewer title="Task input" label="View input" value={interaction.task.input} />
                )}
              </article>
            ))}
            {execution.workloads.map((workload) => (
              <article className="fd-drill-task" key={workload.id}>
                <p className="fd-drill-task__instruction">{workload.task.instruction}</p>
                <p className="fd-drill-task__timing">
                  {workload.occurrences} occurrences per actor · every {virtualTime(workload.everyUs)} ·
                  starting after {virtualTime(workload.startAfterUs)} of world time
                </p>
                <p className="fd-drill-task__timing">Actors: {workload.actorIds.join(", ")}</p>
                {workload.task.input === undefined ? null : (
                  <DataViewer title="Task input" label="View input" value={workload.task.input} />
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="fd-definition__section">
        <div className="fd-section-heading">
          <div>
            <h3>Checks</h3>
            <p>Checks must pass at the end of the run unless noted otherwise.</p>
          </div>
        </div>
        {drill.expectations.length === 0 ? (
          <p>No checks are defined. A completed run alone does not prove the agent behaved correctly.</p>
        ) : (
          <ol className="fd-drill-checks">
            {drill.expectations.map((check) => {
              const description =
                check.definition === undefined ? undefined : describeExpectation(check.definition);
              return (
                <li key={`${check.checkpoint}:${check.id}`}>
                  <div className="fd-drill-check__heading">
                    <strong>{titleFromId(check.id)}</strong>
                    {check.definition === undefined ? null : (
                      <DataViewer
                        title={titleFromId(check.id)}
                        label="View definition"
                        value={{
                          checkpoint: check.checkpoint,
                          gate: check.gate,
                          definition: check.definition,
                          ...(description?.filters.length ? { matchingRules: description.filters } : {}),
                        }}
                      />
                    )}
                  </div>
                  {description === undefined ? (
                    <p>View the source to read this check.</p>
                  ) : (
                    <>
                      <p className="fd-drill-check__subject">{description.subject}</p>
                      <p>{description.expectation}</p>
                      {description.scope.map((scope) => (
                        <p className="fd-drill-check__subject" key={scope}>
                          {scope}
                        </p>
                      ))}
                    </>
                  )}
                  {check.checkpoint === "invariant" || !check.gate ? (
                    <p className="fd-drill-check__subject">
                      {[
                        check.checkpoint === "invariant" ? "Checked throughout the run" : null,
                        !check.gate ? "Informational; does not affect the result" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <section className="fd-definition__section">
        <details className="fd-drill-disclosure">
          <summary>Execution settings</summary>
          <dl className="fd-definition-grid">
            <KeyValue label="Repeats">{drill.trials.count}</KeyValue>
            <KeyValue label="Check category">{drill.trials.classification}</KeyValue>
            <KeyValue label="World time limit">{virtualTime(drill.timeline.horizonUs)}</KeyValue>
            <KeyValue label="Maximum tool calls">{drill.timeline.maxToolCalls}</KeyValue>
            <KeyValue label="Maximum events">{drill.timeline.maxEvents}</KeyValue>
            <KeyValue label="Connection">{target?.bindings.join(", ") ?? "Unavailable"}</KeyValue>
            <KeyValue label="Agent launch method">{target?.kind ?? "Unavailable"}</KeyValue>
            {execution === undefined ? null : (
              <>
                <KeyValue label="Stop on invariant failure">
                  {execution.stopOnInvariantFailure ? "Yes" : "No"}
                </KeyValue>
                <KeyValue label="Stop on agent failure">
                  {execution.stopOnTargetFailure ? "Yes" : "No"}
                </KeyValue>
              </>
            )}
          </dl>
          {target?.source?.readable ? (
            <SourceViewer kind="target" id={target.id} label="View agent connection" />
          ) : null}
        </details>
      </section>
    </div>
  );
}

function SuiteDetails({
  suite,
  drills,
  onSelect,
}: {
  readonly suite: SimulationSuite;
  readonly drills: readonly SimulationDrill[];
  readonly onSelect: (drill: SimulationDrill) => void;
}) {
  return (
    <div className="fd-definition fd-drill-definition">
      <section className="fd-definition__intro">
        <p>A suite runs a group of drills together. Select a drill below to read its task and checks.</p>
      </section>
      <section className="fd-definition__section">
        <h3>{plural(drills.length, "drill")}</h3>
        {drills.length === 0 ? (
          <p>This suite does not match any drills. Update its IDs or tags in your source files.</p>
        ) : (
          <div className="fd-drill-suite-list">
            {drills.map((drill) => (
              <RowButton key={drill.id} onClick={() => onSelect(drill)}>
                <strong>{drill.title ?? titleFromId(drill.id)}</strong>
                <span>{plural(drill.assertions, "check")}</span>
              </RowButton>
            ))}
          </div>
        )}
      </section>
      <section className="fd-definition__section">
        <details className="fd-drill-disclosure">
          <summary>Execution settings</summary>
          <dl>
            {suite.trials === undefined ? null : (
              <KeyValue label="Repeats per drill">{suite.trials}</KeyValue>
            )}
            <KeyValue label="Retries">{suite.retries}</KeyValue>
            <KeyValue label="Parallel runs">{suite.concurrency}</KeyValue>
          </dl>
        </details>
      </section>
    </div>
  );
}

export function DrillsView({
  project,
  starting,
  onStart,
}: {
  readonly project: SimulationProject;
  readonly starting: boolean;
  readonly onStart: (input: StartSimulationRun) => Promise<string | undefined>;
}) {
  const all: readonly Selection[] = useMemo(
    () => [
      ...project.drills.map((value) => ({ kind: "drill" as const, value })),
      ...project.suites.map((value) => ({ kind: "suite" as const, value })),
    ],
    [project.drills, project.suites],
  );
  const [selectedKey, setSelectedKey] = useState<string>();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const selected = all.find((item) => `${item.kind}:${item.value.id}` === selectedKey) ?? all[0];
  const selectedDrills =
    selected?.kind === "drill"
      ? [selected.value]
      : selected?.kind === "suite"
        ? selectedSuiteDrills(project, selected.value)
        : [];
  const missingTargets = selectedDrills.filter(
    (drill) => !project.targets.some((target) => target.id === drill.targetId),
  );
  const unavailableTargets = project.targets.filter(
    (target) =>
      target.runAvailability === "agent_callback_required" &&
      selectedDrills.some((drill) => drill.targetId === target.id),
  );
  const canRun = selectedDrills.length > 0 && missingTargets.length === 0 && unavailableTargets.length === 0;
  const filtered = all.filter((item) =>
    `${item.value.id} ${item.value.title ?? ""} ${item.kind === "drill" ? `${item.value.targetId} ${item.value.scenarioId ?? ""}` : "suite"}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const choose = (key: string) => {
    setSelectedKey(key);
    setHelpOpen(false);
  };
  if (all.length === 0)
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <PageIntro page="drills" />
        </header>
        <EmptyState title="No drills found">
          Add a <code>*.drill.yaml</code> or <code>*.drill.json</code> file with an agent task and checks,
          validate it, then refresh.
        </EmptyState>
      </section>
    );
  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page="drills" />
      </header>
      <div className="fd-workspace fd-drill-workspace fd-drill-workspace--focused">
        <aside className="fd-workspace-rail">
          <div className="fd-rail-head">
            <strong>{project.suites.length > 0 ? "Drills & suites" : "Drills"}</strong>
            <span>{all.length}</span>
          </div>
          <div className="fd-rail-search">
            <SearchField
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Find a drill or agent"
            />
          </div>
          <div className="fd-rail-list">
            {filtered.slice(pageIndex * 25, (pageIndex + 1) * 25).map((item) => {
              const key = `${item.kind}:${item.value.id}`;
              return (
                <RowButton
                  type="button"
                  className="fd-rail-item"
                  key={key}
                  aria-current={
                    selected?.kind === item.kind && selected.value.id === item.value.id ? "true" : undefined
                  }
                  onClick={() => choose(key)}
                >
                  <span>
                    <strong>{item.value.title ?? titleFromId(item.value.id)}</strong>
                    {item.kind === "suite" ? <small>Suite</small> : null}
                  </span>
                </RowButton>
              );
            })}
            {filtered.length === 0 ? <p className="fd-rail-empty">No drills match “{query}”.</p> : null}
          </div>
          {filtered.length > 25 ? (
            <div className="fd-catalog-pagination">
              <span>
                {pageIndex * 25 + 1}–{Math.min((pageIndex + 1) * 25, filtered.length)} of {filtered.length}
              </span>
              <div>
                <IconButton
                  label="Previous drills"
                  disabled={pageIndex === 0}
                  onClick={() => setPage(pageIndex - 1)}
                >
                  <ChevronLeft size={16} />
                </IconButton>
                <IconButton
                  label="Next drills"
                  disabled={(pageIndex + 1) * 25 >= filtered.length}
                  onClick={() => setPage(pageIndex + 1)}
                >
                  <ChevronRight size={16} />
                </IconButton>
              </div>
            </div>
          ) : null}
        </aside>
        <div className="fd-workspace-main">
          <div className="fd-workspace-titlebar fd-drill-titlebar">
            <h2>{selected?.value.title ?? titleFromId(selected?.value.id ?? "")}</h2>
            <div className="fd-drill-actions">
              {selected?.value.source?.readable ? (
                <SourceViewer kind={selected.kind} id={selected.value.id} />
              ) : null}
              {canRun ? (
                <Button variant="primary" onClick={() => setDialogOpen(true)} disabled={starting}>
                  <Play size={16} />
                  Run {selected?.kind}
                </Button>
              ) : (
                <Button
                  onClick={() => setHelpOpen(!helpOpen)}
                  aria-expanded={helpOpen}
                  aria-controls={helpId}
                >
                  How to run
                </Button>
              )}
            </div>
          </div>
          <div className="fd-definition-scroll fd-drill-body">
            {!canRun ? (
              <div className="fd-drill-connection">
                <p>
                  {selectedDrills.length === 0
                    ? "This suite has no drills to run."
                    : missingTargets.length > 0
                      ? "An agent connection is missing from this project."
                      : "This agent runs from your test script, which is not connected to this inspector."}
                </p>
                {helpOpen ? (
                  <div id={helpId} className="fd-drill-connection__help">
                    {unavailableTargets.length > 0 ? (
                      <>
                        <p>
                          Run the drill from your existing test script to generate a report. To also start it
                          here, launch the inspector from that script and pass the same <code>agent</code>{" "}
                          callback you use with <code>runDrills</code>:
                        </p>
                        <CodeBlock>{"await startLocalInspector({ root: process.cwd(), agent });"}</CodeBlock>
                        <p>
                          <code>startLocalInspector</code> is exported by <code>@firedrill/inspector</code>.
                          The <code>agent</code> variable above is your existing callback, not a built-in
                          agent. A plain <code>firedrill inspect</code> command cannot load that in-memory
                          function.
                        </p>
                        {unavailableTargets.map((target) =>
                          target.source?.readable ? (
                            <SourceViewer
                              key={target.id}
                              kind="target"
                              id={target.id}
                              label={`View connection: ${target.id}`}
                            />
                          ) : null,
                        )}
                      </>
                    ) : (
                      <p>
                        Update the drill or suite in your repository so it selects a declared agent and at
                        least one drill, then refresh the inspector.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            {selected?.kind === "drill" ? <DrillDetails drill={selected.value} project={project} /> : null}
            {selected?.kind === "suite" ? (
              <SuiteDetails
                suite={selected.value}
                drills={selectedDrills}
                onSelect={(drill) => choose(`drill:${drill.id}`)}
              />
            ) : null}
          </div>
        </div>
      </div>
      <RunDialog
        selection={selected}
        open={dialogOpen}
        busy={starting}
        onClose={() => setDialogOpen(false)}
        onRun={onStart}
      />
    </section>
  );
}
