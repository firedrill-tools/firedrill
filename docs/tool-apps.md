# Tools with an app

A synthetic Tool can offer a backend, a browser app, or both. The app is a usable
interface to that Tool—not a screenshot, a separate dataset, or an inspector
page. Its buttons call the same operations your agent calls. Changes are stored
in the same local world and appear in activity and state assertions.

## Open an installed app

Select a Tool pack as usual, then run `firedrill serve`. The command starts its
backend and any declared app on local ports. **Tools → Open app** in the inspector
opens that Tool's app. The terminal also prints each app link. No account, Docker,
extra frontend server, or drill definition is needed.

The maintained Mailbox pack provides inbox/draft/sent/archive views, reading,
composing, draft saving, sending, and deletion. Sending only moves a synthetic
message to Sent; it never delivers real email. The Object storage pack provides
bucket/prefix browsing, text-object reading, creation, replacement, and deletion.
Both paginate their lists and confirm deletion. These are bounded semantic tools,
not full replicas of commercial services. Their READMEs document precise limits.

Backend-only packs keep working without an app. An app does not replace HTTP,
MCP, CLI, or test-side function bindings.

## Add your own UI

Keep the Tool's declaration and behavior. Add an optional `ui` field at the top
level of its `.tool.json` or `.tool.yaml` declaration:

```json
{
  "ui": { "root": "app", "entry": "index.html" }
}
```

Merge that field into the existing declaration; keep its `schemaVersion`,
`module`, and complete `manifest`. `root` is relative to the declaration, inside the source
root or installed package. `entry` defaults to `index.html`. Use plain HTML,
CSS, and JavaScript, or your preferred frontend's static build output. Server-side
rendering and a separate package-owned Node server are not part of this contract.

```text
firedrill/tools/my-tool/
  my-tool.tool.json
  behavior.mjs
  app/
    index.html
    app.js
    styles.css
```

Load scripts and styles from separate local files. A runtime-provided browser
module connects the app to its own Tool:

```js
import { getContext, invoke } from "/_firedrill/client.js";

const context = await getContext(); // actor, Tool, world id, revision
const result = await invoke("records.get", { id: "record-1" });
if (result.outcome.status === "ok") {
  // Render result.outcome.value using normal safe DOM or component rendering.
}
```

Use operation IDs declared by your Tool. This is the same semantic outcome as
other bindings, including permission refusal, validation errors, faults, and Tool
errors. For a mutation, provide `{ idempotencyKey: crypto.randomUUID() }` as the
third argument. Reuse that key when retrying the *same* uncertain action; create
a new key for a new action. The helper does not silently retry mutations.

`getContext()` is read-only. Its `revision` lets an app refresh after changes
without repeatedly loading records. Do not overwrite a user's unsaved form when
refreshing. Use version checks in Tool operations to reject stale edits.

## Shared state, separate authority

Each app gets its own loopback origin and a credential scoped to one Tool and the
selected actor. Opening an app cannot grant extra permissions, change actors, read
raw SQLite, reset the world, or control the inspector. A backend-only Tool can
still participate in the same world. Cross-Tool consequences belong in declared
behavior and event contracts, not privileged browser calls.

App links contain short-lived local credentials in their URL fragment. The helper
removes the fragment before making requests and keeps the credential in that
tab's session storage for reloads. Do not commit, publish, or share the original
links. Closing the environment closes its app listeners. Full reset restores the
world's baseline while keeping active connections usable; it does not delete
saved reports or change source files.

The compiler copies exact app assets into the immutable build and verifies their
hashes when loading it. Editing source does not silently change a running app;
restart `serve` to compile the new version. `tool inspect` includes the UI asset
manifest and source closure. Community contribution bundles include those exact
assets and retain source/credential checks.

Supported assets are bounded HTML, CSS, JavaScript, JSON, images, and fonts. The
limits are 256 files, 4 MiB per file, and 16 MiB per app. Hidden files, symlinks,
credential-like paths, dependency folders, path escapes, and the reserved
`_firedrill/` directory are rejected. Bundle dependencies and fonts locally;
inline scripts/styles, external resources, frames, workers, and remote requests
are blocked by the serving policy. Tool code is still trusted local code—these
browser restrictions are not an OS sandbox for package behavior.

## Browser agents and testing

You can open the app yourself or drive it with browser automation. Browser
interaction produces ordinary Tool operations, state changes, and evidence.
During `runDrills`, the target callback receives `binding.apps`, an array of
`{ packageId, title, url }` for that interaction's Tool apps. Command targets
receive the same array as JSON in `FIREDRILL_TOOL_APPS`. Use the selected URL in
your test-owned browser launch/configuration; do not hardcode a port or edit the
production agent. Each attempt gets fresh credentials and closes its listeners
when the interaction ends, including failure or timeout. Standalone SDK callers
get the same `apps` array from `world.listen()` and own its lifetime.

Use the existing [browser-test package](../packages/browser-tests/README.md) or
your own Playwright harness. Optional screenshots, recordings, and logs use the
normal [capture API](capture.md). A successful page click alone is not proof that
your agent passed: assert the intended state and behavior in a drill.

Inline target results and diagnostics redact issued app credentials. Caller-added
attachments are still verbatim data: do not attach files containing credentials,
and use the capture/redaction controls when recording your own browser or logs.
