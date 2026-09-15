import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { MAX_TOOL_UI_ASSET_BYTES } from "@firedrill/contracts";
import { type PackageLock, sha256Text } from "@firedrill/world-ir";
import type { LoadedToolUi } from "./types.js";

/** Read every static byte before importing any behavior module. */
export function loadToolUis(root: string, lock: PackageLock): readonly LoadedToolUi[] {
  const maximumBytes = 256 * 1024 * 1024;
  let total = 0;
  return lock.packages.flatMap((tool) => {
    if (tool.ui === undefined) return [];
    return [
      {
        packageId: tool.packageId,
        entry: tool.ui.entry,
        assets: tool.ui.assets.map((asset) => {
          let parent = root;
          for (const segment of asset.artifactPath.split("/").slice(0, -1)) {
            parent = join(parent, segment);
            if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
              throw new Error("UI artifact parent must be a directory without symlinks");
          }
          const path = join(root, ...asset.artifactPath.split("/"));
          if (realpathSync(path) !== path) throw new Error("UI artifact resolves through a symlink");
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const metadata = fstatSync(fd);
            if (
              !metadata.isFile() ||
              metadata.size !== asset.bytes ||
              metadata.size > MAX_TOOL_UI_ASSET_BYTES ||
              metadata.size > maximumBytes - total
            )
              throw new Error("UI artifact size differs from its lock or exceeds the build safety bound");
            const bounded = Buffer.alloc(asset.bytes + 1);
            let length = 0;
            while (length < bounded.length) {
              const count = readSync(fd, bounded, length, bounded.length - length, null);
              if (count === 0) break;
              length += count;
            }
            bytes = bounded.subarray(0, length);
          } finally {
            closeSync(fd);
          }
          total += bytes.length;
          if (
            bytes.length !== asset.bytes ||
            sha256Text(bytes) !== asset.artifactHash ||
            total > maximumBytes
          )
            throw new Error("UI artifact bytes/hash differ from the package lock");
          return { path: asset.path, mediaType: asset.mediaType, artifactHash: asset.artifactHash, bytes };
        }),
      },
    ];
  });
}
