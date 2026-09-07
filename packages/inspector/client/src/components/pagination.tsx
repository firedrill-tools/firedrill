import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { IconButton } from "./primitives";
import "./pagination.css";

/** Zero-based, bounded page state shared by repository lists and filtered evidence. */
export function pageBounds(total: number, page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize));
  const index = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / size) - 1)));
  return { page: index, pageSize: size, start: index * size, end: Math.min((index + 1) * size, total) };
}

export function usePagination<T>(items: readonly T[], resetKey = "", pageSize = 25) {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const bounds = pageBounds(items.length, state.key === resetKey ? state.page : 0, pageSize);
  // Adjust before rendering children: filters and smaller refreshed collections never leave a blank page.
  if (state.key !== resetKey || state.page !== bounds.page) {
    setState({ key: resetKey, page: bounds.page });
  }
  const onPageChange = (page: number) => setState({ key: resetKey, page });
  return { ...bounds, total: items.length, items: items.slice(bounds.start, bounds.end), onPageChange };
}

export function Pagination({
  label,
  page,
  pageSize,
  total,
  onPageChange,
  variant = "inline",
  disabled = false,
}: {
  readonly label: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onPageChange: (page: number) => void;
  readonly variant?: "inline" | "rail";
  readonly disabled?: boolean;
}) {
  const bounds = pageBounds(total, page, pageSize);
  if (total <= bounds.pageSize) return null;
  return (
    <nav className={`fd-pagination fd-pagination--${variant}`} aria-label={`${label} pages`}>
      <span aria-live="polite" aria-atomic="true">
        {bounds.start + 1}–{bounds.end} of {total}
      </span>
      <div>
        <IconButton
          label={`Previous ${label.toLowerCase()}`}
          disabled={disabled || bounds.page === 0}
          onClick={() => onPageChange(bounds.page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Next ${label.toLowerCase()}`}
          disabled={disabled || bounds.end >= total}
          onClick={() => onPageChange(bounds.page + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </nav>
  );
}

/** Keeps controls outside table/list markup, and mounts only the current page's viewers. */
export function PaginatedContent<T>({
  items,
  label,
  resetKey = "",
  pageSize = 10,
  children,
}: {
  readonly items: readonly T[];
  readonly label: string;
  readonly resetKey?: string;
  readonly pageSize?: number;
  readonly children: (items: readonly T[], start: number) => ReactNode;
}) {
  const pagination = usePagination(items, resetKey, pageSize);
  return (
    <>
      {children(pagination.items, pagination.start)}
      <Pagination label={label} {...pagination} />
    </>
  );
}
