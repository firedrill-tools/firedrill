import { describe, expect, it } from "vitest";
import { attachmentDataUrl, embedReportAttachments } from "../client/src/report-attachments.js";

describe("portable inspector report attachments", () => {
  const file = {
    path: "attachments/screen-1/screen.png",
    dataUrl: "data:application/octet-stream;base64,AQID",
  };

  it("embeds only verified links, including safely percent-encoded file names", () => {
    const html =
      '<a href="attachments/screen-1/screen%2Epng" download="screen.png">Open attachment</a><a href="other.html">Other</a><p>attachments/screen-1/screen.png</p>';
    const result = embedReportAttachments(html, [file]);
    expect(result).toContain(`href="${file.dataUrl}" download="screen.png"`);
    expect(result).toContain('<a href="other.html">Other</a>');
    expect(result).toContain("<p>attachments/screen-1/screen.png</p>");
  });

  it("does not reinterpret external or traversal links as a verified attachment", () => {
    for (const path of [
      "https://other.test/attachments/screen-1/screen.png",
      "../attachments/screen-1/screen.png",
      "attachments/screen-1/../screen.png",
      "attachments/screen-1/%2E%2E%2Fscreen.png",
      "attachments/screen-1/%XXscreen.png",
    ]) {
      expect(() => embedReportAttachments(`<a href="${path}">Open</a>`, [file])).toThrow(
        "missing a verified attachment link",
      );
    }
  });

  it("keeps meaningful download names for older reports with a bare download attribute", () => {
    expect(
      embedReportAttachments('<a href="attachments/screen-1/screen.png" download>Open attachment</a>', [
        file,
      ]),
    ).toContain('download="screen.png"');
  });

  it("rejects active content and repeated or invalid references", () => {
    const html = '<a href="attachments/screen-1/screen.png">Open</a>';
    expect(() => embedReportAttachments(html, [file, file])).toThrow("invalid attachment reference");
    expect(() => embedReportAttachments(html, [{ ...file, dataUrl: "data:text/html;base64,AQID" }])).toThrow(
      "invalid attachment reference",
    );
    expect(() => embedReportAttachments(html, [{ ...file, path: "../secret" }])).toThrow(
      "invalid attachment reference",
    );
    expect(embedReportAttachments(html, [])).toBe(html);
  });

  it("encodes binary attachments without treating them as executable content", () => {
    expect(attachmentDataUrl(new Uint8Array([1, 2, 3]))).toBe(file.dataUrl);
    const large = new Uint8Array(100_000).fill(255);
    expect(atob(attachmentDataUrl(large).split(",")[1] ?? "").length).toBe(large.length);
  });
});
