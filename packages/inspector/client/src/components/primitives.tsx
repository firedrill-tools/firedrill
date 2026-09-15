import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef } from "react";

export function Button({
  variant = "secondary",
  size = "default",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "quiet" | "link" | "danger";
  readonly size?: "default" | "compact";
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={`fd-button fd-button--${variant} fd-button--${size} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}

/** A selectable list row. The trailing cue distinguishes it from a static record. */
export function RowButton({ className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={props.type ?? "button"} className={`fd-row-button ${className}`.trim()} {...props}>
      {children}
      <ChevronRight className="fd-row-button__chevron" size={15} aria-hidden="true" />
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={`fd-icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function SearchField({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`fd-search ${className}`.trim()}>
      <Search aria-hidden="true" size={16} />
      <span className="sr-only">Search</span>
      <input type="search" {...props} />
    </label>
  );
}

export function Select({
  label,
  children,
  className = "",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={`fd-select ${className}`.trim()}>
      <span className="sr-only">{label}</span>
      <select aria-label={label} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" size={15} />
    </label>
  );
}

export function Status({
  tone = "neutral",
  children,
}: {
  readonly tone?: "success" | "warning" | "danger" | "info" | "neutral";
  readonly children: ReactNode;
}) {
  return (
    <span className="fd-status" data-tone={tone}>
      {children}
    </span>
  );
}

export function InlineMessage({
  tone,
  title,
  children,
}: {
  readonly tone: "success" | "warning" | "danger" | "info";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const Icon =
    tone === "success" ? Check : tone === "warning" ? AlertTriangle : tone === "danger" ? CircleAlert : Info;
  return (
    <div className="fd-inline-message" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" size={16} />
      <div>
        {title === undefined ? null : <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="fd-empty">
      <div className="fd-empty__mark" aria-hidden="true" />
      <strong>{title}</strong>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function PageLoader({ label = "Loading Firedrill" }: { readonly label?: string }) {
  return (
    <div className="fd-page-loader" role="status" aria-live="polite">
      <img src="/brand/firedrill-loader.svg" alt="" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Spinner({ label }: { readonly label: string }) {
  return <LoaderCircle className="fd-spinner" aria-label={label} size={16} />;
}

export function CodeBlock({
  children,
  className = "",
}: {
  readonly children: string;
  readonly className?: string;
}) {
  return <pre className={`fd-code ${className}`.trim()}>{children}</pre>;
}

export function KeyValue({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="fd-key-value">
      <dt>{label}</dt>
      <dd data-mono={mono || undefined}>{children}</dd>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="fd-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (open && !busy) onClose();
      }}
    >
      <div className="fd-dialog__head">
        <h2>{title}</h2>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X size={17} />
        </IconButton>
      </div>
      <p>{description}</p>
      <div className="fd-dialog__actions">
        <Button onClick={onClose} disabled={busy}>
          Keep running
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? <Spinner label="Cancelling" /> : null}
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="fd-input" {...props} />;
}
