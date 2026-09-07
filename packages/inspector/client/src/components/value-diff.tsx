import { diffLines } from "diff";
import { useMemo } from "react";
import { Pagination, usePagination } from "./pagination";
import { Button } from "./primitives";
import { ScrollArea } from "./scroll-area";
import "./value-diff.css";

type DiffLine = { readonly number: number; readonly text: string };
export type ValueDiffRow = {
  readonly before?: DiffLine;
  readonly after?: DiffLine;
  readonly changed: boolean;
};

/** Object order is not evidence; array order, types, null, and missing values are. */
export function formatDiffValue(value: unknown): string {
  if (value === undefined) return "Not recorded";
  return (
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          );
        }
        return item;
      },
      2,
    ) ?? "Not recorded"
  );
}

/** Bounded alignment. A fallback still shows every line; it never invents equality. */
export function compareValueLines(before: string, after: string) {
  const changes = diffLines(`${before}\n`, `${after}\n`, { maxEditLength: 1500, timeout: 60 });
  const rows: ValueDiffRow[] = [];
  if (changes === undefined) {
    const left = before.split("\n");
    const right = after.split("\n");
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const beforeLine = left[index];
      const afterLine = right[index];
      rows.push({
        ...(beforeLine === undefined ? {} : { before: { number: index + 1, text: beforeLine } }),
        ...(afterLine === undefined ? {} : { after: { number: index + 1, text: afterLine } }),
        changed: beforeLine !== afterLine,
      });
    }
    return { rows, aligned: false };
  }
  let beforeNumber = 1;
  let afterNumber = 1;
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      rows.push({
        ...(removed[index] === undefined ? {} : { before: removed[index] }),
        ...(added[index] === undefined ? {} : { after: added[index] }),
        changed: true,
      });
    }
    removed = [];
    added = [];
  };
  for (const change of changes) {
    const lines = change.value.slice(0, -1).split("\n");
    if (change.removed) {
      for (const text of lines) removed.push({ number: beforeNumber++, text });
    } else if (change.added) {
      for (const text of lines) added.push({ number: afterNumber++, text });
    } else {
      flush();
      for (const text of lines) {
        rows.push({
          before: { number: beforeNumber++, text },
          after: { number: afterNumber++, text },
          changed: false,
        });
      }
    }
  }
  flush();
  return { rows, aligned: true };
}

function Line({
  line,
  side,
  changed,
  label,
}: {
  readonly line: DiffLine | undefined;
  readonly side: "before" | "after";
  readonly changed: boolean;
  readonly label: string;
}) {
  return (
    <div
      className={`fd-value-diff__line fd-value-diff__line--${side}`}
      data-changed={changed || undefined}
      data-empty={line === undefined || undefined}
    >
      {line === undefined ? null : (
        <>
          <span className="fd-value-diff__number" aria-hidden="true">
            {line.number}
          </span>
          <span className="fd-value-diff__marker" aria-hidden="true">
            {changed ? (side === "before" ? "−" : "+") : " "}
          </span>
          <code>
            <span className="sr-only">
              {label}, line {line.number}:{" "}
            </span>
            {line.text}
          </code>
        </>
      )}
    </div>
  );
}

/** Read-only, inline evidence comparison. Color describes changed lines, not a check verdict. */
export function ValueDiff({
  before,
  after,
  beforeLabel = "Expected",
  afterLabel = "Actual",
  label = "Value comparison",
}: {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeLabel?: string;
  readonly afterLabel?: string;
  readonly label?: string;
}) {
  const left = useMemo(() => formatDiffValue(before), [before]);
  const right = useMemo(() => formatDiffValue(after), [after]);
  const comparison = useMemo(() => compareValueLines(left, right), [left, right]);
  const pages = usePagination(comparison.rows, `${left}\u0000${right}`, 80);
  const firstChange = comparison.rows.findIndex((row) => row.changed);
  const firstChangeOutsidePage = firstChange >= 0 && (firstChange < pages.start || firstChange >= pages.end);
  return (
    <section className="fd-value-diff" aria-label={label}>
      <div className="fd-value-diff__head">
        <span>− {beforeLabel}</span>
        <span>+ {afterLabel}</span>
      </div>
      {!comparison.aligned ? (
        <p className="fd-value-diff__note">Large values are shown without line alignment.</p>
      ) : null}
      <ScrollArea
        label={`${label} content`}
        className="fd-value-diff__scroll"
        contentClassName="fd-value-diff__rows"
        resetKey={`${left}\u0000${right}:${pages.page}`}
      >
        {pages.items.map((row) => (
          <div
            className="fd-value-diff__row"
            data-changed={row.changed || undefined}
            key={`${row.before?.number ?? ""}:${row.after?.number ?? ""}`}
          >
            <Line line={row.before} side="before" changed={row.changed} label={beforeLabel} />
            <Line line={row.after} side="after" changed={row.changed} label={afterLabel} />
          </div>
        ))}
      </ScrollArea>
      {firstChangeOutsidePage ? (
        <div className="fd-value-diff__jump">
          <Button size="compact" onClick={() => pages.onPageChange(Math.floor(firstChange / pages.pageSize))}>
            Jump to first change
          </Button>
        </div>
      ) : null}
      <Pagination label={`${label} lines`} {...pages} />
    </section>
  );
}
