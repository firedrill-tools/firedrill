interface EmbeddedReportAttachment {
  readonly path: string;
  readonly dataUrl: string;
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
  for (const attachment of attachments) {
    if (
      attachmentPath(attachment.path) !== attachment.path ||
      !/^data:application\/octet-stream;base64,[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataUrl) ||
      sources.has(attachment.path)
    ) {
      throw new Error("The report contains an invalid attachment reference.");
    }
    sources.set(attachment.path, attachment.dataUrl);
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
  return result;
}

export function attachmentDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}
