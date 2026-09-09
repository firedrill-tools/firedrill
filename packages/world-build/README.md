# `@firedrill/world-build`

Loads an immutable world build only after verifying its build identity, canonical IR hash, package-lock hash, exact artifact set, per-Tool artifact hashes, Tool manifest hashes, engine compatibility, and exported behavior contract.

Loading executes customer-supplied Tool behavior. The local framework treats code in the developer's repository as trusted local code; hosted execution must compose this loader inside the platform's package sandbox.

Optional Tool UI assets are part of the same immutable package lock. The loader
checks their exact file set, safe paths, sizes, MIME allowlist and content hashes
before importing any Tool behavior. Missing, extra, changed or symlinked assets
fail loading. The returned `LoadedWorldBuild.toolUis` contains verified in-memory
`{ packageId, entry, assets }` values; each asset exposes UI-relative `path`,
`mediaType`, `artifactHash` and `bytes`. Backend-only builds return an empty list.
UI JavaScript is never imported by the loader. Local serving consumes these
verified bytes rather than reading the mutable source directory.
