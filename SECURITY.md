# Security policy

Firedrill is pre-release and does not yet have a supported production version.

## Reporting a vulnerability

Do not open a public issue or pull request for a suspected vulnerability. Use this repository's **Security → Report a vulnerability** flow so the report and any reproduction remain private. Private vulnerability reporting must be enabled before this repository is made public. If that flow is unavailable, contact a maintainer through an existing private project channel and do not send secrets or customer data.

Include the affected package and version or commit, impact, minimal reproduction, and any suggested mitigation. Remove credentials, private world definitions, and real customer records before sending evidence.

## Local trust model

Firedrill is a test framework, so a drill can execute code selected by the repository owner with that user's local authority. Treat agent targets, repository Tool behavior, and installed Tool packs like test code and npm development dependencies—not like untrusted data.

These commands inspect, parse, format, or bundle source without importing Tool behavior:

- `firedrill validate`
- `firedrill plan`
- `firedrill format`
- `firedrill tool inspect <tool-id>`

These commands cross the executable-code boundary:

- `firedrill build` imports the locked Tool artifact to verify its runtime export;
- `firedrill run` (and the zero-argument equivalent) executes selected Tool behavior and the configured agent target;
- `firedrill serve` loads selected Tool behavior and exposes it on authenticated loopback listeners; playground calls execute that behavior with the selected actor's access;
- `firedrill tool validate`, `tool test`, and `tool contribute` load or exercise Tool behavior;
- module and command targets run repository code, while HTTP and caller-owned targets invoke code chosen by the caller.

The local framework does not claim to sandbox that code. The compiler rejects Node built-in and undeclared package imports from locked Tool artifacts, but JavaScript executing in the local process still has ambient process authority. Review a Tool pack before installing or executing it. Package lifecycle and fidelity metadata are provenance signals, not a security endorsement.

## Independently maintained Tools

Tool code may live in any author's repository; a listing in the bundled catalog or an independent index is not required. `tool search` reads metadata, not behavior. An explicitly selected remote `--index` contacts that index host, does not follow redirects, and treats its descriptions and compatibility claims as publisher statements, not certification.

`tool add <source> --install` and authorized `init` installation can acquire npm packages, local package directories/archives, or Git packages. They may contact the selected registry or Git host and fetch dependencies. Acquisition disables package lifecycle scripts and does not execute Tool behavior. Git selectors resolve to an exact commit; reviewed package bytes are checked against the installed files before selection. These checks are not a malware scan. Review package source, dependencies, manifests, and locks before running it. Private Git access uses the user's credential helper; never embed credentials in a source selector.

Git and local packages are retained beneath `.firedrill-tools/` as source archives and provenance files. Unlike `.firedrill/` generated evidence, these are intended to be committed with dependency manifests and locks for reproducible installs. Review their contents before sharing; use an explicit package file allowlist and never include secrets or private test data.

An installed package can ship conformance targets in addition to Tool behavior. `tool test` prefers a consumer-owned suite, or stages the package's portable suite under `.firedrill/tool-tests/` when no consumer suite was selected. Staging rejects symlinks, excludes dependencies and common secret/generated files, and requires the same Tool contract, behavior, and app assets as the installed package. It does not install dependencies or run package build scripts. Running the resulting tests still executes trusted local code with the user's authority. A passing suite demonstrates only its declared coverage and reproducibility, not independent provider fidelity or safety certification.

## Enforced local boundaries

- Repository source, installed Tool source, immutable builds, and target modules are checked for path escape and external symlinks before use.
- HTTP and MCP world bindings listen only on an explicit loopback address, validate request host/origin, and cap request bodies at 1 MiB. Generic HTTP and MCP surfaces require a random per-invocation bearer token. A repository-owned synthetic HTTP route enforces its declared placement of that same token; an explicit `auth.kind: none` route is intentionally reachable by any local process that can reach the ephemeral listener and should be used only to model an unauthenticated local API.
- Drill world access is scoped to one target invocation and revoked before timeout or cancellation is delivered. A retained direct client cannot mutate the world after that invocation ends. Standalone `serve` access lasts until the environment stops; stopping closes every listener, and reset does not revoke its credentials.
- Remote HTTP agent targets are opt-in. Redirects are never followed because an invocation carries world binding credentials. Target input and output are bounded.
- Subprocess targets receive only world binding variables, explicitly mapped host variables, and the minimum platform variables needed to launch a process. They are spawned without a shell.
- SQLite creation, snapshots, report writing, and contribution bundles refuse to overwrite an existing destination.

## Reports and local data

Local runs keep SQLite worlds and evidence under `.firedrill/` by default. `firedrill init` adds that directory to the project's Git ignore rules, but ignore rules are not access control: do not commit or publish it. A world database can contain the complete synthetic state and unredacted evidence.

HTML, JSON, terminal, and JUnit reports apply a conservative field-based redaction policy. It cannot recognize every secret placed in an arbitrary string or custom field. Review a report before sharing it.

`firedrill report verify` checks a bounded file set, hashes, schemas, identities, evidence ordering, and regenerated projections. It rejects symlinks and oversized bundles. This proves internal integrity only; local reports are unsigned and do not prove who produced them.

## Optional Firedrill Agent

`@firedrill-tools/agent` is an optional networked authoring assistant, not part of deterministic drill execution. Invoking `firedrill agent` starts the Claude Agent SDK with the developer's `ANTHROPIC_API_KEY`; repository content selected by the model can be sent to Anthropic under Anthropic's applicable terms. It does not send source to Firedrill.

The wrapper exposes bounded repository read/edit tools, secret-skipping repository discovery and literal search, and in-process Firedrill validation, formatting, planning, Tool-check, and drill tools. It blocks known secret files, generated evidence, dependencies, Git metadata, paths outside the selected repository, generic filesystem search, shell access, generic web access, commits, pushes, and publication. These controls reduce accidental exposure; they are not a sandbox and cannot guarantee that an ordinary source file or executable repository code contains no embedded secret. Running a drill or Tool check executes the resulting repository code with the same local trust boundary as running tests after any coding-agent edit. Review the repository and resulting diff before invoking the Agent, executing newly authored code, or sharing its output. The compiler, runner, assertions, and report verifier remain authoritative.

The default environment-authoring workflow also loads generated Tool code to check listener startup before reporting readiness. Use the programmatic `allowRepositoryExecution: false` policy for source-only proposals; that reports `source-validated`, not a running environment. A startup check does not prove service fidelity or test the customer's agent.

## Hosted boundary

The future hosted service has a separate isolation, identity, signing, and retention boundary. Hosted code is not part of this public framework repository. Nothing here should be interpreted as a claim that untrusted code is safely hosted or sandboxed until that boundary is independently implemented and verified.
