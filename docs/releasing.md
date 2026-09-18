# Release evidence

Release archives are built from committed, clean source on GitHub-hosted CI.
Publication is a separate release-owner action: download the exact CI bundle,
verify its checksums and source revision, then publish those archives. Never
rebuild an archive on a workstation and substitute it for the reviewed CI output.

The npm organization for the framework is `firedrill-run`. All framework packages publish under
`@firedrill-run/`; the executable remains `firedrill`. Community Tool packages use the separate
`@firedrill-tools/` scope. Release candidates use
the `next` dist-tag, not `latest`. Publish dependencies before their consumers,
and verify a clean registry installation before announcing the release.

## Local rehearsal

Install the pinned Syft `1.51.0` binary from its official release and verify the vendor checksum. Then run:

```sh
pnpm check
pnpm release:prepare -- --output /an/empty/directory/outside/the/repository --syft /path/to/syft
```

The result is deliberately marked `rehearsal` when the repository has no commit or has local changes. Add `--require-clean` to enforce release-candidate source state.

The output contains:

- one byte-for-byte reproducible archive for every publishable npm package, plus their manifest;
- a source dependency SBOM from the exact `pnpm-lock.yaml`;
- a production-only installed-runtime SBOM;
- one artifact SBOM per npm package;
- `SHA256SUMS`; and
- `release.json`, which records source state, source-tree digest, toolchain versions, package digests, and SBOM digests.

`release:prepare` requires Syft `1.51.0`, verifies SPDX 2.3 structure and expected package coverage, installs the packed runtime without lifecycle scripts or network access, and packs every artifact twice to prove byte equality. The source digest covers Git-tracked and non-ignored source, so ignored workstation files and secrets cannot perturb release identity. Syft SBOM documents include build-time metadata and are hashed as the concrete generated artifacts; Firedrill does not claim independently regenerated SBOM bytes are deterministic.

## CI evidence

Run the complete framework gate and `release:prepare` in the CI system you
already use, then retain the resulting bundle as a private build artifact. The
gate should install the packed npm artifacts into an external project on Linux,
macOS, and Windows with both the minimum supported Node version and the current
release-line version. The project path should contain spaces and non-ASCII
characters, commands should run without a TTY under CI and a non-English locale,
and the gate should exercise native SQLite, pass/fail reports, exact
reproduction, and Tool conformance through the installed CLI. This is the
portability claim; a workspace-source test is not a substitute.

Npm provenance is a separate registry operation. It requires a public repository URL in each package manifest and a supported hosted publisher or npm trusted publishing. Those values and actual publication require explicit release-owner authorization; this repository contains no publish token and the evidence workflow never invokes `npm publish`.

## Publish the reviewed bundle

Download the release-evidence artifact from the reviewed commit. Do not rebuild it. The publish helper verifies every checksum and packed manifest, derives the dependency graph from the archives, and publishes one package at a time in dependency order. It never reads or writes credentials itself; npm authentication comes from the release operator's standard npm configuration or trusted publisher environment.

First inspect the exact plan without contacting or changing the registry:

```sh
pnpm release:publish -- --release /path/to/firedrill-release --tag next --dry-run
```

Then publish the same bundle. Add `--provenance` only from a supported trusted-publishing CI environment:

```sh
pnpm release:publish -- --release /path/to/firedrill-release --tag next
```

The command is resumable. Before each publish it checks the exact name and version. An already-published package is skipped only when the registry integrity and shasum match the reviewed archive; different or unverifiable bytes stop the release. Registry rate limits are retried with bounded backoff, while all other errors fail immediately.

Before the first release, the release owner must:

1. choose real package versions and the public repository URL;
2. configure npm trusted publishing for the selected release environment;
3. run and inspect the release-evidence job from the intended commit;
4. verify package contents, checksums, and SBOM coverage; and
5. authorize the distinct publication command; and
6. install `@firedrill-run/cli` and `@firedrill-run/sdk` into a clean project from the registry and run the quickstart before moving the dist-tag.
