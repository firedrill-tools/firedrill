import type { TargetFileAttachment } from "@firedrill-tools/contracts";
import { describe, expect, it } from "vitest";
import { attachmentPreview, readableCaptureLog } from "../src/attachment-preview.js";

function attachment(mediaType: string): TargetFileAttachment {
  return {
    schemaVersion: 1,
    kind: "file",
    id: "attachment-preview001",
    name: "capture.bin",
    mediaType,
    bytes: 0,
    hash: `sha256:${"a".repeat(64)}`,
    redaction: { status: "not_applied", note: null },
  };
}

describe("verified attachment preview selection", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], "image"],
    ["image/jpeg", [0xff, 0xd8, 0xff], "image"],
    ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], "image"],
    ["video/webm", [0x1a, 0x45, 0xdf, 0xa3], "video"],
  ] as const)("requires the expected container signature for %s", (mediaType, bytes, kind) => {
    expect(attachmentPreview(attachment(mediaType), Uint8Array.from(bytes))).toEqual({ kind });
    expect(attachmentPreview(attachment(mediaType), Buffer.from("<html>not media</html>"))).toBeUndefined();
  });

  it.each(["text/html", "image/svg+xml", "image/gif", "application/zip", "audio/webm", "video/mp4"])(
    "never previews unsupported media %s",
    (mediaType) => {
      expect(
        attachmentPreview(attachment(mediaType), Buffer.from("<script>unsafe()</script>")),
      ).toBeUndefined();
    },
  );

  it.each(["text/plain", "application/json", "text/plain; charset=utf-8"])(
    "offers bounded UTF-8 text for %s",
    (mediaType) => {
      expect(attachmentPreview(attachment(mediaType), Buffer.from('<script>"literal"</script>'))).toEqual({
        kind: "text",
        content: '<script>"literal"</script>',
        truncated: false,
      });
    },
  );

  it("does not replace an incomplete UTF-8 character at the preview limit", () => {
    const body = Buffer.from(`${"a".repeat(65_535)}€end`);
    expect(attachmentPreview(attachment("text/plain"), body)).toEqual({
      kind: "text",
      content: "a".repeat(65_535),
      truncated: true,
    });
  });

  it("keeps binary, invalid UTF-8, and an incomplete final character download-only", () => {
    for (const bytes of [[0], [0xff], [0xe2, 0x82]]) {
      expect(attachmentPreview(attachment("text/plain"), Uint8Array.from(bytes))).toBeUndefined();
    }
  });

  it("renders known log envelopes as messages but preserves malformed or additional data", () => {
    const lines = [
      JSON.stringify({ interactionId: "first-step", message: "First message\nMore text" }),
      JSON.stringify({ message: "Run-level message" }),
      JSON.stringify({ message: "Unknown structure", timestamp: 100 }),
      JSON.stringify({ message: 4 }),
      "null",
      "truncated {",
    ];
    expect(readableCaptureLog(lines.join("\n"))).toBe(
      ["[first-step] First message\nMore text", "Run-level message", ...lines.slice(2)].join("\n"),
    );
  });
});
