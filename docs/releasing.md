# Releasing the npm packages

Firedrill does not publish from a developer laptop or use a long-lived npm token. A GitHub release builds the packages from its exact tag, passes the complete framework gate, and publishes the verified archives through npm trusted publishing. The `npm` GitHub environment is the human authorization boundary.

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

The manual `Release evidence` workflow runs the complete framework gate, prepares the bundle, and uploads it without publishing anything. On a public repository it also creates GitHub/Sigstore provenance and SBOM attestations for the package archives. Consumers can later verify those attestations with `gh attestation verify` against the public repository.

Every pull request and main-branch commit also installs the packed npm artifacts into an external project on Linux, macOS, and Windows with both the minimum supported Node version and the current release-line version. The project path contains spaces and non-ASCII characters, commands run without a TTY under CI and a non-English locale, and the gate exercises native SQLite, pass/fail reports, exact reproduction, and Tool conformance through the installed CLI. This is the portability claim; a workspace-source test is not a substitute.

The `Publish npm packages` workflow is separate from that rehearsal. It runs only for a published GitHub release in `firedrill-tools/firedrill`, checks that `v<version>` resolves to a commit on `main`, and rejects a mismatch between a prerelease version and GitHub's prerelease flag. Its build job has no OIDC permission. The `npm` environment protects a minimal publish job that downloads the verified bundle, rechecks its checksums and release identity, and publishes with lifecycle scripts disabled. A rerun skips an existing package version only when the registry's SHA-512 integrity exactly matches the local archive.

The publish job uses Node 24 and refuses npm versions older than 11.5.1. npm exchanges GitHub's job-specific OIDC identity for a short-lived credential; this repository contains no publish token. When the repository is public, npm adds provenance automatically for trusted publications.

Before the first release, the release owner must:

1. Create or verify the npm organization scope `@firedrill`, require two-factor authentication for its maintainers, and make the GitHub repository public before provenance is expected.
2. Create a protected GitHub environment named `npm` with required reviewers and no deployment branches other than protected release tags.
3. Bootstrap each new package name once from the inspected release-evidence archives with a maintainer's interactive npm authentication. npm cannot attach a trusted publisher to a package that does not exist yet. The bootstrap must use `--access public`, the `next` dist-tag for a release candidate, and the exact archives whose checksums were reviewed; do not add a token to GitHub.
4. On every package's npm settings page, add a GitHub Actions trusted publisher with organization `firedrill-tools`, repository `firedrill`, workflow filename `publish.yml`, environment `npm`, and direct `npm publish` allowed.
5. Set every package's publishing access to require two-factor authentication and disallow traditional tokens after the trusted publisher is configured.
6. Protect `v*` tags and GitHub release creation, then run and inspect the release-evidence workflow from the intended commit.

For a release, update the root and all framework package versions together, update `FIREDRILL_FRAMEWORK_VERSION`, pass `pnpm check`, merge to `main`, and create `v<version>` at that merge commit. Publish a GitHub prerelease for a prerelease version or a normal release for a stable version. Approving the waiting `npm` environment deployment authorizes registry publication.

If any package fails, do not change the tag or reuse its version with different bytes. Resolve the registry or trusted-publisher configuration and rerun the same workflow. Its integrity check makes a partial multi-package publication safely resumable.
