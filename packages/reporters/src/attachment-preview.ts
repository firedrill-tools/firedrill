import type { TargetFileAttachment } from "@firedrill/contracts";

const MAX_TEXT_PREVIEW_BYTES = 64 * 1024;

export type AttachmentPreview =
  | { readonly kind: "image" | "video" }
  | { readonly kind: "text"; readonly content: string; readonly truncated: boolean };

/** The capture logger's JSONL envelope is presentation metadata; unknown lines remain literal. */
export function readableCaptureLog(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          !("message" in value) ||
          typeof value.message !== "string" ||
          Object.keys(value).some((key) => key !== "message" && key !== "interactionId") ||
          ("interactionId" in value && typeof value.interactionId !== "string")
        )
          return line;
        return "interactionId" in value ? `[${value.interactionId}] ${value.message}` : value.message;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function prefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

/** Preview only safe media with matching signatures. Callers supply already hash-verified bytes. */
export function attachmentPreview(
  attachment: TargetFileAttachment,
  bytes: Uint8Array,
): AttachmentPreview | undefined {
  const mediaType = attachment.mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    (mediaType === "image/png" && prefix(bytes, [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])) ||
    (mediaType === "image/jpeg" && prefix(bytes, [0xff, 0xd8, 0xff])) ||
    (mediaType === "image/webp" &&
      prefix(bytes, [82, 73, 70, 70]) &&
      prefix(bytes.subarray(8), [87, 69, 66, 80]))
  ) {
    return { kind: "image" };
  }
  if (mediaType === "video/webm" && prefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video" };
  if (mediaType !== "text/plain" && mediaType !== "application/json") return undefined;
  if (bytes.includes(0)) return undefined;
  const truncated = bytes.byteLength > MAX_TEXT_PREVIEW_BYTES;
  try {
    // Streaming decode drops only an incomplete final UTF-8 character at the bounded cut.
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES),
      { stream: truncated },
    );
    return { kind: "text", content, truncated };
  } catch {
    return undefined;
  }
}
