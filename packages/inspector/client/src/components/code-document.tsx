import { Check, Copy, WrapText } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "./primitives";
import { sourceLines } from "./source-tokens";
import "./data-viewer.css";

/** Read-only document surface shared by authored source and captured data. */
export function CodeDocument({
  content,
  language,
  context,
  startLine = 1,
}: {
  readonly content: string;
  readonly language?: string;
  readonly context?: string;
  readonly startLine?: number;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const lines = useMemo(() => sourceLines(content, language), [content, language]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };
  return (
    <>
      <div className="fd-document-toolbar">
        {context === undefined ? null : <span className="fd-document-context">{context}</span>}
        <Button size="compact" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={15} aria-hidden="true" />
          Wrap lines
        </Button>
        <Button size="compact" onClick={() => void copy()}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {copyError ? <span role="alert">Copy unavailable. Select the text to copy it.</span> : null}
      </div>
      <section
        className="fd-document-code"
        data-wrap={wrap || undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling in this read-only document.
        tabIndex={0}
        aria-label="Document content"
      >
        <pre>
          <code>
            {lines.map((line, index) => (
              // This is an immutable document; line position is its stable identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only line positions
              <span className="fd-document-line" key={index}>
                <span className="fd-document-line__number" aria-hidden="true">
                  {index + startLine}
                </span>
                <span className="fd-document-line__text">
                  {line.map((token) => (
                    <span key={token.offset} data-token={token.kind}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </section>
    </>
  );
}
