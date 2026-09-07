import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { TargetFileAttachment } from "@firedrill/contracts";

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const CHANGED_MESSAGE = "report attachment does not match its recorded bytes";

/** Read one bounded snapshot from a regular file descriptor, never following a final symlink. */
export function readAttachmentBytes(attachment: TargetFileAttachment, path: string): Buffer {
  try {
    if (
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0 ||
      attachment.bytes > MAX_ATTACHMENT_BYTES
    )
      throw new TypeError(CHANGED_MESSAGE);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== attachment.bytes) throw new TypeError(CHANGED_MESSAGE);
      const body = Buffer.alloc(attachment.bytes);
      let offset = 0;
      while (offset < body.length) {
        const count = readSync(fd, body, offset, body.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const extra = readSync(fd, Buffer.alloc(1), 0, 1, body.length);
      const after = fstatSync(fd);
      if (
        offset !== body.length ||
        extra !== 0 ||
        !after.isFile() ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        `sha256:${createHash("sha256").update(body).digest("hex")}` !== attachment.hash
      )
        throw new TypeError(CHANGED_MESSAGE);
      return body;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new TypeError(CHANGED_MESSAGE);
  }
}
