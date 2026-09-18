# Optional browser tests

Use a browser test when the application or agent you want to exercise has a UI.
Firedrill opens a fresh Playwright Chromium context, follows explicit steps, and
checks the visible result. Existing headless agents need none of this.

Packages are pre-release and published under the `@firedrill-run` npm scope.
Install the package and matching browser once:

```sh
pnpm add -D @firedrill-run/browser-tests@next
pnpm dlx playwright@1.62.1 install chromium
```

From a framework checkout, use `pnpm --filter @firedrill-run/browser-tests exec playwright install chromium`.
Browser binaries are not downloaded when installing Firedrill packages.

For a packed consumer, install Chromium with
`pnpm dlx playwright@1.62.1 install chromium`. The explicit version matches this
package. A transitive Playwright dependency does not expose its command in the
consumer's `node_modules/.bin`, so plain `pnpm exec playwright` is not sufficient.

```ts
import { runBrowserTest } from "@firedrill-run/browser-tests";

const result = await runBrowserTest({
  definition: {
    schemaVersion: 1,
    id: "send-message",
    startUrl: "http://127.0.0.1:3000",
    steps: [
      { action: "fill", selector: { by: "label", value: "Message" }, parameter: "message" },
      { action: "click", selector: { by: "role", role: "button", name: "Send" } },
    ],
    assertions: [
      { id: "reply-visible", kind: "visible", selector: { by: "testId", value: "reply" } },
    ],
  },
  parameters: { message: "Summarize my recent messages" },
});

console.log(result.status, result.reportPath);
```

This example is a test-side harness; it does not modify the application. Start
the application yourself, using its existing configuration to point its tools
at a Firedrill environment. For world-state assertions, call this helper inside
the `runDrills({ agent })` callback and use the same binding for your application.
The browser result checks the UI; the drill verifies synthetic-world consequences.
Neither result substitutes for the other.

## Definitions and results

Save reusable source as `firedrill/browser-tests/<name>.browser.json` with
`saveBrowserTest({ definition })`; `loadBrowserTest({ path })` reads and validates it.
Both accept an optional project `root`. Saving never overwrites a file. You can
edit JSON with your editor or coding agent.

`listBrowserTests({ root, offset: 0, limit: 20 })` lists the default source folder;
`listBrowserTestReports` lists local report history with the same pagination.
Both accept an explicit `directory`. Invalid definitions and partial or changed
reports produce diagnostics instead of being presented as usable tests or results.
Browser definitions are separate from world resource files; their `.browser.json`
suffix is not compiled as a Tool, scenario, target or drill.

Every run writes `.firedrill/browser/<run-id>/index.html`, `report.json`,
`test.browser.json`, a hash manifest, and selected artifacts. Keep `.firedrill/`
ignored by Git. `verifyBrowserTestReport(directory)` verifies retained file bytes;
these local reports are unsigned and do not prove authorship.

`bundleBrowserTestReport(directory)` returns a complete `.tar.gz` archive after
copying and verifying every retained file. Extract it and open `index.html` inside
the run folder; screenshots and downloads remain usable without a server. The
inspector's **Download report** action downloads this complete bundle, not an HTML
file with missing attachments.

- `passed`: all explicitly configured browser assertions passed.
- `failed`: a browser action, policy, deadline or assertion failed.
- `completed`: the flow finished but no independent assertions were configured.

Assertions compare complete browser values. For large text, reports retain only
the first 8,000 characters after privacy redaction, with explicit truncation and
full-length metadata; shortening the displayed diagnostic never changes the
comparison result. Assertions that execution did not reach are shown as **Not
evaluated**, not as unconfigured or passing.
- `cancelled`: the caller stopped execution.

All results say `worldVerified: false`. A browser screenshot is not proof of a
correct refund, email, or other action. Add a drill's world assertions for that.

Selectors support roles/names, labels, visible text, test IDs, or CSS. Steps
support navigation, click, fill, key press and bounded wait. Assertions check
visibility, text, input value, or exact URL. Assertions retry until the step
deadline; they do not trust the browser agent's summary.

## Optional task-driven browser agent

`@firedrill-run/agent/browser` provides `runBrowserAgentTest` with the Claude Agent
SDK and your `ANTHROPIC_API_KEY`. Supply a `definition.task` instead of recorded
steps. The model only receives bounded browser tools and cannot edit your code,
open a shell or access the repository. Page content sent to Anthropic can contain
application data; explicitly authorize model use and use synthetic accounts.

The driver records successful actions into `test.browser.json`. Rerun that file
through `runBrowserTest` without paying for another model-driven exploration.
Fill values are converted to named runtime parameters; supply them when replaying.
Review recorded steps before saving them as source. A task without explicit
assertions is **completed**, never **passed**, regardless of what the model says.

Use `browserTestDefinitionFromResult({ result, id: "reusable-flow" })` before
`saveBrowserTest`. The helper refuses source when `replayable` is false: privacy
redaction changed a selector, expected value, task or URL, or execution stopped
before the complete flow was recorded. `replayIssues` explains what to review
without exposing the removed values. The original observation remains valid;
correct the redacted source with safe test data before reusing it. An ordinary
assertion failure with a fully recorded flow can still be reproduced.

`createBrowserAgentDriver()` is available for caller-composed runners. Other
drivers can implement the small `BrowserTestDriver` callback; they use the same
bounded `observe()` and `step()` methods and cannot define verdicts.

## Scope and safety

Defaults: loopback application only, headless browser, 120-second deadline,
5 seconds per action/assertion, 100 actions, screenshots always, video/trace off.
Use `headless: false` to watch. `onEvent` receives ordered status/action/check events;
optional `onFrame` receives ephemeral JPEG previews. Pass an `AbortSignal` to stop.

Only the starting origin and explicit `allowedOrigins` may receive browser
requests. Any remote origin also requires `allowRemote: true`. This is consent
to exercise those applications, not proof that they are non-production. Requests
to other origins fail closed, service workers are blocked, and popups are closed.
An authenticated, temporary loopback proxy streams responses without buffering;
SSE and WebSocket updates remain live. Redirect destinations are checked again,
including subrequests and encrypted CONNECT tunnels. Browser traffic uses HTTP/1.1
so a single HTTP/2 connection cannot coalesce unapproved origins. Multi-tab and
arbitrary scripts are not supported by the declarative driver. These browser
controls are not an OS/network security sandbox for hostile applications or
arbitrary trusted driver code.

Runtime `parameters` are not saved. Fill values and known parameter values are
redacted from text outputs; filled fields and password inputs are masked in
screenshots/previews. This cannot redact arbitrary application text. Opt-in
videos and Playwright traces can contain sensitive DOM, screenshots and network
information. Keep them local, review before sharing, and use synthetic credentials.
No browser profile, cookie jar, or authenticated personal browser is imported.

`capture.screenshot`, `capture.video`, and `capture.trace` accept `off`, `always`,
or `retain-on-failure`. Failed captures do not change the browser assertion verdict.
Report files are bounded; caller files are never deleted.

The local inspector exposes **Browser tests** when this optional package is
installed. Run a saved definition or explicitly enable the model-driven path,
watch events/preview, cancel, inspect assertions and artifacts, and save recorded
steps to a new source file. Only one browser test runs at a time in an inspector.
The host terminal supplies the model key; the browser cannot submit API keys or
override the host environment. Model use requires explicit approval for each run.
