import { z } from "zod";
import { type RunIdSchema, StableIdSchema } from "./identifiers.js";
import { TargetFileAttachmentSchema } from "./target.js";

export const CapturePolicySchema = z.enum(["off", "always", "retain-on-failure"]);
export const CaptureKindSchema = z.enum(["log", "screenshot", "video", "file"]);
export const CapturePoliciesSchema = z
  .object({
    logs: CapturePolicySchema,
    screenshots: CapturePolicySchema,
    video: CapturePolicySchema,
    files: CapturePolicySchema,
  })
  .strict();
export const RunCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    policies: CapturePoliciesSchema,
    attachments: z
      .array(
        z
          .object({
            kind: CaptureKindSchema,
            policy: z.enum(["always", "retain-on-failure"]),
            interactionId: StableIdSchema.optional(),
            attachment: TargetFileAttachmentSchema,
          })
          .strict(),
      )
      .max(32),
    errors: z
      .array(
        z
          .object({
            code: z
              .string()
              .regex(/^capture\.[A-Z_]+$/)
              .max(100),
            message: z.string().min(1).max(500),
            kind: CaptureKindSchema.optional(),
            interactionId: StableIdSchema.optional(),
          })
          .strict(),
      )
      .max(256),
    discarded: z
      .object({
        logs: z.number().int().nonnegative().safe(),
        screenshots: z.number().int().nonnegative().safe(),
        video: z.number().int().nonnegative().safe(),
        files: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict()
  .superRefine((capture, context) => {
    const ids = new Set<string>();
    let bytes = 0;
    for (const [index, item] of capture.attachments.entries()) {
      const category =
        item.kind === "log"
          ? "logs"
          : item.kind === "screenshot"
            ? "screenshots"
            : item.kind === "file"
              ? "files"
              : "video";
      if (item.policy !== capture.policies[category])
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "policy"],
          message: "retained capture policy must match its category policy",
        });
      if (ids.has(item.attachment.id))
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "attachment", "id"],
          message: "capture attachment IDs must be unique",
        });
      ids.add(item.attachment.id);
      bytes += item.attachment.bytes;
      const mediaType = item.attachment.mediaType;
      if (
        (item.kind === "log" && mediaType !== "text/plain") ||
        (item.kind === "screenshot" && !["image/png", "image/jpeg", "image/webp"].includes(mediaType)) ||
        (item.kind === "video" && mediaType !== "video/webm")
      )
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "attachment", "mediaType"],
          message: "capture media type does not match its kind",
        });
    }
    if (bytes > 128 * 1024 * 1024)
      context.addIssue({
        code: "custom",
        path: ["attachments"],
        message: "capture attachments cannot exceed 128 MiB",
      });
  });

export type CapturePolicy = z.infer<typeof CapturePolicySchema>;
export type CaptureKind = z.infer<typeof CaptureKindSchema>;
export type CapturePolicies = z.infer<typeof CapturePoliciesSchema>;
export type RunCapture = z.infer<typeof RunCaptureSchema>;

/** Runtime-only input. Bytes are copied verbatim; caller files are never removed. */
export interface CaptureFileInput {
  readonly path: string;
  readonly name?: string;
  readonly mediaType: string;
  readonly redaction?: { readonly status: "not_applied" | "applied_by_caller"; readonly note?: string };
}
export interface CaptureDriverContext {
  readonly runId: z.infer<typeof RunIdSchema>;
  readonly interactionId?: z.infer<typeof StableIdSchema>;
  /** Hook-local deadline. Drivers must cooperate; arbitrary JavaScript cannot be forcibly stopped. */
  readonly signal: AbortSignal;
}
/** Caller-owned browser or application driver. Firedrill never creates or closes the browser itself. */
export interface CaptureDriver {
  readonly screenshot?: (context: CaptureDriverContext) => CaptureFileInput | Promise<CaptureFileInput>;
  readonly startVideo?: (context: CaptureDriverContext) => void | Promise<void>;
  readonly stopVideo?: (
    context: CaptureDriverContext,
  ) => CaptureFileInput | undefined | Promise<CaptureFileInput | undefined>;
  readonly dispose?: (context: CaptureDriverContext) => void | Promise<void>;
}
export interface RunCaptureHandle {
  readonly policies: Readonly<CapturePolicies>;
  /** Bounded, verbatim text. No global console interception or automatic secret redaction. */
  readonly log: (message: string) => void;
  readonly file: (input: CaptureFileInput) => void;
  /** Register an already captured image; use registerDriver for automatic end-of-attempt capture. */
  readonly screenshot: (input: CaptureFileInput) => void;
  /** Register an already recorded WebM file. */
  readonly video: (input: CaptureFileInput) => void;
  readonly registerDriver: (driver: CaptureDriver) => Promise<void>;
}
