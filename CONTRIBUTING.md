# Contributing

Firedrill is an Apache-2.0 framework for defining synthetic worlds and running agent drills locally. Contributions must preserve that complete, account-free local loop and keep hosted-platform code out of this repository.

## Before opening a change

- Read [`AGENTS.md`](AGENTS.md) for the public boundary and implementation rules.
- Open an issue before a large contract, file-format, or package-boundary change.
- Keep changes generic. A vendor integration belongs in a Tool pack, not in framework core.
- Never include customer source, fixtures, credentials, private endpoints, or generated reports that contain sensitive data.

## Development

Use Node.js 20.19 or newer and pnpm 9.15 through 10.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the required gate. It formats and lints the source, enforces package and genericity boundaries, scans the public tree for secret-bearing files and common credential formats, builds and type-checks every package, verifies authored-input JSON Schemas plus the generated human/machine registry, runs the tests and quickstart, then installs all publishable tarballs into a clean offline consumer and exercises their public entry points.

Every behavior change needs a focused test at the lowest useful layer and an acceptance test through the public CLI or SDK seam. Do not mark a command or capability complete based only on an internal unit test.

## Tool contributions

Keep private or project-specific Tools in the project that uses them. Reusable community Tool packs live under [`tool-packs/`](tool-packs/README.md); framework packages must never dispatch on their operation names.

Before proposing a reusable Tool, run its ordinary repository-owned conformance drills:

```sh
firedrill tool inspect <tool-id>
firedrill tool validate <tool-id>
firedrill tool test <tool-id>
firedrill tool contribute <tool-id> --accept-apache-2.0
```

The last command creates a deterministic local review bundle. It does not upload, submit, or overwrite anything. Inspect every file in the bundle before attaching it to a contribution. Secret scanning is a backstop, not authorization to publish a file.

A community Tool contribution must disclose provenance and license, declare its capabilities and fidelity honestly, cover every declared operation/error/event/fault/subscription in conformance drills, and pass the repository-wide gate. Its package metadata must identify `firedrill.layer: "tool-pack"`, the declaration path, conformance suite, owner, and an `active`, `deprecated`, or `revoked` lifecycle. Run `pnpm registry:write` after an accepted metadata change; the root gate rejects a stale catalog.

The contribution command must be run from the Tool's owned source repository. Firedrill intentionally refuses to repackage an installed dependency from a consumer project.

## License

By intentionally submitting a contribution for inclusion in Firedrill, you agree that it may be licensed under the Apache License 2.0.
