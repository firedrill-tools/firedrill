import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeDocument } from "./code-document";
import { DataViewer } from "./data-viewer";
import { Button, IconButton, RowButton } from "./primitives";

describe("inspector interaction components", () => {
  it("renders ordinary and link actions as native buttons with forwarded state", () => {
    const ordinary = renderToStaticMarkup(<Button className="context-action">Open</Button>);
    expect(ordinary).toContain('<button type="button"');
    expect(ordinary).toContain("fd-button--secondary");
    expect(ordinary).toContain("context-action");

    const link = renderToStaticMarkup(
      <Button variant="link" type="submit" disabled form="filters" aria-pressed={false}>
        Apply
      </Button>,
    );
    expect(link).toContain('<button type="submit"');
    expect(link).toContain("fd-button--link");
    expect(link).toContain('disabled=""');
    expect(link).toContain('form="filters"');
    expect(link).toContain('aria-pressed="false"');
    expect(link).not.toContain("<a ");
  });

  it("keeps icon actions named and native when disabled", () => {
    const markup = renderToStaticMarkup(
      <IconButton label="Next page" disabled>
        Next
      </IconButton>,
    );
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Next page"');
    expect(markup).toContain('title="Next page"');
    expect(markup).toContain('disabled=""');
  });

  it("gives selectable rows a decorative opening cue without replacing native button semantics", () => {
    const defaults = renderToStaticMarkup(<RowButton>Record</RowButton>);
    expect(defaults).toContain('<button type="button"');

    const row = renderToStaticMarkup(
      <RowButton
        type="submit"
        disabled
        className="fd-timeline-entry"
        id="event-1"
        aria-expanded={false}
        aria-controls="event-details"
        aria-current="true"
      >
        <span>Tool call</span>
      </RowButton>,
    );
    expect(row).toContain('<button type="submit"');
    expect(row).toContain('class="fd-row-button fd-timeline-entry"');
    expect(row).toContain('id="event-1"');
    expect(row).toContain('disabled=""');
    expect(row).toContain('aria-expanded="false"');
    expect(row).toContain('aria-controls="event-details"');
    expect(row).toContain('aria-current="true"');
    expect(row).toMatch(
      /<span>Tool call<\/span><svg\b[^>]*class="[^"]*fd-row-button__chevron[^"]*"[^>]*aria-hidden="true"/,
    );
    expect(row.match(/<svg\b/g)).toHaveLength(1);
  });

  it("renders a visible data action and a correctly labelled closed dialog", () => {
    const markup = renderToStaticMarkup(
      <DataViewer title="Request schema" value={{ type: "object" }} label="Inputs" />,
    );
    const trigger = markup.slice(0, markup.indexOf("</button>"));
    expect(trigger).toContain("fd-button--secondary");
    expect(trigger).not.toContain("fd-button--quiet");
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).toContain('aria-label="Inputs: Request schema"');

    const dialog = markup.match(/<dialog\b[^>]*>/)?.[0];
    expect(dialog).toBeDefined();
    expect(dialog).not.toMatch(/\sopen(?:=|\s|>)/);
    const headingId = dialog?.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(headingId).toBeDefined();
    expect(markup).toContain(`<h2 id="${headingId}">Request schema</h2>`);
  });

  it("marks identifier viewers as link-style buttons with an aria-hidden arrow", () => {
    const markup = renderToStaticMarkup(
      <DataViewer title="Record" value={{}} label="record-1" variant="link" />,
    );
    const trigger = markup.slice(0, markup.indexOf("</button>"));
    expect(trigger).toContain('<button type="button"');
    expect(trigger).toContain("fd-button--link");
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).toMatch(/<svg\b[^>]*aria-hidden="true"/);
    expect(trigger).toContain("record-1");
  });

  it("keeps document wrapping and copying visibly actionable, with toggle state", () => {
    const markup = renderToStaticMarkup(<CodeDocument content={"one\ntwo"} />);
    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('<button type="button"');
      expect(button).toContain("fd-button--secondary");
      expect(button).not.toContain("fd-button--quiet");
    }
    expect(buttons[0]).toContain('aria-pressed="false"');
    expect(buttons[0]).toContain("Wrap lines");
    expect(buttons[1]).toContain("Copy");
  });
});
