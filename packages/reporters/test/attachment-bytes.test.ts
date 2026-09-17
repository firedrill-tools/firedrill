import { createHash } from "node:crypto";
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetFileAttachment } from "@firedrill-tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttachmentBytes } from "../src/attachment-bytes.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(body = Buffer.from("recorded bytes")) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-attachment-read-"));
  directories.push(directory);
  const path = join(directory, "capture.txt");
  writeFileSync(path, body);
  const attachment: TargetFileAttachment = {
    schemaVersion: 1,
    kind: "file",
    id: "attachment-read001",
    name: "capture.txt",
    mediaType: "text/plain",
    bytes: body.byteLength,
    hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    redaction: { status: "not_applied", note: null },
  };
  return { directory, path, attachment, body };
}

describe("bounded verified attachment reads", () => {
  it.each([Buffer.from("recorded bytes"), Buffer.alloc(0)])("reads the exact recorded bytes", (body) => {
    const input = fixture(body);
    expect(readAttachmentBytes(input.attachment, input.path)).toEqual(body);
  });

  it("rejects a symlink and a non-file without reading their contents", () => {
    const input = fixture();
    const link = join(input.directory, "link.txt");
    const directory = join(input.directory, "not-a-file");
    symlinkSync(input.path, link);
    mkdirSync(directory);
    for (const path of [link, directory, join(input.directory, "missing.txt")])
      expect(() => readAttachmentBytes(input.attachment, path)).toThrow(
        "report attachment does not match its recorded bytes",
      );
  });

  it.each(["recorded", "current"] as const)("rejects oversized %s size before reading", (kind) => {
    const input = fixture();
    const oversized = 64 * 1024 * 1024 + 1;
    truncateSync(input.path, oversized);
    const read = vi.spyOn(fs, "readSync");
    syncBuiltinESMExports();
    expect(() =>
      readAttachmentBytes(
        kind === "recorded" ? { ...input.attachment, bytes: oversized } : input.attachment,
        input.path,
      ),
    ).toThrow("report attachment does not match its recorded bytes");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects same-size content changes by hash", () => {
    const input = fixture();
    writeFileSync(input.path, Buffer.alloc(input.body.byteLength, "x"));
    expect(() => readAttachmentBytes(input.attachment, input.path)).toThrow(
      "report attachment does not match its recorded bytes",
    );
  });

  it.each(["growth", "truncation"] as const)(
    "rejects %s during the read and closes the descriptor",
    (kind) => {
      const input = fixture();
      const originalRead = fs.readSync;
      let previewFd: number | undefined;
      vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
        previewFd = args[0];
        const count = Reflect.apply(originalRead, fs, args) as number;
        if (kind === "growth") appendFileSync(input.path, "unrecorded growth");
        else truncateSync(input.path, 0);
        return count;
      });
      const close = vi.spyOn(fs, "closeSync");
      syncBuiltinESMExports();
      expect(() => readAttachmentBytes(input.attachment, input.path)).toThrow(
        "report attachment does not match its recorded bytes",
      );
      expect(previewFd).toBeDefined();
      expect(close.mock.calls.filter(([fd]) => fd === previewFd)).toHaveLength(1);
    },
  );

  it("keeps the opened snapshot when its path is replaced by a symlink", () => {
    const input = fixture();
    const replacement = join(input.directory, "replacement.txt");
    writeFileSync(replacement, "unrecorded replacement");
    const originalOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      const fd = Reflect.apply(originalOpen, fs, args) as number;
      renameSync(input.path, `${input.path}.original`);
      symlinkSync(replacement, input.path);
      return fd;
    });
    syncBuiltinESMExports();
    expect(readAttachmentBytes(input.attachment, input.path)).toEqual(input.body);
  });
});
