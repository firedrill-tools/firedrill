import { useEffect, useState } from "react";
import { inspectorApi } from "../api";
import { CodeDocument } from "../components/code-document";
import { Button, EmptyState, InlineMessage, Select, Spinner } from "../components/primitives";
import type { SimulationTool, SimulationToolSourceDocument } from "../types";

const sourceUnavailable = {
  unsupported_file: "This file type cannot be displayed as executable source.",
  restricted_path: "This source path is excluded to protect private files.",
  missing_source: "The original source file was not available at refresh. Restore it, then refresh source.",
  unsafe_path: "This source file could not be read safely within its declared package.",
  too_large: "This source file exceeds the 1 MiB display limit.",
  invalid_text: "This source file is not valid text.",
  package_changed: "The installed package has changed. Restore the selected dependency, then refresh source.",
  snapshot_limit: "This file exceeds the source snapshot budget. You can read it in the repository.",
} as const;

export function ToolImplementation({ tool }: { readonly tool: SimulationTool }) {
  const implementation = tool.implementation;
  const files = implementation?.files ?? [];
  const [selected, setSelected] = useState("");
  const file =
    files.find((item) => item.id === selected) ?? files.find((item) => item.role === "entry") ?? files[0];
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    readonly key: string;
    readonly document?: SimulationToolSourceDocument;
    readonly error?: string;
  }>();
  const key = `${tool.id}:${implementation?.buildHash}:${file?.id}:${file?.contentHash}:${attempt}`;

  useEffect(() => {
    if (file === undefined || !file.readable || implementation === undefined) return;
    let current = true;
    void inspectorApi.toolSource(tool.id, file.id).then(
      (document) => {
        if (!current) return;
        if (
          document.toolId !== tool.id ||
          document.fileId !== file.id ||
          document.contentHash !== file.contentHash ||
          document.buildHash !== implementation.buildHash
        ) {
          setResult({
            key,
            error: "The source snapshot changed. Refresh source to view the current implementation.",
          });
          return;
        }
        setResult({ key, document });
      },
      (error: unknown) => {
        if (current)
          setResult({
            key,
            error: error instanceof Error ? error.message : "The implementation could not be loaded.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [file, implementation, tool.id, key]);

  if (implementation === undefined || file === undefined) {
    return (
      <EmptyState title="Implementation source unavailable">
        Refresh source with the current framework version to inspect this Tool’s executable files. The
        declaration alone does not contain its behavior.
      </EmptyState>
    );
  }

  const document = result?.key === key ? result.document : undefined;
  const error = result?.key === key ? result.error : undefined;
  return (
    <section className="fd-tool-source" aria-label="Tool implementation">
      <div className="fd-tool-source__intro">
        <p>Executable Tool code from the last source refresh, not a saved run.</p>
      </div>
      <div className="fd-tool-source__file">
        {files.length > 1 ? (
          <Select
            label="Implementation file"
            value={file.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {files.map((item) => (
              <option key={item.id} value={item.id}>
                {item.path}
                {item.role === "entry" ? " (entry module)" : ""}
              </option>
            ))}
          </Select>
        ) : (
          <code>{file.path}</code>
        )}
        {file.role === "entry" ? (
          <span>
            Tool export <code>{implementation.exportName}</code>
          </span>
        ) : null}
      </div>
      {!file.readable ? (
        <div className="fd-tool-source__message">
          <InlineMessage tone="warning" title="Source unavailable">
            {file.unavailableReason === undefined
              ? "The original source is not available in this project."
              : sourceUnavailable[file.unavailableReason]}
          </InlineMessage>
        </div>
      ) : error !== undefined ? (
        <div className="fd-tool-source__message">
          <InlineMessage tone="danger" title="Could not load implementation">
            {error}
          </InlineMessage>
          <Button onClick={() => setAttempt((value) => value + 1)}>Retry source</Button>
        </div>
      ) : document === undefined ? (
        <div className="fd-tool-source__message" role="status">
          <Spinner label="Loading implementation" />
          Loading implementation…
        </div>
      ) : (
        <CodeDocument
          key={`${file.id}:${document.contentHash}`}
          content={document.content}
          language={document.language}
          context={implementation.origin.kind === "npm" ? "Installed package source" : "Repository source"}
        />
      )}
    </section>
  );
}
