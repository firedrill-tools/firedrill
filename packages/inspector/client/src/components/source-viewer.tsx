import { FileCode2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { inspectorApi } from "../api";
import type { SimulationSourceDocument, SimulationSourceKind } from "../types";
import { CodeDocument } from "./code-document";
import { Button, IconButton, InlineMessage, Spinner } from "./primitives";

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
  const headingId = useId();
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
        aria-labelledby={headingId}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onClose={(event) => {
          event.stopPropagation();
          if (open) close();
        }}
      >
        <div className="fd-dialog__head">
          <div>
            <h2 id={headingId}>{document?.path ?? "Repository source"}</h2>
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
          <CodeDocument
            key={document.contentHash}
            content={document.content}
            language={document.language}
            context="Current repository file"
          />
        ) : null}
      </dialog>
    </>
  );
}
