# Logs, screenshots, and recordings

[Developer guide](README.md) · [SDK](../packages/sdk/README.md)

Capture adds supporting evidence to a drill result. It does not replace checks
on the world's state or tool calls. A non-visual agent needs no screenshot or
video; use logs or file attachments where they help explain a failure.

## Choose what to keep

Configure capture in the test code that calls `runDrills()`:

The examples with an `agent` callback require the drill's target to declare
`kind: external`. A command or module target runs its own declared entry point
instead. [Choose the target matching your agent](quickstart.md#3-keep-the-agent-integration-at-one-seam).

```ts
const result = await runDrills({
  drill: "my-drill",
  capture: {
    logs: "always",
    screenshots: "retain-on-failure",
    video: "retain-on-failure",
    files: "off",
  },
  agent: async ({ task, binding, signal, capture }) => {
    capture.log("Starting the agent with synthetic tools");
    const response = await runExistingAgent({ task, binding, signal });
    capture.log("Agent finished; world checks run next");
    return response;
  },
});
```

| Policy | Behavior |
| --- | --- |
| `off` | No optional capture for this category. The default. |
| `always` | Keep captured files for both passing and non-passing attempts. |
| `retain-on-failure` | Keep files only when the attempt does not finish with a sealed, passing result. |

Retention is decided **after the final checks**, separately for each retry.
An agent can return normally and still fail a state assertion; its failure
capture is retained. A retry that passes does not erase the failed attempt.
Cancelled, failed, and inconclusive attempts retain failure capture too.

These are SDK options, not fields in a `.drill.yaml` file or CLI capture flags.
Module test adapters can access `context.capture` when invoked through this SDK.
For command/HTTP targets, the SDK's `hooks.attemptStarted` also provides a capture
handle for the caller-owned harness. The CLI/inspector do not automatically
record an arbitrary browser or desktop.

## Logs and existing files

`capture.log(message)` stores bounded text from your test or an existing logger
callback. Firedrill does not replace global `console` methods, so concurrent
agents cannot accidentally capture one another's process output.

Command targets already record bounded stderr as execution evidence. Enabling
`capture.logs` adds an optional copy; switching it off does not remove that
original evidence. Command stdout remains the single JSON result, not a log stream.

For files your harness has already produced:

```ts
capture.screenshot({ path: ".firedrill/capture/screen.png", mediaType: "image/png" });
capture.video({ path: ".firedrill/capture/session.webm", mediaType: "video/webm" });
capture.file({ path: ".firedrill/capture/trace.zip", mediaType: "application/zip" });
```

These functions copy an existing file; they do not take a screenshot or start a
recorder. Enable the matching category. `capture.file` uses the `files` policy
even when the file happens to be an image. Existing `attach()` remains supported
and always retains the attached file, independently of capture policies.

Paths are relative to the project root and must resolve to regular files inside
that root, without symlink path components. Files are copied immediately. Later
editing or deleting the original does not change the retained copy.

## Capture from a browser driver

Your test harness still launches and drives the browser. Register callbacks so
Firedrill can take the final screenshot before closing the context to finish its
recording. For Playwright, set `recordVideo` when creating the context; the video
is finalized when that context closes. See [Playwright's video lifecycle](https://playwright.dev/docs/videos).

The [small Playwright helper](examples/playwright-capture.mjs) uses only public
Firedrill callbacks and your existing Playwright instance. It is test support,
not code to add to the production agent:

```ts
import { chromium } from "playwright";
import { runDrills } from "@firedrill-tools/sdk";
import { createCapturedPage } from "./test-support/playwright-capture.mjs";

const browser = await chromium.launch();
try {
  const result = await runDrills({
    root: process.cwd(),
    drill: "my-ui-drill",
    capture: { logs: "always", screenshots: "always", video: "retain-on-failure" },
    agent: async (invocation) => {
      const page = await createCapturedPage(browser, invocation, process.cwd());
      // Your existing test adapter starts/drives the actual app and supplies
      // invocation.binding.environment at its normal configurable tool seam.
      return driveExistingAgentUi(page, invocation);
    },
  });
  if (result.verdict !== "passed") throw new Error("Agent drill failed");
} finally {
  await browser.close();
}
```

Copy the helper into `test-support/` and supply your application's real
`driveExistingAgentUi` adapter. Keep the context open when that function returns:
Firedrill runs final checks and capture callbacks next. The outer `finally` also
closes the browser if setup or execution fails. Your browser package and browser
binaries are your test dependencies; Firedrill does not install or own them.

When every capture policy is off, no driver callbacks run. The example's outer
`browser.close()` still releases its contexts. For a large suite with capture
disabled, use your browser test runner's normal per-test context cleanup.

Use `registerDriver({ screenshot, startVideo, stopVideo, dispose })` for another
driver. All callbacks are optional. `startVideo` runs during registration;
end-of-attempt screenshot precedes `stopVideo`, then `dispose` releases resources.
Callbacks receive a deadline signal and must cooperate with cancellation.
JavaScript that ignores that signal cannot be forcibly stopped. The default
callback deadline is 5 seconds, configurable with `capture.driverTimeoutMs`
up to 60 seconds. Capture problems appear in the report without changing the
agent's behavioral verdict.

## Where to view and store capture

Open a run's **Attachments** section in the inspector or HTML report. Images,
WebM recordings, plain text, and JSON have previews; other supported files are
download-only. HTML, archives, and executable-looking content are never rendered
as an interactive page. Downloads preserve the original bytes.

Retained copies live under `.firedrill/reports/<run-id>/attachments/` and are
included in report integrity verification. Keep this folder with a copied HTML
report. The inspector embeds verified attachments when opening its portable
report copy. Capture metadata is separate from synthetic world state; resetting
the world does not delete an already saved report.

Capture does **not** delete caller-owned originals. The helper writes raw media
under the ignored `.firedrill/capture/` folder, including videos of passing runs
that were not retained in the report. Your harness can clean up its own temporary
files after `runDrills()` returns. Never commit captures by accident.

## Limits and sensitive content

Capture and manual attachments share a limit of 32 files and 128 MiB per attempt;
each file is at most 64 MiB. Optional capture staging is bounded to 256 MiB per
SDK invocation. Logs are bounded to 1 MiB/4,096 messages per attempt and 16 KiB
per explicit log message. At most eight drivers may register for one attempt.
Exceeding a capture limit records an error rather than claiming the evidence exists.

File types accepted for storage are JSON, ZIP, PNG, JPEG, WebP, plain text, HTML,
and WebM. Previewing additionally requires a safe type and matching media bytes.
Large text previews are truncated visibly; download retains the complete file.

Captured text and media are copied verbatim. They may contain credentials,
customer content, prompts, or personal information. Redact before capturing and
set `redaction: { status: "applied_by_caller" }` only when you actually did so.
Selecting failure-only retention is not a redaction mechanism.
