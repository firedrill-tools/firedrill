import { z } from "zod";

const text = z.string().min(1).max(4000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
export const BrowserSelectorSchema = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("role"),
      role: z.enum([
        "button",
        "link",
        "textbox",
        "checkbox",
        "radio",
        "combobox",
        "option",
        "heading",
        "alert",
        "status",
        "tab",
        "menuitem",
      ]),
      name: text,
    })
    .strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
  z.object({ by: z.literal("testId"), value: text }).strict(),
  z.object({ by: z.literal("css"), value: text }).strict(),
]);
export const BrowserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: text }).strict(),
  z.object({ action: z.literal("click"), selector: BrowserSelectorSchema }).strict(),
  z
    .object({
      action: z.literal("fill"),
      selector: BrowserSelectorSchema,
      value: z.string().max(20000).optional(),
      parameter: id.optional(),
    })
    .strict()
    .refine((value) => (value.value === undefined) !== (value.parameter === undefined), {
      message: "fill needs exactly one value or parameter",
    }),
  z
    .object({ action: z.literal("press"), selector: BrowserSelectorSchema, key: z.string().min(1).max(80) })
    .strict(),
  z.object({ action: z.literal("wait"), milliseconds: z.number().int().min(0).max(10000) }).strict(),
]);
export const BrowserAssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("visible"),
      selector: BrowserSelectorSchema,
      expected: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("text"),
      selector: BrowserSelectorSchema,
      expected: z.string().max(20000),
      contains: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("value"),
      selector: BrowserSelectorSchema,
      expected: z.string().max(20000),
    })
    .strict(),
  z.object({ id, kind: z.literal("url"), expected: text }).strict(),
]);
export const BrowserTestDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    title: z.string().min(1).max(200).optional(),
    startUrl: z.string().url().max(4000),
    task: z.string().min(1).max(20000).optional(),
    steps: z.array(BrowserStepSchema).max(500).default([]),
    assertions: z.array(BrowserAssertionSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, assertion] of value.assertions.entries()) {
      if (ids.has(assertion.id))
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "id"],
          message: "assertion IDs must be unique",
        });
      ids.add(assertion.id);
    }
  });
export type BrowserSelector = z.infer<typeof BrowserSelectorSchema>;
export type BrowserStep = z.infer<typeof BrowserStepSchema>;
export type BrowserAssertion = z.infer<typeof BrowserAssertionSchema>;
export type BrowserTestDefinition = z.infer<typeof BrowserTestDefinitionSchema>;
export type BrowserTestDefinitionInput = z.input<typeof BrowserTestDefinitionSchema>;
export const ASSERTION_DIAGNOSTIC_LIMIT = 8000;
export interface BrowserAssertionResult {
  readonly id: string;
  readonly kind: BrowserAssertion["kind"];
  readonly passed: boolean;
  readonly expected: string | boolean;
  readonly actual: string | boolean | null;
  /** Present when the retained, redacted diagnostic is only a prefix. Comparison uses full values. */
  readonly expectedTruncation?: { readonly fullLength: number } | undefined;
  readonly actualTruncation?: { readonly fullLength: number } | undefined;
}
export interface BrowserTestArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface BrowserTestEvent {
  readonly sequence: number;
  readonly type: "started" | "step" | "assertion" | "log" | "blocked-request" | "finished";
  readonly message: string;
  readonly elapsedMs: number;
}
export interface BrowserTestResult {
  readonly schemaVersion: 1;
  readonly kind: "browser-test";
  readonly runId: string;
  readonly definition: BrowserTestDefinition;
  readonly status: "passed" | "failed" | "completed" | "cancelled";
  readonly worldVerified: false;
  /** False when privacy redaction changed execution meaning or execution stopped early. */
  readonly replayable: boolean;
  /** Safe source locations requiring review; never includes original sensitive values. */
  readonly replayIssues: readonly string[];
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly BrowserStep[];
  readonly assertions: readonly BrowserAssertionResult[];
  readonly events: readonly BrowserTestEvent[];
  readonly errors: readonly { readonly code: string; readonly message: string }[];
  readonly artifacts: readonly BrowserTestArtifact[];
  readonly reportDirectory: string;
  readonly reportPath: string;
}
export class BrowserTestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserTestError";
  }
}
