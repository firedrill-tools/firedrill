# Create a synthetic backend

Use this workflow when the user asks for fake tools, a local service, or realistic
starting conditions without yet asking for an agent test. Do not require drills,
targets, personas, or scenarios that the task does not need.

## Discover and author

1. Inspect the real tool signatures and existing dependency configuration. Capture
   inputs, outputs, errors, state transitions and side effects actually needed.
   A framework import alone does not prove which tools the agent uses.
2. Search available packs with `firedrill init --search <term> --json`. This is
   read-only. A catalog entry is not proof that a package is installed/published
   or compatible with the customer's exact client. Reuse a compatible, approved installed tool package with
   `firedrill tool add <package-name>`. This does not install packages or run their
   lifecycle scripts. Authors can own packages outside Firedrill's repository.
   `firedrill tool search <term> --json` supports an explicit independent
   `--index <path-or-url>`; no index is required to install a known source.
   For an explicitly approved npm, Git, or local package install,
   `firedrill tool add <source> --install` uses the package manager with scripts
   disabled. Never authorize an install merely because a matching name exists.
   Do not select a near-match while claiming full compatibility. Pack-authored
   starter records may populate a new world's repo-owned baseline; do not replace
   existing world records or expand existing actor grants silently.
3. Otherwise run `firedrill tool create <tool-id>` for a stateful starter, or add
   `--template stateless` for a pure response. Adapt the generated declaration and
   behavior module to the real interface. Read [authoring.md](authoring.md) for
   schemas, errors, events and permissions. A generated record store is scaffolding,
   not an automatically faithful model of the customer's service.
4. Put shared starting records and exact actor grants in the world file. Add a
   scenario only for a reusable variation: different records, permissions, faults,
   clock or scheduled events. Existing actor permissions are not expanded by tool
   setup; follow its explicit grant guidance.
5. Run `firedrill format` and `firedrill validate --json`, repairing diagnostics.

Tools can remember data and enforce behavior at the same time. Use declared
errors for expected failures, transactions for effects, virtual time for delays,
and events for cross-tool consequences. Backend-only means no provider UI is
needed; it does not mean a static response or an automatically cloned API.

If the user needs a tool's interactive app, add optional top-level
`ui: { root: "app", entry: "index.html" }` to that Tool declaration. Keep static
HTML/CSS/JS and bundled fonts/images in that declaration-relative directory.
Import `getContext` and `invoke` from `/_firedrill/client.js`; invoke only declared
operation IDs and render their canonical outcomes. UI actions must call the real
Tool behavior, not maintain a parallel fake database. Use stable idempotency keys
for mutation retries and confirm destructive actions. The runtime serves immutable
assets with a same-origin CSP: no inline scripts/styles or external dependencies.
Never expose an inspector/control token in app code. Do not add a UI to a backend
request that does not need one.

## Connect and verify

`firedrill serve --json` starts the baseline and returns actual local HTTP, MCP
and CLI connection variables. `--scenario <id>` selects named starting conditions;
`--actor <id>` selects one identity when multiple exist. It is a foreground process:
keep it alive while the customer's application uses the returned bindings. The
same startup returns the inspector URL for live tools, records and activity.
Its `apps` array contains live app links for selected UI-backed Tools; a Tool
without a UI has no app entry. Check UI changes through a second protocol and
check backend changes through the UI, not just whether a page renders. App links
are actor-scoped local credentials; do not commit them or put them in reports.
Human `serve` opens it automatically; `--no-open` leaves opening to the caller.
`inspect` alone browses source/results and must not be mistaken for a running
backend. Do not start a long-lived process from an agent tool that cannot retain
or safely stop it; give the developer the command in that case.

Firedrill Agent's `environment_check` checks source and listener startup, then
closes the probe. It does not execute guessed tool arguments or test the agent.
Use its structured readiness result, not generated prose. Source-only policy
returns `source-validated` without running any repository code.

Pass those connection values through the application's existing configurable
dependency seam. Use a separate test harness and runner mocks for functions or
opaque SDK methods; consult [bindings.md](bindings.md) and [mocking.md](mocking.md).
Do not edit production logic, assume arbitrary interception, change `.env` files,
or route unsupported calls to production as an implicit fallback.

For programmatic control, `createLocalWorld({ root, scenario? })` works without a
drill. `world.listen({ actorId? })` exposes the same backend while the caller keeps
`world.state()`, `world.reset()` and clock/fault controls. Reset preserves listener
addresses and credentials but restores the selected world baseline. Close the
binding and world when finished. Do not give the controller to the agent.

No assertions or run reports are produced by merely starting the backend.
Describe successful calls as backend checks, not passing agent drills. When the
user later asks to test the agent, reuse the same tool/world/scenario definitions
and add only its target, task and assertions through the main skill's drill loop.
