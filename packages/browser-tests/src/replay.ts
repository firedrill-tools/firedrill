import {
  type BrowserTestDefinition,
  BrowserTestDefinitionSchema,
  BrowserTestError,
  type BrowserTestResult,
} from "./contracts.js";

/** Compare execution meaning, not display titles. Fill literals are already parameterized. */
export function recordedReplayIssues(
  recorded: BrowserTestDefinition,
  redacted: BrowserTestDefinition,
): readonly string[] {
  const issues: string[] = [];
  const compare = (path: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after) && issues.length < 99)
      issues.push(`${path}: privacy redaction changed a value needed to repeat this flow.`);
  };
  // Redaction serializes absolute URLs through URL, which also canonicalizes
  // harmless spelling differences (for example an omitted trailing slash).
  const normalizedUrl = (value: string) => {
    try {
      return new URL(value, recorded.startUrl).href;
    } catch {
      return value;
    }
  };
  compare("startUrl", normalizedUrl(recorded.startUrl), normalizedUrl(redacted.startUrl));
  compare("task", recorded.task, redacted.task);
  for (const [index, step] of recorded.steps.entries()) {
    const after = redacted.steps[index];
    compare(
      `steps[${index}]`,
      step.action === "navigate" ? { ...step, url: normalizedUrl(step.url) } : step,
      after?.action === "navigate" ? { ...after, url: normalizedUrl(after.url) } : after,
    );
  }
  for (const [index, assertion] of recorded.assertions.entries())
    compare(`assertions[${index}]`, assertion, redacted.assertions[index]);
  return issues;
}

/** Derive reusable source only when its recorded execution meaning survived redaction. */
export function browserTestDefinitionFromResult(options: {
  readonly result: BrowserTestResult;
  readonly id?: string;
  readonly title?: string;
}): BrowserTestDefinition {
  const { result } = options;
  if (result.replayable !== true || result.replayIssues.length !== 0)
    throw new BrowserTestError(
      "browser.REPLAY_REVIEW_REQUIRED",
      "This recorded flow needs review: privacy redaction changed execution fields, or execution stopped before the flow was complete. Review replayIssues and the redacted test.browser.json in the report, correct the affected source with safe test values, and save the corrected definition. The original result remains valid evidence.",
    );
  return BrowserTestDefinitionSchema.parse({
    ...result.definition,
    steps: result.steps,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.title === undefined ? {} : { title: options.title }),
  });
}
