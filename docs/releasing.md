# Release evidence

Firedrill does not publish from a developer laptop. A release candidate is built from committed, clean source on GitHub-hosted CI, and publication remains a separate authorized action.

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

`release:prepare` requires Syft `1.51.0`, verifies SPDX 2.3 structure and expected package coverage, installs the packed runtime without lifecycle scripts or network access, and packs every artifact twice to prove byte equality. Syft SBOM documents include build-time metadata and are hashed as the concrete generated artifacts; Firedrill does not claim independently regenerated SBOM bytes are deterministic.

## CI evidence

The manual `Release evidence` workflow runs the complete framework gate, prepares the bundle, and uploads it without publishing anything. On a public repository it also creates GitHub/Sigstore provenance and SBOM attestations for the package archives. Consumers can later verify those attestations with `gh attestation verify` against the public repository.

Every pull request and main-branch commit also installs the packed npm artifacts into an external project on Linux, macOS, and Windows with both the minimum supported Node version and the current release-line version. The project path contains spaces and non-ASCII characters, commands run without a TTY under CI and a non-English locale, and the gate exercises native SQLite, pass/fail reports, exact reproduction, and Tool conformance through the installed CLI. This is the portability claim; a workspace-source test is not a substitute.

Npm provenance is a separate registry operation. It requires a public repository URL in each package manifest and a supported hosted publisher or npm trusted publishing. Those values and actual publication require explicit release-owner authorization; this repository contains no publish token and the evidence workflow never invokes `npm publish`.

Before the first release, the release owner must:

1. choose real package versions and the public repository URL;
2. configure npm trusted publishing for that exact repository and workflow;
3. run and inspect the release-evidence workflow from the intended commit;
4. verify package contents, checksums, SBOM coverage, and attestations; and
5. authorize the distinct publication workflow or command.
