import { useId, useRef, useState } from "react";
import { inspectorApi } from "../api";
import { CodeDocument } from "../components/code-document";
import { Button, InlineMessage, Input, Spinner } from "../components/primitives";
import type {
  EnvironmentScenarioPreview,
  EnvironmentScenarioSaved,
  RunningEnvironment,
} from "../environment-types";

/** Explicit, previewed repository write. A data scenario is not a runtime checkpoint. */
export function SaveScenario({
  runtime,
  onClose,
  onSaved,
}: {
  readonly runtime: RunningEnvironment;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}) {
  const fieldId = useId();
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<EnvironmentScenarioPreview>();
  const [saved, setSaved] = useState<EnvironmentScenarioSaved>();
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const inputs = {
    worldInstanceId: runtime.metadata.worldInstanceId,
    id: id.trim(),
    ...(title.trim() === "" ? {} : { title: title.trim() }),
  };
  const changed = () => {
    setPreview(undefined);
    setError(undefined);
    setIncludeSensitive(false);
  };
  const act = async (saving: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (saving && preview !== undefined) {
        const result = await inspectorApi.saveEnvironmentScenario({
          ...inputs,
          sourceHash: preview.sourceHash,
          includeSensitiveValues: includeSensitive,
        });
        setSaved(result);
        await onSaved();
      } else {
        setPreview(await inspectorApi.previewEnvironmentScenario(inputs));
        setIncludeSensitive(false);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Scenario could not be saved. Preview it again and retry.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="fd-scenario-capture" aria-labelledby={`${fieldId}-heading`}>
      <div className="fd-scenario-capture__heading">
        <h2 id={`${fieldId}-heading`}>Save tool data as a scenario</h2>
        <Button onClick={onClose} disabled={busy}>
          {saved === undefined ? "Cancel" : "Done"}
        </Button>
      </div>
      {saved !== undefined ? (
        <>
          <InlineMessage tone="success">
            Saved <code>{saved.path}</code>. Your running environment is unchanged.
          </InlineMessage>
          <CodeDocument
            content={`firedrill serve --scenario ${saved.id}`}
            language="bash"
            context="Start a new environment from this data"
          />
        </>
      ) : (
        <>
          <p>
            A scenario is reusable starting data. This captures records from every tool, including deleted
            baseline records. Clock, permissions, faults and scheduled work use the repository baseline—not
            the current session. Review the file before committing it.
          </p>
          <div className="fd-local-form-row">
            <label className="fd-local-field" htmlFor={`${fieldId}-id`}>
              Scenario ID
              <Input
                id={`${fieldId}-id`}
                placeholder="after-first-action"
                value={id}
                disabled={busy}
                onChange={(event) => {
                  setId(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="fd-local-field" htmlFor={`${fieldId}-title`}>
              Title (optional)
              <Input
                id={`${fieldId}-title`}
                value={title}
                disabled={busy}
                onChange={(event) => {
                  setTitle(event.target.value);
                  changed();
                }}
              />
            </label>
          </div>
          {preview === undefined ? null : (
            <>
              <p>
                {preview.recordCount} records and {preview.deletionCount} deletions. Creates a new{" "}
                <code>scenarios/{id.trim()}.scenario.json</code> file under your configured source folder.
              </p>
              <CodeDocument
                content={JSON.stringify(preview.scenario, null, 2)}
                language="json"
                context="Scenario file preview"
              />
              {preview.containsSensitiveValues ? (
                <label className="fd-scenario-capture__consent">
                  <input
                    type="checkbox"
                    checked={includeSensitive}
                    onChange={(event) => setIncludeSensitive(event.target.checked)}
                    disabled={busy}
                  />
                  Include original sensitive values in the local file. They are hidden in this preview;
                  inspect the saved file before sharing.
                </label>
              ) : null}
            </>
          )}
          {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
          <div className="fd-local-connection-actions">
            <Button onClick={() => void act(false)} disabled={busy || inputs.id === ""}>
              {busy ? <Spinner label="Preparing scenario" /> : null}
              {preview === undefined ? "Preview scenario" : "Refresh preview"}
            </Button>
            {preview === undefined ? null : (
              <Button
                variant="primary"
                onClick={() => void act(true)}
                disabled={busy || (preview.containsSensitiveValues && !includeSensitive)}
              >
                Save new scenario
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
