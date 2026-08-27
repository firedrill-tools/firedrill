import { FileCode2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { inspectorApi } from "../api";
import { compactId, titleFromId } from "../format";
import type { SimulationSourceDocument, SimulationSourceKind } from "../types";
import { Button, IconButton, InlineMessage, Spinner } from "./primitives";

function sourceLines(content: string) {
  const occurrences = new Map<string, number>();
  const lines: Array<{ readonly key: string; readonly value: string }> = [];
  for (const value of content.split("\n")) {
    const occurrence = (occurrences.get(value) ?? 0) + 1;
    occurrences.set(value, occurrence);
    lines.push({ key: `${value}\u0000${occurrence}`, value });
  }
  return lines;
}

export function SourceViewer({
  kind,
  id,
  label = "View source",
}: {
  readonly kind: SimulationSourceKind;
  readonly id: string;
  readonly label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestSequence = useRef(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [document, setDocument] = useState<SimulationSourceDocument>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const show = async () => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setOpen(true);
    setLoading(true);
    setDocument(undefined);
    setError(undefined);
    try {
      const source = await inspectorApi.source(kind, id);
      if (requestSequence.current === sequence) setDocument(source);
    } catch (cause) {
      if (requestSequence.current === sequence) {
        setError(cause instanceof Error ? cause.message : "Repository source could not be opened.");
      }
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  };

  const close = () => {
    requestSequence.current += 1;
    setOpen(false);
    setLoading(false);
  };

  return (
    <>
      <Button size="compact" onClick={() => void show()}>
        <FileCode2 size={15} aria-hidden="true" />
        {label}
      </Button>
      <dialog
        ref={dialog}
        className="fd-dialog fd-source-dialog"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          if (open) close();
        }}
      >
        <div className="fd-dialog__head">
          <div>
            <h2>{document?.path ?? "Repository source"}</h2>
            <code>
              {kind} · {id}
            </code>
          </div>
          <IconButton label="Close" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        {loading ? (
          <div className="fd-source-loading">
            <Spinner label="Loading repository source" />
            Loading source…
          </div>
        ) : error !== undefined ? (
          <div className="fd-source-error">
            <InlineMessage tone="danger" title="Source unavailable">
              {error}
            </InlineMessage>
          </div>
        ) : document !== undefined ? (
          <>
            <div className="fd-source-toolbar">
              <span>Current file · {titleFromId(document.language)}</span>
              <code title={`Compiled identity ${document.contentHash}`}>
                {compactId(document.contentHash, 22)}
              </code>
            </div>
            <pre className="fd-source-code">
              {sourceLines(document.content).map((line) => (
                <span className="fd-source-line" key={line.key}>
                  {line.value.length === 0 ? " " : line.value}
                </span>
              ))}
            </pre>
          </>
        ) : null}
      </dialog>
    </>
  );
}
