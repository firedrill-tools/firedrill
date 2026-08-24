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
- `firedrill tool validate`, `tool test`, and `tool contribute` load or exercise Tool behavior;
- module and command targets run repository code, while HTTP and caller-owned targets invoke code chosen by the caller.

The local framework does not claim to sandbox that code. The compiler rejects Node built-in and undeclared package imports from locked Tool artifacts, but JavaScript executing in the local process still has ambient process authority. Review a Tool pack before installing or executing it. Package lifecycle and fidelity metadata are provenance signals, not a security endorsement.

## Enforced local boundaries

- Repository source, installed Tool source, immutable builds, and target modules are checked for path escape and external symlinks before use.
- HTTP and MCP world bindings listen only on an explicit loopback address, require a random bearer token, validate request host/origin, and cap request bodies at 1 MiB.
- World access is scoped to one target invocation and revoked before timeout or cancellation is delivered. A retained direct client cannot mutate the world after that invocation ends.
- Remote HTTP agent targets are opt-in. Redirects are never followed because an invocation carries world binding credentials. Target input and output are bounded.
- Subprocess targets receive only world binding variables, explicitly mapped host variables, and the minimum platform variables needed to launch a process. They are spawned without a shell.
- SQLite creation, snapshots, report writing, and contribution bundles refuse to overwrite an existing destination.

## Reports and local data

Local runs keep SQLite worlds and evidence under `.firedrill/` by default. `firedrill init` adds that directory to the project's Git ignore rules, but ignore rules are not access control: do not commit or publish it. A world database can contain the complete synthetic state and unredacted evidence.

HTML, JSON, terminal, and JUnit reports apply a conservative field-based redaction policy. It cannot recognize every secret placed in an arbitrary string or custom field. Review a report before sharing it.

`firedrill report verify` checks a bounded file set, hashes, schemas, identities, evidence ordering, and regenerated projections. It rejects symlinks and oversized bundles. This proves internal integrity only; local reports are unsigned and do not prove who produced them.

## Hosted boundary

The future hosted service has a separate isolation, identity, signing, and retention boundary. Hosted code is not part of this public framework repository. Nothing here should be interpreted as a claim that untrusted code is safely hosted or sandboxed until that boundary is independently implemented and verified.
