import { useEffect, useMemo, useRef, useState } from "react";
import { inspectorApi, type RunFileAttachment } from "../api";
import { plural, titleFromId } from "../format";
import { attachmentPreviewType, attachmentTextPreview } from "../report-attachments";
import type { SimulationRunDetail } from "../types";
import { CodeDocument } from "./code-document";
import { PaginatedContent } from "./pagination";
import { Button, InlineMessage, RowButton } from "./primitives";
import "./run-attachments.css";

type RunResult = NonNullable<SimulationRunDetail["result"]>;
type LogAttachment = {
  readonly key: string;
  readonly kind: "log";
  readonly name: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly interactionId: string;
};
type FileAttachment = {
  readonly key: string;
  readonly kind: "file";
  readonly file: RunFileAttachment;
  readonly capturedLog: boolean;
};
type AttachmentItem = LogAttachment | FileAttachment;

/** One selected preview owns its request and object URL; late bytes cannot create a leaked preview. */
export function createAttachmentPreviewRequest() {
  const controller = new AbortController();
  let current = true;
  let source: string | undefined;
  return {
    signal: controller.signal,
    isCurrent: () => current,
    createSource(bytes: ArrayBuffer, mediaType: string) {
      const type = attachmentPreviewType(mediaType);
      if (!current || type === undefined || type.kind === "text") return undefined;
      if (source !== undefined) URL.revokeObjectURL(source);
      source = URL.createObjectURL(new Blob([bytes], { type: type.mediaType }));
      return source;
    },
    dispose() {
      current = false;
      controller.abort();
      if (source !== undefined) {
        URL.revokeObjectURL(source);
        source = undefined;
      }
    },
  };
}

/** Capture logs have a known JSONL envelope; ordinary text attachments are never reinterpreted. */
export function captureLogMessages(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return line;
        const record = value as Record<string, unknown>;
        if (
          typeof record.message !== "string" ||
          (record.interactionId !== undefined && typeof record.interactionId !== "string") ||
          Object.keys(record).some((key) => key !== "message" && key !== "interactionId")
        )
          return line;
        return typeof record.interactionId !== "string"
          ? record.message
          : `[${titleFromId(record.interactionId)}] ${record.message}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

export function runLogAttachments(result: Pick<RunResult, "interactions">): readonly LogAttachment[] {
  return result.interactions.flatMap((interaction) =>
    interaction.targetResult.attachments.flatMap((attachment, index) =>
      attachment.kind === "process.stderr" && typeof attachment.text === "string"
        ? [
            {
              key: `stderr:${interaction.interactionId}:${index}`,
              kind: "log" as const,
              name: "Process stderr",
              text: attachment.text,
              truncated: attachment.truncated === true,
              interactionId: interaction.interactionId,
            },
          ]
        : [],
    ),
  );
}

function declaredFileIds(result: RunResult): readonly string[] {
  return [
    ...new Set([
      ...result.interactions.flatMap((interaction) =>
        interaction.targetResult.attachments.flatMap((attachment) =>
          attachment.kind === "file" && typeof attachment.id === "string" ? [attachment.id] : [],
        ),
      ),
      ...(result.capture?.attachments.map((item) => item.attachment.id) ?? []),
    ]),
  ];
}

export function hasRunAttachments(result: RunResult): boolean {
  return (
    declaredFileIds(result).length > 0 ||
    runLogAttachments(result).length > 0 ||
    (result.capture !== undefined &&
      (Object.values(result.capture.policies).some((policy) => policy !== "off") ||
        result.capture.errors.length > 0 ||
        Object.values(result.capture.discarded).some((count) => count > 0)))
  );
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

export function AttachmentText({
  text,
  truncated = false,
  language,
}: {
  readonly text: string;
  readonly truncated?: boolean;
  readonly language?: string;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className="fd-attachment-text">
      {truncated ? (
        <p className="fd-muted-copy">
          Preview limited to the first 64 KiB. Download the file for all retained content.
        </p>
      ) : null}
      <PaginatedContent items={lines} label="Attachment preview lines" resetKey={text} pageSize={100}>
        {(pageLines, start) => (
          <CodeDocument
            content={pageLines.join("\n")}
            startLine={start + 1}
            {...(language === undefined ? {} : { language })}
            context={
              lines.length > 100
                ? `Preview lines ${start + 1}–${start + pageLines.length} of ${lines.length}`
                : `${plural(lines.length, "line")}`
            }
          />
        )}
      </PaginatedContent>
    </div>
  );
}

export function AttachmentMedia({
  kind,
  source,
  name,
  onError,
}: {
  readonly kind: "image" | "video";
  readonly source: string;
  readonly name: string;
  readonly onError: () => void;
}) {
  if (!source.startsWith("blob:")) return <p>Preview source unavailable.</p>;
  if (kind === "image")
    return <img className="fd-attachment-image" src={source} alt={name} onError={onError} />;
  return (
    // biome-ignore lint/a11y/useMediaCaption: Captured files have no authored caption track; do not invent a transcript.
    <video
      className="fd-attachment-video"
      src={source}
      controls
      preload="metadata"
      playsInline
      aria-label={name}
      onError={onError}
    >
      Your browser cannot play this video. Download the file to view it.
    </video>
  );
}

function SelectedAttachment({ runId, item }: { readonly runId: string; readonly item: AttachmentItem }) {
  const name = item.kind === "file" ? item.file.name : item.name;
  const file = item.kind === "file" ? item.file : undefined;
  const type = useMemo(() => attachmentPreviewType(file?.mediaType ?? "text/plain"), [file?.mediaType]);
  const capturedLog = item.kind === "file" && item.capturedLog;
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${file?.id}:${file?.hash}:${attempt}`;
  const [loadedResult, setLoaded] = useState<{
    readonly key: string;
    readonly bytes: ArrayBuffer;
    readonly source?: string;
    readonly text?: string;
    readonly truncated?: boolean;
    readonly previewError?: string;
  }>();
  const loaded = loadedResult?.key === requestKey ? loadedResult : undefined;
  const [error, setError] = useState<string>();
  const [mediaError, setMediaError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const downloadRequest = useRef<AbortController | undefined>(undefined);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      downloadRequest.current?.abort();
      for (const [url, timer] of downloads.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.current.clear();
    };
  }, []);
  useEffect(() => {
    if (file === undefined || type === undefined) return;
    const request = createAttachmentPreviewRequest();
    setLoaded(undefined);
    setError(undefined);
    setMediaError(false);
    void inspectorApi
      .attachmentBytes(runId, file, request.signal)
      .then((bytes) => {
        if (!request.isCurrent()) return;
        if (type.kind === "text") {
          try {
            const preview = attachmentTextPreview(new Uint8Array(bytes));
            setLoaded({
              key: requestKey,
              bytes,
              ...preview,
              text: capturedLog ? captureLogMessages(preview.text) : preview.text,
            });
          } catch {
            setLoaded({
              key: requestKey,
              bytes,
              previewError:
                "This file is not readable UTF-8 text. Download it to inspect its original bytes.",
            });
          }
        } else {
          const source = request.createSource(bytes, type.mediaType);
          if (source !== undefined) setLoaded({ key: requestKey, bytes, source });
        }
      })
      .catch((failure: unknown) => {
        if (request.isCurrent())
          setError(failure instanceof Error ? failure.message : "The attachment could not be loaded.");
      });
    return () => request.dispose();
  }, [capturedLog, file, requestKey, runId, type]);

  const log = useMemo(() => {
    if (item.kind !== "log") return undefined;
    try {
      return attachmentTextPreview(new TextEncoder().encode(item.text));
    } catch {
      return undefined;
    }
  }, [item]);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(undefined);
    const controller = new AbortController();
    downloadRequest.current = controller;
    try {
      const bytes =
        item.kind === "log"
          ? new TextEncoder().encode(item.text).buffer
          : (loaded?.bytes ?? (await inspectorApi.attachmentBytes(runId, item.file, controller.signal)));
      if (!active.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = item.kind === "file" ? item.file.name : `process-stderr-${item.interactionId}.log`;
      link.click();
      downloads.current.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloads.current.delete(url);
        }, 1000),
      );
    } catch (failure) {
      if (active.current && !controller.signal.aborted)
        setDownloadError(
          failure instanceof Error ? failure.message : "The attachment could not be downloaded.",
        );
    } finally {
      if (active.current && !controller.signal.aborted) setDownloading(false);
    }
  };
  const previewLoading =
    file !== undefined && type !== undefined && loaded === undefined && error === undefined;
  return (
    <section className="fd-attachment-preview" aria-label={`Preview: ${name}`}>
      <div className="fd-attachment-preview__heading">
        <h4>{name}</h4>
        <Button size="compact" disabled={downloading || previewLoading} onClick={() => void download()}>
          {downloading ? "Downloading…" : "Download"}
        </Button>
      </div>
      {file === undefined ? (
        <p className="fd-muted-copy">
          Process log from {titleFromId(item.kind === "log" ? item.interactionId : "")}.
        </p>
      ) : (
        <p className="fd-muted-copy">
          {file.mediaType} · {bytesLabel(file.bytes)} ·{" "}
          {file.redaction.status === "applied_by_caller"
            ? "Redaction applied by caller"
            : "Redaction not applied"}
          {file.redaction.note === null ? "" : ` — ${file.redaction.note}`}
        </p>
      )}
      {downloadError === undefined ? null : (
        <InlineMessage tone="danger">{downloadError} Retry the download.</InlineMessage>
      )}
      {item.kind === "log" ? (
        <>
          {item.truncated ? (
            <p className="fd-muted-copy">
              The process log was truncated during capture. Only retained content is available.
            </p>
          ) : null}
          {log === undefined ? (
            <p>This log contains binary data. Download it to inspect the original content.</p>
          ) : (
            <AttachmentText text={log.text} truncated={log.truncated} />
          )}
        </>
      ) : type === undefined ? (
        <p className="fd-muted-copy">
          Preview is unavailable for this file type. Download it to inspect the original file.
        </p>
      ) : error !== undefined ? (
        <InlineMessage tone="danger" title="Attachment could not be loaded">
          <p>{error}</p>
          <Button size="compact" onClick={() => setAttempt((value) => value + 1)}>
            Retry attachment
          </Button>
        </InlineMessage>
      ) : loaded === undefined ? (
        <p className="fd-muted-copy" role="status">
          Loading {name}…
        </p>
      ) : loaded.previewError !== undefined ? (
        <p className="fd-muted-copy">{loaded.previewError}</p>
      ) : mediaError ? (
        <p className="fd-muted-copy">
          This browser could not display the file. Download it to view it in another application.
        </p>
      ) : type.kind === "text" ? (
        <AttachmentText
          text={loaded.text ?? ""}
          truncated={loaded.truncated ?? false}
          {...(type.mediaType === "application/json" ? { language: "json" } : {})}
        />
      ) : loaded.source === undefined ? null : (
        <AttachmentMedia
          kind={type.kind}
          source={loaded.source}
          name={name}
          onError={() => setMediaError(true)}
        />
      )}
    </section>
  );
}

export function AttachmentBrowser({
  runId,
  files,
  logs,
  capturedLogIds = [],
}: {
  readonly runId: string;
  readonly files: readonly RunFileAttachment[];
  readonly logs: readonly LogAttachment[];
  readonly capturedLogIds?: readonly string[];
}) {
  const items = useMemo<readonly AttachmentItem[]>(
    () => [
      ...files.map((file) => ({
        key: `file:${file.id}`,
        kind: "file" as const,
        file,
        capturedLog: capturedLogIds.includes(file.id),
      })),
      ...logs,
    ],
    [capturedLogIds, files, logs],
  );
  const [selection, setSelection] = useState<string>();
  const selected = items.find((item) => item.key === selection) ?? items[0];
  if (selected === undefined) return null;
  return (
    <>
      <PaginatedContent items={items} label="Attachments" resetKey={runId} pageSize={5}>
        {(pageItems) => (
          <div className="fd-attachment-list">
            {pageItems.map((item) => (
              <RowButton
                key={item.key}
                className="fd-attachment-list__item"
                aria-current={selected.key === item.key ? "true" : undefined}
                onClick={() => setSelection(item.key)}
              >
                <span>
                  <strong>{item.kind === "file" ? item.file.name : item.name}</strong>
                  <small>
                    {item.kind === "file"
                      ? `${item.file.mediaType} · ${bytesLabel(item.file.bytes)}`
                      : `text/plain · ${titleFromId(item.interactionId)}`}
                  </small>
                </span>
              </RowButton>
            ))}
          </div>
        )}
      </PaginatedContent>
      <SelectedAttachment
        key={`${runId}:${selected.key}:${selected.kind === "file" ? selected.file.hash : selected.text}`}
        runId={runId}
        item={selected}
      />
    </>
  );
}

export function RunAttachments({
  runId,
  result,
  reportAvailable,
}: {
  readonly runId: string;
  readonly result: RunResult;
  readonly reportAvailable: boolean;
}) {
  const fileKey = JSON.stringify(declaredFileIds(result));
  const hasFiles = fileKey !== "[]";
  const logs = useMemo(() => runLogAttachments(result), [result]);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${runId}:${fileKey}:${reportAvailable}:${attempt}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    files?: readonly RunFileAttachment[];
    error?: string;
  }>();
  useEffect(() => {
    if (!hasFiles || !reportAvailable) return;
    let current = true;
    const controller = new AbortController();
    void inspectorApi
      .runAttachments(runId, controller.signal)
      .then((page) => {
        if (!current) return;
        if (page.runId !== runId || page.attachments.length > 32)
          throw new Error("The attachment list does not match this run.");
        setLoaded({ key: requestKey, files: page.attachments });
      })
      .catch((failure: unknown) => {
        if (current)
          setLoaded({
            key: requestKey,
            error: failure instanceof Error ? failure.message : "The attachment list could not be loaded.",
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [hasFiles, reportAvailable, requestKey, runId]);
  if (!hasRunAttachments(result)) return null;
  const response = loaded?.key === requestKey ? loaded : undefined;
  const files = response?.files ?? [];
  const policies =
    result.capture === undefined
      ? []
      : Object.entries(result.capture.policies).filter(([, policy]) => policy !== "off");
  const discarded =
    result.capture === undefined
      ? []
      : Object.entries(result.capture.discarded).filter(([, count]) => count > 0);
  return (
    <section className="fd-run-section fd-run-attachments" data-scroll-section="attachments">
      <div className="fd-section-heading">
        <h3>Attachments</h3>
      </div>
      {policies.length === 0 ? null : (
        <p className="fd-muted-copy">
          Capture policy:{" "}
          {policies
            .map(
              ([kind, policy]) =>
                `${titleFromId(kind)} — ${policy === "always" ? "always" : "retain on failure"}`,
            )
            .join("; ")}
          .
        </p>
      )}
      {discarded.length === 0 ? null : (
        <p className="fd-muted-copy">
          Not retained
          {result.status === "sealed" && result.verdict === "passed" ? " after this passed run" : ""}:{" "}
          {discarded
            .map(([kind, count]) =>
              plural(
                count,
                kind === "logs"
                  ? "log"
                  : kind === "screenshots"
                    ? "screenshot"
                    : kind === "files"
                      ? "file"
                      : "video",
              ),
            )
            .join(", ")}
          .
        </p>
      )}
      {result.capture?.errors.length ? (
        <PaginatedContent items={result.capture.errors} label="Capture errors" resetKey={runId}>
          {(errors, start) => (
            <ul className="fd-capture-errors">
              {errors.map((error, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable recorded errors retain their original source order.
                <li key={`${error.code}:${start + index}`}>
                  <strong>
                    {error.kind === undefined ? "Capture" : titleFromId(error.kind)} could not complete.
                  </strong>{" "}
                  {error.message}
                  {error.interactionId === undefined
                    ? ""
                    : ` Interaction: ${titleFromId(error.interactionId)}.`}
                </li>
              ))}
            </ul>
          )}
        </PaginatedContent>
      ) : null}
      {hasFiles && !reportAvailable ? (
        <p className="fd-muted-copy">Retained files will be available when the saved report is ready.</p>
      ) : hasFiles && response?.error !== undefined ? (
        <InlineMessage tone="danger" title="Attachments could not be loaded">
          <p>{response.error}</p>
          <Button size="compact" onClick={() => setAttempt((value) => value + 1)}>
            Retry attachment list
          </Button>
        </InlineMessage>
      ) : hasFiles && response?.files === undefined ? (
        <p className="fd-muted-copy" role="status">
          Loading attachment list…
        </p>
      ) : null}
      {!hasFiles && logs.length === 0 && discarded.length === 0 ? (
        <p className="fd-muted-copy">No attachments were retained for this run.</p>
      ) : null}
      <AttachmentBrowser
        runId={runId}
        files={files}
        logs={logs}
        capturedLogIds={
          result.capture?.attachments
            .filter((item) => item.kind === "log")
            .map((item) => item.attachment.id) ?? []
        }
      />
    </section>
  );
}
