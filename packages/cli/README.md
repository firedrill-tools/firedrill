# `@firedrill/cli`

Account-free local commands for repository-owned synthetic worlds and agent drills.

```sh
firedrill                 # run every drill
firedrill my-drill        # run one drill; `run` is optional
firedrill validate        # parse and validate without building
firedrill plan            # inspect the semantic build plan
firedrill build           # materialize and verify an immutable build
firedrill format --check  # check typed YAML and JSON formatting
firedrill init            # inspect three account-free onboarding paths
firedrill run --suite pr  # run a repository-owned suite
firedrill run --watch     # rerun after source or agent changes
firedrill report verify .firedrill/reports/<run-id>
firedrill compare <baseline-report> <candidate-report>
firedrill tool inspect my-tool
firedrill tool validate my-tool
firedrill tool test my-tool
firedrill tool contribute my-tool --accept-apache-2.0
```

`firedrill` creates a fresh world per trial, invokes the declared customer-owned agent target, evaluates state/tool/event consequences, and writes the retained SQLite world plus terminal, JSON, JSONL, JUnit, and self-contained HTML evidence beneath `.firedrill/`.

Choose a module, command, local HTTP, or caller-owned target based on how the agent already runs. A target declares direct, HTTP, or MCP world bindings; the CLI does not require an agent framework wrapper.

Add `--json` for stable machine-readable output; watch mode emits one complete JSON object per cycle. Select drills with `--suite`, repeatable `--tag`, `--filter`, and deterministic `--shard`. Bound local work with `--trials`, `--retries`, and `--concurrency`.

Use `report verify` to check a received local bundle's manifest, exact files, hashes, schemas, identities, evidence ordering, and generated projections entirely offline. This detects corruption and internal inconsistency; an unsigned local report does not prove authorship. Use `--build-hash`, `--seed`, and `--trials 1` from a report's reproduction command to rerun the same deterministic world inputs. `compare` verifies both bundles and states whether inputs are exact, merely descriptive, or incompatible before reporting deltas. Exit codes are `0` for pass, `1` for a source/run/assertion failure, and `2` for invalid CLI usage. Commands never prompt, upload source, or contact a hosted service.

`tool inspect` shows a selected Tool's origin, normalized manifest, and locked artifact without importing its behavior. A Tool may be authored in the repository or supplied by an installed package explicitly listed under `toolPackages` in `firedrill.json`. `tool validate` loads the selected behavior with the developer's local authority and checks its exact handler surface. `tool test` reuses an ordinary `<tool-id>-conformance` drill suite, runs it twice against one immutable build, and fails on drill failures, non-reproducible hashes, or uncovered operations, declared errors, events, faults, and subscriptions.

After conformance passes, `tool contribute` can prepare a new, non-overwriting review directory for Tool source owned by the current repository. It contains only the Tool declaration, its exact behavior source closure, checksums, normalized manifest, license, and a payload-free conformance summary. It requires explicit source-rights/customer-data/Apache-2.0 attestation and blocks common credential patterns. Installed dependencies must be contributed from their own source repository. Nothing is uploaded and no pull request is opened.

See the repository's `docs/quickstart.md` and `examples/quickstart` while the packages are pre-release.
