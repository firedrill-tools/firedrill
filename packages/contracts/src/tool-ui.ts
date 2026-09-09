import { z } from "zod";

export const MAX_TOOL_UI_ASSETS = 256;
export const MAX_TOOL_UI_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_UI_BYTES = 16 * 1024 * 1024;

const MEDIA_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
} as const;

export const ToolUiMediaTypeSchema = z.enum(Object.values(MEDIA_TYPES));
export function toolUiMediaType(path: string): z.infer<typeof ToolUiMediaTypeSchema> | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension !== undefined && Object.hasOwn(MEDIA_TYPES, extension)
    ? MEDIA_TYPES[extension as keyof typeof MEDIA_TYPES]
    : undefined;
}

/** Portable URL/file names only; no hidden source, credentials or runtime-reserved paths. */
export const ToolUiPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (part) =>
            part !== "node_modules" &&
            part !== "_firedrill" &&
            !/(?:^|[-_.])(?:secrets?|credentials?|passwords?|tokens?|private[-_]key|keyfile)(?:[-_.]|$)/i.test(
              part,
            ),
        ),
    "UI paths must not contain hidden, credential, dependency or reserved runtime files",
  );

export const ToolUiSourceSchema = z
  .object({
    root: ToolUiPathSchema,
    entry: ToolUiPathSchema.refine(
      (path) => path.toLowerCase().endsWith(".html"),
      "UI entry must be an HTML asset",
    ).default("index.html"),
  })
  .strict();

export type ToolUiSource = z.infer<typeof ToolUiSourceSchema>;
