# `@firedrill/cli`

Account-free local commands for repository-owned synthetic worlds and agent drills.

```sh
firedrill                 # run every drill
firedrill my-drill        # run one drill; `run` is optional
firedrill validate        # parse and validate without building
firedrill plan            # inspect the semantic build plan
firedrill build           # materialize and verify an immutable build
firedrill format --check  # check typed YAML and JSON formatting
firedrill init            # inspect four account-free onboarding paths
firedrill init --path firedrill-agent
firedrill agent           # optional Claude Agent SDK authoring assistant
firedrill run --suite pr  # run a repository-owned suite
firedrill run --watch     # rerun after source or agent changes
firedrill run my-drill --callback-receiver application=http://127.0.0.1:4319
firedrill report verify .firedrill/reports/<run-id>
firedrill compare <baseline-report> <candidate-report>
firedrill tool inspect my-tool
firedrill tool validate my-tool
firedrill tool test my-tool
firedrill tool contribute my-tool --accept-apache-2.0
firedrill world tools --json
firedrill world call my-tool records.read --input '{"id":"primary"}' --json
```

`firedrill` creates a fresh world per trial, invokes the declared customer-owned agent target, evaluates state/tool/event consequences, and writes the retained SQLite world plus terminal, JSON, JSONL, JUnit, and self-contained HTML evidence beneath `.firedrill/`.

Choose a module, command, local HTTP, or caller-owned target based on how the agent already runs. A target declares direct, HTTP, MCP, or CLI world bindings; the CLI does not require an agent framework wrapper. `firedrill world` is available only inside an active CLI binding and calls the same stateful Tool runtime as the other adapters.

Add `--json` for stable machine-readable output; watch mode emits one complete JSON object per cycle. Select drills with `--suite`, repeatable `--tag`, `--filter`, and deterministic `--shard`. Bound local work with `--trials`, `--retries`, and `--concurrency`.

For callbacks from the synthetic world into the local application, repeat `--callback-receiver <id>=<loopback-origin>` for each repository-declared receiver. If its contract uses HMAC signing, add `--callback-secret-env <id>=<variable>`; the CLI reads the secret from that variable without putting it in the command, source, or report. The same options work with `tool test` and `tool contribute` so declared callbacks are covered by conformance.

Use `report verify` to check a received local bundle's manifest, exact files, hashes, schemas, identities, evidence ordering, and generated projections entirely offline. This detects corruption and internal inconsistency; an unsigned local report does not prove authorship. A report's reproduction command recompiles current repository source and reruns the drill with the recorded seed; its displayed build hash tells you which source revision must be restored for an exact reproduction. `compare` verifies both bundles and states whether inputs are exact, merely descriptive, or incompatible before reporting deltas. Exit codes are `0` for pass, `1` for a source/run/assertion failure, and `2` for invalid CLI usage. Commands never prompt, upload source, or contact a hosted service.

`tool inspect` shows a selected Tool's origin, normalized manifest, and locked artifact without importing its behavior. A Tool may be authored in the repository or supplied by an installed package explicitly listed under `toolPackages` in `firedrill.json`. `tool validate` loads the selected behavior with the developer's local authority and checks its exact handler surface. `tool test` reuses an ordinary `<tool-id>-conformance` drill suite, runs it twice against one immutable build, and fails on drill failures, non-reproducible hashes, or uncovered operations, declared errors, events, faults, subscriptions, and callbacks.

After conformance passes, `tool contribute` can prepare a new, non-overwriting review directory for Tool source owned by the current repository. It contains only the Tool declaration, its exact behavior source closure, checksums, normalized manifest, license, and a payload-free conformance summary. It requires explicit source-rights/customer-data/Apache-2.0 attestation and blocks common credential patterns. Installed dependencies must be contributed from their own source repository. Nothing is uploaded and no pull request is opened.

`firedrill agent` dynamically loads the separately installed `@firedrill/agent` package. It uses the Claude Agent SDK and the developer's `ANTHROPIC_API_KEY`; the rest of the CLI has neither dependency. Running the Agent may send repository content to Anthropic, but never to a hosted Firedrill service. Its file access excludes secrets, Git metadata, dependencies, and `.firedrill/` evidence, and it has no shell or publish capability.

See the repository's `docs/quickstart.md` and `examples/quickstart` while the packages are pre-release.
