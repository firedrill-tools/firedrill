import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { CodeDocument } from "./code-document";
import { Button, IconButton } from "./primitives";

/** Structured data opens above any narrow inspector column, never inside it. */
export function DataViewer({
  title,
  value,
  label = "View JSON",
}: {
  readonly title: string;
  readonly value: unknown;
  readonly label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  const content = open ? JSON.stringify(value, null, 2) : undefined;
  return (
    <>
      <Button
        variant="quiet"
        size="compact"
        aria-haspopup="dialog"
        aria-label={`${label}: ${title}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <dialog
        ref={dialog}
        className="fd-dialog fd-document-dialog"
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        onClose={(event) => {
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <div className="fd-dialog__head">
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
          </div>
          <IconButton label="Close data viewer" onClick={() => setOpen(false)}>
            <X size={17} />
          </IconButton>
        </div>
        {open ? (
          <CodeDocument
            key={content}
            content={content ?? "No value was captured."}
            language={content === undefined ? "text" : "json"}
          />
        ) : null}
      </dialog>
    </>
  );
}
