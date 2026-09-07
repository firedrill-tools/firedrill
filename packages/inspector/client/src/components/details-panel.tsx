import { PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "./primitives";
import "./details-panel.css";

const WIDE_PANEL = "(min-width: 1280px)";

export function DetailsTrigger({
  id,
  open,
  onClick,
  children = "Details",
  disabled = false,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <Button size="compact" aria-expanded={open} aria-controls={id} onClick={onClick} disabled={disabled}>
      <PanelRight size={15} aria-hidden="true" />
      {children}
    </Button>
  );
}

export function DetailsPanel({
  id,
  title,
  open,
  onClose,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_PANEL).matches);
  const aside = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const query = window.matchMedia(WIDE_PANEL);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overlay = dialog.current;
    if (!wide && overlay !== null && !overlay.open) overlay.showModal();
    if (wide) aside.current?.focus();
    return () => {
      if (overlay?.open) overlay.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, wide]);

  if (!open) return null;
  const content = (
    <>
      <div className="fd-details-panel__head">
        <h2 id={`${id}-title`}>{title}</h2>
        <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="fd-details-panel__body">{children}</div>
    </>
  );
  if (wide) {
    return (
      <aside
        ref={aside}
        id={id}
        className="fd-details-panel"
        tabIndex={-1}
        aria-labelledby={`${id}-title`}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !(event.target instanceof Element && event.target.closest("dialog[open]"))
          ) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {content}
      </aside>
    );
  }
  return createPortal(
    <dialog
      ref={dialog}
      id={id}
      className="fd-details-panel fd-details-panel--overlay"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      {content}
    </dialog>,
    document.body,
  );
}
