import { describe, expect, it } from "vitest";
import {
  attachmentDataUrl,
  attachmentPreviewDataUrl,
  attachmentPreviewType,
  attachmentTextPreview,
  embedReportAttachments,
} from "../client/src/report-attachments.js";

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

  it("embeds typed verified image/video previews while keeping download bytes inert", () => {
    const image = { ...file, previewDataUrl: "data:image/png;base64,AQID" };
    const video = {
      path: "attachments/video-1/replay.webm",
      dataUrl: file.dataUrl,
      previewDataUrl: "data:video/webm;base64,AQID",
    };
    expect(attachmentPreviewDataUrl(file.dataUrl, "image/png")).toBe(image.previewDataUrl);
    expect(attachmentPreviewDataUrl(file.dataUrl, "video/webm")).toBe(video.previewDataUrl);
    const html = `<a href="${file.path}" download>Image</a><img data-attachment-preview="image" src="${file.path}" alt="screen.png"><a href="${video.path}" download>Video</a><video data-attachment-preview="video" src="${video.path}" controls preload="metadata"></video>`;
    const embedded = embedReportAttachments(html, [image, video]);
    expect(embedded).toContain('src="data:image/png;base64,AQID"');
    expect(embedded).toContain('src="data:video/webm;base64,AQID"');
    expect(embedded.match(/href="data:application\/octet-stream/g)).toHaveLength(2);
    expect(embedded).not.toContain("autoplay");
  });

  it("rejects remote preview references, mismatched media kinds, and different preview bytes", () => {
    const verified = { ...file, previewDataUrl: "data:image/png;base64,AQID" };
    const link = `<a href="${file.path}">Download</a>`;
    for (const preview of [
      '<img data-attachment-preview="image" src="https://remote.test/record.png">',
      `<video data-attachment-preview="video" src="${file.path}"></video>`,
      `<img data-attachment-preview="image" src="../${file.path}">`,
    ])
      expect(() => embedReportAttachments(link + preview, [verified])).toThrow("invalid attachment preview");
    expect(() =>
      embedReportAttachments(link, [{ ...verified, previewDataUrl: "data:image/png;base64,BAUG" }]),
    ).toThrow("invalid attachment preview");
    expect(() =>
      embedReportAttachments(link, [{ ...verified, previewDataUrl: "data:image/svg+xml;base64,AQID" }]),
    ).toThrow("invalid attachment preview");
  });

  it("uses an explicit preview allowlist, never file extensions or arbitrary MIME strings", () => {
    for (const mediaType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/webm",
      "text/plain; charset=utf-8",
      "application/json",
    ])
      expect(attachmentPreviewType(mediaType)).toBeDefined();
    for (const mediaType of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "application/pdf",
      "image/gif",
      "video/mp4",
      "application/octet-stream",
      "https://remote.test/image.png",
    ]) {
      expect(attachmentPreviewType(mediaType)).toBeUndefined();
      expect(attachmentPreviewDataUrl(file.dataUrl, mediaType)).toBeUndefined();
    }
    expect(attachmentPreviewDataUrl(file.dataUrl, "application/json")).toBeUndefined();
  });

  it("bounds text previews without inserting partial UTF-8 characters and rejects binary prefixes", () => {
    const content = new TextEncoder().encode(`${"a".repeat(65535)}éz`);
    expect(attachmentTextPreview(content)).toEqual({ text: "a".repeat(65535), truncated: true });
    expect(() => attachmentTextPreview(new Uint8Array([0xff]))).toThrow();
    expect(() => attachmentTextPreview(new Uint8Array([65, 0, 66]))).toThrow("binary data");
    expect(attachmentTextPreview(new TextEncoder().encode("<script>alert(1)</script>"))).toEqual({
      text: "<script>alert(1)</script>",
      truncated: false,
    });
  });
});
