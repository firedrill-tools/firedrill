# `@firedrill-tools/cli`

Account-free local commands for repository-owned synthetic worlds and agent drills.

For programmatic source setup, `addToolPackages({ root, packageNames })` from
`@firedrill-tools/cli` selects several already installed packages in one operation.
It inspects declarations without importing behavior or installing dependencies.
A new project receives the combined exact grants and validated starter data;
existing world source and actor grants remain unchanged. Duplicate Tool IDs
across packages are rejected before source changes. This creates source only,
not a running backend or a test result.

```sh
firedrill                 # run every drill
firedrill my-drill        # run one drill; `run` is optional
firedrill validate        # parse and validate without building
firedrill plan            # inspect the semantic build plan
firedrill build           # materialize and verify an immutable build
firedrill format --check  # check typed YAML and JSON formatting
firedrill init            # pick/search ready fake tools or create your own
firedrill init --custom my-tool --start
firedrill init --search queue --json
firedrill init --tool @example/installed-pack --start
firedrill serve           # run the local tools and open their live inspector
firedrill agent --workflow environment # optional Claude Agent SDK authoring assistant
firedrill inspect         # open the offline World, Drills, and Runs inspector
firedrill run --suite pr  # run a repository-owned suite
firedrill run --watch     # rerun after source or agent changes
firedrill run my-drill --callback-receiver application=http://127.0.0.1:4319
firedrill report verify .firedrill/reports/<run-id>
firedrill compare <baseline-report> <candidate-report>
firedrill tool list --limit 10
firedrill tool search queue --limit 10
firedrill tool search queue --index ./tool-index.json
firedrill tool inspect my-tool
firedrill tool create my-tool
firedrill tool create my-tool --package --name @your-team/my-tool --root ./my-tool
firedrill tool add @example/installed-pack
firedrill tool add ./my-tool --install
firedrill tool add 'github:your-team/fake-tools#v1.0.0::packages/my-tool' --install
firedrill tool validate my-tool
firedrill tool test my-tool
firedrill tool contribute my-tool --accept-apache-2.0
firedrill world tools --json
firedrill world call my-tool records.read --input '{"id":"primary"}' --json
```

`firedrill` creates a fresh world per trial, invokes the declared customer-owned agent target, evaluates state/tool/event consequences, and writes the retained SQLite world plus terminal, JSON, JSONL, JUnit, and self-contained HTML evidence beneath `.firedrill/`.

Start with Tools; an agent target, scenario, drill, model key, or account is not required. Interactive `init` offers the bundled community Tool catalog (search with `/text`), an independently maintained package, or a custom stateful get/set scaffold. Select several ready Tools with “Add another” or repeat `--tool`. `tool list` browses the catalog, `tool search <text>` narrows it, and `init --index` can read an explicitly selected local or HTTPS index; no central listing or approval is required. Catalog entries describe only declared operations and bounded compatibility, not full service replicas. An installed package is inspected without running its code. A new world receives its exact operation grants and any validated package-authored starter rows; existing worlds, actors, and data are left intact. When composing starters, the shared clock starts at the latest authored starter time.

Missing packages require separate installation consent. `--install` authorizes acquisition from an npm package selector, local package directory/archive, or Git repository with an optional package subdirectory. Git branches and tags resolve to exact commits; npm selections resolve to exact versions. Local and Git sources are retained as content-addressed `.firedrill-tools/` archives so another checkout does not depend on the author's original directory. Commit those source archives and provenance files with the dependency manifest and package-manager lock; keep generated `.firedrill/` worlds and reports private. Installation uses npm or pnpm with lifecycle scripts disabled and does not execute Tool behavior. Catalog entries are pre-release and may not be published; use reviewed local packages when needed. A failed installation never substitutes another Tool. Review any completed dependency changes before retrying.

Keep Tool code in any repository you own. `tool create --package` makes a new, independently packable package with a declaration, behavior, starter state, and portable conformance tests; it refuses to overwrite an existing nonempty directory. The default license is `UNLICENSED` until you choose your own. Nothing is installed or published by scaffolding. The [package authoring guide](../../docs/tool-packages.md) covers development and distribution without contributing to this repository.

Manual customization is the default. `--authoring coding-agent` installs the canonical skill and repository brief. `--authoring firedrill-agent --allow-agent` explicitly authorizes the installed optional Agent to author the environment using the shell's `ANTHROPIC_API_KEY`; interactive setup asks permission before starting. No key is requested as prompt text or written into `.env`. A missing key leaves the local Tool setup usable and prints a resumable command. Agent completion and environment readiness are separate: output reports actual source/runtime diagnostics and never claims the customer's agent was tested.

`--start` runs the selected Tool code and opens the inspector against that same world. `serve` publishes scoped HTTP, MCP, and CLI connection values, including local bearer tokens; keep those private. The inspector shows live state, operations, calls, and reset controls. The process stays in the foreground; Ctrl+C closes its inspector, bindings, and world. `--no-open` skips browser launch. With multiple actors, choose one interactively or pass `init --start --actor <id>` / `serve --actor <id>`.

Bare noninteractive or JSON `init` remains a read-only inspection; `--search` is always read-only. Explicit `--tool`, `--custom`, or the compatible legacy `--path firedrill-agent|coding-agent|template|manual` selects writes. Setup JSON is one complete record; explicit authoring or `--start` adds lifecycle records. JSON never opens the browser or prompts. The old template path remains an explicit opt-in complete example, and the old manual path remains a minimal probe shell.

`firedrill inspect` serves a bundled UI on a random loopback port, opens it in the browser, and stays attached until stopped. The UI compiles the current repository source, runs drills or suites, follows live causal evidence, inspects synthetic state and pending work, repeats a run with its recorded seed, compares verified runs, and opens HTML reports. Use `--no-open` when another process owns browser launch, `--port` for a fixed loopback port, or `--json` for one machine-readable ready event. The bearer token stays inside the served page and is never printed in the URL or CLI output.

Choose a module, command, local HTTP, or caller-owned target based on how the agent already runs. A target declares direct, HTTP, MCP, or CLI world bindings; the CLI does not require an agent framework wrapper. `firedrill world` is available only inside an active CLI binding and calls the same stateful Tool runtime as the other adapters.

Add `--json` for stable machine-readable output; watch mode emits one complete JSON object per cycle. Select drills with `--suite`, repeatable `--tag`, `--filter`, and deterministic `--shard`. Bound local work with `--trials`, `--retries`, and `--concurrency`.

For callbacks from the synthetic world into the local application, repeat `--callback-receiver <id>=<loopback-origin>` for each repository-declared receiver. If its contract uses HMAC signing, add `--callback-secret-env <id>=<variable>`; the CLI reads the secret from that variable without putting it in the command, source, or report. The same options work with `tool test` and `tool contribute` so declared callbacks are covered by conformance.

Use `report verify` to check a received local bundle's manifest, exact files, hashes, schemas, identities, evidence ordering, and generated projections entirely offline. This detects corruption and internal inconsistency; an unsigned local report does not prove authorship. A report's reproduction command loads its content-addressed local build with `--build-hash` and reruns the drill with the recorded seed. If that generated build was removed, restore and compile the source and any recorded test-local setup that produced the hash first. `compare` verifies both bundles and states whether inputs are exact, merely descriptive, or incompatible before reporting deltas. Exit codes are `0` for success, `1` for a source/run/assertion failure, and `2` for invalid usage or setup needing action. Local framework commands do not upload source or contact hosted Firedrill. Explicit `--install` can contact the selected registry or Git host and resolve dependencies; `--index` can read the explicitly selected remote index; optional Agent authoring contacts Anthropic. Executed customer targets and Tool code retain their own local authority and network capabilities. Guided `init` prompts only in an interactive terminal.

`firedrill cloud` explicitly selects an optional destination extension supplied by
the separately installed `firedrill` client package. No extension is loaded by a
local command, and signing in cannot redirect local commands to a remote service.
The local framework works without this package or an account.

`tool inspect` shows a selected Tool's origin, normalized manifest, and locked artifact without importing its behavior. A Tool may be authored in the repository or supplied by an installed package explicitly listed under `toolPackages` in `firedrill.json`. `tool validate` loads the selected behavior with the developer's local authority and checks its exact handler surface. `tool test` runs ordinary conformance drills twice against one immutable build and fails on drill failures, non-reproducible hashes, or uncovered operations, declared errors, events, faults, subscriptions, and callbacks.

A matching consumer-owned conformance suite takes precedence. Otherwise, `tool test` can use the installed package's versioned portable suite, staged beneath `.firedrill/tool-tests/` without changing dependencies. The staged Tool must match the installed contract, behavior, and app assets exactly. An explicit `--suite` selects a consumer suite only; a missing suite fails rather than falling back. Output identifies the suite source. These are author-supplied tests, not independent certification of service parity or a sandbox: review both Tool behavior and conformance targets before executing them.

After conformance passes, `tool contribute` can prepare a new, non-overwriting review directory for Tool source owned by the current repository. It contains only the Tool declaration, its exact behavior source closure, checksums, normalized manifest, license, and a payload-free conformance summary. It requires explicit source-rights/customer-data/Apache-2.0 attestation and blocks common credential patterns. Installed dependencies must be contributed from their own source repository. Nothing is uploaded and no pull request is opened.

`firedrill agent` dynamically loads the separately installed `@firedrill-tools/agent` package. It uses the Claude Agent SDK and the developer's `ANTHROPIC_API_KEY`; the rest of the CLI has neither dependency. Running the Agent may send repository content to Anthropic, but never to a hosted Firedrill service. Its file access excludes secrets, Git metadata, dependencies, and `.firedrill/` evidence, and it has no shell or publish capability.

Start with the [Firedrill quickstart](https://docs.firedrill.run/quickstart).
The complete [CLI reference](https://docs.firedrill.run/cli/reference) is generated from the executable release-candidate command surface.
