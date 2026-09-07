import {
  Braces,
  Clock3,
  FileCode2,
  Play,
  RotateCcw,
  ShieldCheck,
  Target,
  TestTubeDiagonal,
  Users,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PageIntro } from "../components/page-intro";
import { plural, titleFromId, virtualTime } from "../format";
import type { SimulationDrill, SimulationProject, SimulationSuite, StartSimulationRun } from "../types";
import {
  Button,
  EmptyState,
  IconButton,
  InlineMessage,
  Input,
  KeyValue,
  SearchField,
  Spinner,
  Status,
} from "../components/primitives";
import { SourceViewer } from "../components/source-viewer";

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

function targetUnavailable(project: SimulationProject, drills: readonly SimulationDrill[]): boolean {
  return drills.some((drill) => {
    const target = project.targets.find((candidate) => candidate.id === drill.targetId);
    return target?.runAvailability === "agent_callback_required";
  });
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
  readonly onRun: (input: StartSimulationRun) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [seed, setSeed] = useState("");
  const [trials, setTrials] = useState("");
  const [retries, setRetries] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [error, setError] = useState<string>();
  const seedId = useId();
  const trialsId = useId();
  const retriesId = useId();
  const concurrencyId = useId();

  useEffect(() => {
    if (open && !dialog.current?.open) {
      setSeed("");
      setTrials("");
      setRetries("");
      setConcurrency("");
      setError(undefined);
      dialog.current?.showModal();
    }
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const submit = () => {
    if (selection === undefined) return;
    const parsed = [
      { label: "Trials", value: trials, minimum: 1, maximum: 10_000 },
      { label: "Retries", value: retries, minimum: 0, maximum: 10 },
      { label: "Concurrency", value: concurrency, minimum: 1, maximum: 64 },
    ].map((field) => ({ ...field, parsed: field.value === "" ? undefined : Number(field.value) }));
    const invalid = parsed.find(
      (field) =>
        field.parsed !== undefined &&
        (!Number.isSafeInteger(field.parsed) || field.parsed < field.minimum || field.parsed > field.maximum),
    );
    if (invalid !== undefined) {
      setError(`${invalid.label} must be an integer from ${invalid.minimum} through ${invalid.maximum}.`);
      return;
    }
    if (seed !== "" && !/^(0|[1-9]\d{0,19})$/.test(seed)) {
      setError("Seed must be an unsigned 64-bit integer.");
      return;
    }
    const common = {
      ...(seed === "" ? {} : { seed }),
      ...(parsed[0]?.parsed === undefined ? {} : { trials: parsed[0].parsed }),
      ...(parsed[1]?.parsed === undefined ? {} : { retries: parsed[1].parsed }),
      ...(parsed[2]?.parsed === undefined ? {} : { concurrency: parsed[2].parsed }),
    };
    onRun(
      selection.kind === "drill"
        ? { drillId: selection.value.id, ...common }
        : { suiteId: selection.value.id, ...common },
    );
  };

  return (
    <dialog
      ref={dialog}
      className="fd-dialog fd-run-dialog"
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
          <h2>Run {selection?.kind ?? "drill"}</h2>
          <code>{selection?.value.id}</code>
        </div>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X size={17} />
        </IconButton>
      </div>
      <p className="fd-dialog__lead">
        Firedrill creates an isolated world for every trial and keeps the source-defined defaults when a field
        is empty.
      </p>
      <div className="fd-run-fields">
        <label className="fd-field" htmlFor={seedId}>
          <span>Seed</span>
          <small>Leave empty to use the world seed.</small>
          <Input
            id={seedId}
            inputMode="numeric"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>
        <label className="fd-field" htmlFor={trialsId}>
          <span>Trials</span>
          <small>Override the declared trial count.</small>
          <Input
            id={trialsId}
            type="number"
            min="1"
            max="10000"
            value={trials}
            onChange={(event) => setTrials(event.target.value)}
          />
        </label>
        <label className="fd-field" htmlFor={retriesId}>
          <span>Retries</span>
          <small>Retain each attempt for evidence.</small>
          <Input
            id={retriesId}
            type="number"
            min="0"
            max="10"
            value={retries}
            onChange={(event) => setRetries(event.target.value)}
          />
        </label>
        <label className="fd-field" htmlFor={concurrencyId}>
          <span>Concurrency</span>
          <small>Maximum local trials at once.</small>
          <Input
            id={concurrencyId}
            type="number"
            min="1"
            max="64"
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </label>
      </div>
      {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
      <div className="fd-dialog__actions">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner label="Starting drill" /> : <Play size={16} />}
          Run
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
  return (
    <div className="fd-definition">
      <section className="fd-definition__intro">
        <h2>{drill.title ?? titleFromId(drill.id)}</h2>
        <p>
          Run the customer-owned target against an isolated copy of{" "}
          <code>{project.world.title ?? project.world.id}</code>, then verify the consequences below.
        </p>
      </section>
      <div className="fd-fact-row">
        <div>
          <Target size={15} />
          <span>Target</span>
          <strong>{drill.targetId}</strong>
        </div>
        <div>
          <Users size={15} />
          <span>Scenario</span>
          <strong>{drill.scenarioId ?? "Inline scenario"}</strong>
        </div>
        <div>
          <Clock3 size={15} />
          <span>Horizon</span>
          <strong>{virtualTime(drill.timeline.horizonUs)}</strong>
        </div>
        <div>
          <RotateCcw size={15} />
          <span>Trials</span>
          <strong>{drill.trials.count}</strong>
        </div>
      </div>
      <section className="fd-definition__section">
        <div className="fd-section-heading">
          <div>
            <h3>Expected consequences</h3>
            <p>Assertions evaluate world state and causal evidence, not the target's self-report.</p>
          </div>
          <Status tone={drill.trials.classification === "safety" ? "warning" : "neutral"}>
            {titleFromId(drill.trials.classification)}
          </Status>
        </div>
        <div className="fd-expectation-list">
          {drill.expectations.map((expectation) => (
            <div className="fd-expectation" key={expectation.id}>
              <ShieldCheck size={16} aria-hidden="true" />
              <div>
                <strong>{titleFromId(expectation.id)}</strong>
                <span>
                  <code>{expectation.kind}</code> · {expectation.checkpoint}
                  {expectation.gate ? " · gating" : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="fd-definition__section">
        <div className="fd-section-heading">
          <div>
            <h3>Execution limits</h3>
          </div>
          {target?.source?.readable ? (
            <SourceViewer kind="target" id={target.id} label="View target source" />
          ) : null}
        </div>
        <dl className="fd-definition-grid">
          <KeyValue label="Interactions">{drill.timeline.interactions}</KeyValue>
          <KeyValue label="Workloads">{drill.timeline.workloads}</KeyValue>
          <KeyValue label="Tool calls">{drill.timeline.maxToolCalls}</KeyValue>
          <KeyValue label="Events">{drill.timeline.maxEvents}</KeyValue>
          <KeyValue label="Bindings">{target?.bindings.join(", ") ?? "Unavailable"}</KeyValue>
          <KeyValue label="Target kind">{target?.kind ?? "Unavailable"}</KeyValue>
        </dl>
      </section>
    </div>
  );
}

function SuiteDetails({
  suite,
  drills,
}: {
  readonly suite: SimulationSuite;
  readonly drills: readonly SimulationDrill[];
}) {
  return (
    <div className="fd-definition">
      <section className="fd-definition__intro">
        <h2>{suite.title ?? titleFromId(suite.id)}</h2>
        <p>
          A repository-owned selection that runs the same drill definitions without creating another runtime.
        </p>
      </section>
      <div className="fd-fact-row fd-fact-row--three">
        <div>
          <TestTubeDiagonal size={15} />
          <span>Selected</span>
          <strong>{plural(drills.length, "drill")}</strong>
        </div>
        <div>
          <RotateCcw size={15} />
          <span>Retries</span>
          <strong>{suite.retries}</strong>
        </div>
        <div>
          <Braces size={15} />
          <span>Concurrency</span>
          <strong>{suite.concurrency}</strong>
        </div>
      </div>
      <section className="fd-definition__section">
        <h3>Drills in this suite</h3>
        <div className="fd-suite-list">
          {drills.map((drill) => (
            <div key={drill.id}>
              <FileCode2 size={16} />
              <span>
                <strong>{drill.title ?? titleFromId(drill.id)}</strong>
                <code>{drill.id}</code>
              </span>
              <em>{titleFromId(drill.trials.classification)}</em>
            </div>
          ))}
        </div>
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
  readonly onStart: (input: StartSimulationRun) => void;
}) {
  const all: readonly Selection[] = useMemo(
    () => [
      ...project.drills.map((value) => ({ kind: "drill" as const, value })),
      ...project.suites.map((value) => ({ kind: "suite" as const, value })),
    ],
    [project.drills, project.suites],
  );
  const [selectedKey, setSelectedKey] = useState(
    all[0] === undefined ? undefined : `${all[0].kind}:${all[0].value.id}`,
  );
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const selected = all.find((item) => `${item.kind}:${item.value.id}` === selectedKey) ?? all[0];
  const selectedDrills =
    selected?.kind === "drill"
      ? [selected.value]
      : selected?.kind === "suite"
        ? selectedSuiteDrills(project, selected.value)
        : [];
  const unavailable = targetUnavailable(project, selectedDrills);
  const filtered = all.filter((item) => {
    const value = `${item.value.id} ${item.value.title ?? ""}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });

  if (all.length === 0) {
    return (
      <section className="fd-page">
        <header className="fd-page-header">
          <PageIntro page="drills" />
        </header>
        <EmptyState title="No drills found">
          Add a <code>*.drill.yaml</code> or <code>*.drill.json</code> file, validate it, then refresh.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="fd-page fd-page--workspace">
      <header className="fd-page-header">
        <PageIntro page="drills" />
        <Button
          variant="primary"
          onClick={() => setDialogOpen(true)}
          disabled={selected === undefined || unavailable}
        >
          <Play size={16} />
          Run {selected?.kind ?? "drill"}
        </Button>
      </header>
      {unavailable ? (
        <InlineMessage tone="info" title="This target is owned by the caller">
          Start the inspector from the process that supplies the external agent callback. Firedrill does not
          host or replace that agent.
        </InlineMessage>
      ) : null}
      <div className="fd-workspace fd-drill-workspace">
        <aside className="fd-workspace-rail">
          <div className="fd-rail-head">
            <strong>Definitions</strong>
            <span>{all.length}</span>
          </div>
          <div className="fd-rail-search">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a drill"
            />
          </div>
          <div className="fd-rail-list">
            {filtered.map((item) => {
              const key = `${item.kind}:${item.value.id}`;
              return (
                <button
                  type="button"
                  className="fd-rail-item"
                  key={key}
                  aria-current={selectedKey === key ? "true" : undefined}
                  onClick={() => setSelectedKey(key)}
                >
                  {item.kind === "drill" ? <TestTubeDiagonal size={16} /> : <Braces size={16} />}
                  <span>
                    <strong>{item.value.title ?? titleFromId(item.value.id)}</strong>
                    <small>{item.kind}</small>
                  </span>
                </button>
              );
            })}
          </div>
          {filtered.length === 0 ? (
            <div className="fd-rail-empty">No definitions match “{query}”.</div>
          ) : null}
        </aside>
        <div className="fd-workspace-main fd-definition-scroll">
          {selected?.kind === "drill" ? <DrillDetails drill={selected.value} project={project} /> : null}
          {selected?.kind === "suite" ? (
            <SuiteDetails suite={selected.value} drills={selectedSuiteDrills(project, selected.value)} />
          ) : null}
        </div>
        {selected === undefined ? null : (
          <aside className="fd-selection-inspector">
            <div className="fd-inspector-head">
              <div>
                <strong>Repository source</strong>
                <code>{selected.value.source?.path ?? "Compiled definition"}</code>
              </div>
            </div>
            <div className="fd-inspector-scroll">
              <section className="fd-inspector-section">
                <h3>Run behavior</h3>
                <dl>
                  <KeyValue label="Selection">{selected.kind}</KeyValue>
                  <KeyValue label="Drills">{selectedDrills.length}</KeyValue>
                  <KeyValue label="Availability">
                    <Status tone={unavailable ? "warning" : "success"}>
                      {unavailable ? "Callback required" : "Ready locally"}
                    </Status>
                  </KeyValue>
                </dl>
              </section>
              {selected.value.source === undefined ? null : (
                <section className="fd-inspector-section">
                  <h3>Source identity</h3>
                  <p className="fd-muted-copy">
                    Durable changes belong in <code>{selected.value.source.path}</code>. Refresh after editing
                    the repository.
                  </p>
                  <p className="fd-hash">{selected.value.source.contentHash}</p>
                  {selected.value.source.readable ? (
                    <div className="fd-inspector-actions">
                      <SourceViewer kind={selected.kind} id={selected.value.id} />
                    </div>
                  ) : null}
                </section>
              )}
            </div>
          </aside>
        )}
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
