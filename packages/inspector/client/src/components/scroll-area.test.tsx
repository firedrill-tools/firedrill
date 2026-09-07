import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";

describe("discoverable content regions", () => {
  it("labels the keyboard-scrollable region without fabricating overflow", () => {
    const markup = renderToStaticMarkup(
      <ScrollArea label="Starting records">
        <table>
          <tbody>
            <tr>
              <td>Record</td>
            </tr>
          </tbody>
        </table>
      </ScrollArea>,
    );
    expect(markup).toContain('aria-label="Starting records"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("More below");
    expect(markup).not.toContain("More columns");
    expect(markup).not.toContain("Jump to");
  });

  it("exposes named section shortcuts before the content, not a hidden outline", () => {
    const markup = renderToStaticMarkup(
      <ScrollArea
        label="Definition"
        sections={[
          { id: "data", label: "Starting data" },
          { id: "events", label: "Events" },
        ]}
      >
        <section data-scroll-section="data">
          <h3>Data content</h3>
        </section>
        <section data-scroll-section="events">
          <h3>Event content</h3>
        </section>
      </ScrollArea>,
    );
    expect(markup).toContain('aria-label="Definition sections"');
    expect(markup).toContain('type="button"');
    expect(markup.indexOf("Jump to")).toBeLessThan(markup.indexOf("Data content"));
    expect(markup).toContain('data-scroll-section="events"');
  });
});
