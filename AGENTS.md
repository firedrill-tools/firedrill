# Firedrill contributor rules

These instructions apply to coding agents and automated contributors working in this repository. Read [`README.md`](README.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), and [`SECURITY.md`](SECURITY.md) before changing public behavior.

## Scope

- This repository contains the complete local Apache-2.0 Firedrill framework.
- It must build, test, pack, and run without an account, cloud service, or private codebase.
- Keep hosted control-plane, identity, tenancy, billing, web-product, and cloud-provider implementation outside this repository.
- Commit completed, coherent work locally with meaningful messages and a green repository gate. Do not push, publish, create releases, or change repository settings unless the repository owner explicitly requests that action.

## Public-code rules

- Core code never branches on a vendor, fixture, entity, operation, policy, persona, scenario, or drill name.
- Tool behavior comes from selected repository or package dependencies. Protocols and agent frameworks adapt at the edge.
- Do not expose a contract before a public CLI or SDK path proves why it exists.
- Do not add placeholder commands, dead exports, empty packages, or examples that imply unimplemented behavior.
- Keep test-runner-specific helpers out of runtime-safe exports.
- Keep the primary CLI and programmatic API repository-oriented and small. Ordinary callers must not construct internal build, store, kernel, or protocol objects to run a drill.
- Every public command needs a deterministic non-interactive path with stable output. Human and JSON modes must describe the same outcome and corrective action.
- Preserve compatibility for coding agents: schemas, diagnostics, commands, source layouts, examples, and reports must remain explicit and machine-readable.
- Treat Tools as trusted local test code, never as a sandbox boundary.

## Evidence

- Treat documentation, types, fixtures, and test names as claims until source and public behavior agree.
- Add a focused check at the lowest useful layer, then exercise changed behavior through the public CLI or SDK.
- Run `pnpm check` before declaring a change complete.
- Packed-consumer behavior matters more than workspace-only imports.
- Record only measured outcomes and state limitations plainly.
