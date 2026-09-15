export interface EmbeddedReportAttachment {
  readonly path: string;
  readonly dataUrl: string;
  readonly previewDataUrl?: string;
}

export const ATTACHMENT_TEXT_PREVIEW_BYTES = 64 * 1024;

/** Never infer executable content from names or permit arbitrary caller-provided MIME types. */
export function attachmentPreviewType(mediaType: string) {
  const type = mediaType.split(";")[0]?.trim().toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp")
    return { kind: "image" as const, mediaType: type };
  if (type === "video/webm") return { kind: "video" as const, mediaType: type };
  if (type === "text/plain" || type === "application/json") return { kind: "text" as const, mediaType: type };
  return undefined;
}

/** The prefix is bounded; an incomplete UTF-8 character at the boundary is omitted, never replaced. */
export function attachmentTextPreview(bytes: Uint8Array) {
  const truncated = bytes.byteLength > ATTACHMENT_TEXT_PREVIEW_BYTES;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, ATTACHMENT_TEXT_PREVIEW_BYTES),
    { stream: truncated },
  );
  if (text.includes("\0"))
    throw new Error("This attachment contains binary data and cannot be previewed as text.");
  return { text, truncated };
}

/** Reuse exactly the already-verified bytes; only inert image/video formats become typed sources. */
export function attachmentPreviewDataUrl(dataUrl: string, mediaType: string): string | undefined {
  const type = attachmentPreviewType(mediaType);
  if (type === undefined || type.kind === "text") return undefined;
  if (!/^data:application\/octet-stream;base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl))
    throw new Error("The report contains an invalid attachment reference.");
  return `data:${type.mediaType};base64,${dataUrl.slice(dataUrl.indexOf(",") + 1)}`;
}

function attachmentPath(href: string): string | undefined {
  try {
    const path = href.split("/").map(decodeURIComponent).join("/");
    return /^attachments\/[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Changes only verified attachment links; no URL is inferred from report prose. */
export function embedReportAttachments(
  html: string,
  attachments: readonly EmbeddedReportAttachment[],
): string {
  const sources = new Map<string, string>();
  const previews = new Map<string, string>();
  for (const attachment of attachments) {
    if (
      attachmentPath(attachment.path) !== attachment.path ||
      !/^data:application\/octet-stream;base64,[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataUrl) ||
      sources.has(attachment.path)
    ) {
      throw new Error("The report contains an invalid attachment reference.");
    }
    sources.set(attachment.path, attachment.dataUrl);
    if (attachment.previewDataUrl !== undefined) {
      if (
        !/^data:(?:image\/(?:png|jpeg|webp)|video\/webm);base64,[A-Za-z0-9+/]*={0,2}$/.test(
          attachment.previewDataUrl,
        ) ||
        attachment.previewDataUrl.slice(attachment.previewDataUrl.indexOf(",") + 1) !==
          attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1)
      ) {
        throw new Error("The report contains an invalid attachment preview.");
      }
      previews.set(attachment.path, attachment.previewDataUrl);
    }
  }
  const linked = new Set<string>();
  const result = html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2([^>]*>)/gi,
    (match, prefix: string, quote: string, href: string, tail: string) => {
      const path = attachmentPath(href);
      const source = path === undefined ? undefined : sources.get(path);
      if (source === undefined || path === undefined) return match;
      linked.add(path);
      const name = path.split("/").at(-1) ?? "attachment";
      const attributes = /\sdownload(?:\s|=|>)/i.test(tail)
        ? tail.replace(/\sdownload(?=[\s>])/i, ` download="${name}"`)
        : ` download="${name}"${tail}`;
      return `${prefix}${quote}${source}${quote}${attributes}`;
    },
  );
  if (linked.size !== sources.size) throw new Error("The report is missing a verified attachment link.");
  return result.replace(/<(img|video)\b[^>]*>/gi, (tag, element: string) => {
    const marker = /\sdata-attachment-preview\s*=\s*(["'])(image|video)\1/i.exec(tag);
    if (marker === null) return tag;
    const source = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    const path = source?.[2] === undefined ? undefined : attachmentPath(source[2]);
    const preview = path === undefined ? undefined : previews.get(path);
    const kind = marker[2]?.toLowerCase();
    if (
      preview === undefined ||
      (element.toLowerCase() === "img"
        ? kind !== "image" || !preview.startsWith("data:image/")
        : kind !== "video" || !preview.startsWith("data:video/webm;"))
    ) {
      throw new Error("The report contains an invalid attachment preview.");
    }
    return tag.replace(/(\ssrc\s*=\s*)(["'])(.*?)\2/i, `$1"${preview}"`);
  });
}

export function attachmentDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}
