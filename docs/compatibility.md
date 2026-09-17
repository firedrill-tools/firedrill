# Compatibility policy

Firedrill keeps package releases, the Tool engine contract, authored source, generated builds, and reports as separate versioned boundaries. A matching number in two boundaries does not make them interchangeable.

## Framework packages

All packages under `packages/` ship as one versioned release train. Use one release line across direct Firedrill dependencies; the package manager resolves the exact internal versions from the published manifests. The current candidate is `0.1.0-rc.1`, published under the `@firedrill-tools` npm scope with the `next` dist-tag.

The exact package names, directories, export paths, CLI binary, and supported toolchain are checked against [`release/public-surface.json`](../release/public-surface.json). Changing that file is an intentional public-contract decision, not an incidental consequence of adding code.

Reusable Tool packs are independently versioned. A Tool declaration's version must equal its npm package version, and its `engine` range declares which local runtime contract it supports.

## Engine contract

The current Tool engine contract is `0.1.0`. Compatible framework prereleases and patches may implement that same engine contract. Compilation rejects a Tool whose declared semver range does not include the current engine; it never guesses at compatibility.

## Repository source

The first public authored-source contract is `schemaVersion: 1`. Every typed JSON or YAML resource declares it. Firedrill validates the version before interpreting fields:

- version `1` is accepted and normalized through the published schema;
- a missing or malformed version fails normal schema validation; and
- an integer version other than `1` fails with diagnostic `FD1103` and a source span.

There is no pre-v1 published source shape and therefore no invented migration in this release. When a future source version exists, compatibility should be an explicit read-time upgrade into the current canonical form. A codemod may be offered as a convenience, but Firedrill must not silently rewrite repository history or treat a relabeled document as migrated.

## Generated builds and reports

Generated builds are immutable, content-addressed artifacts rather than source. Build manifest, world IR, package lock, and run-setup schemas are version `1`. An unsupported generated schema fails with `FD1604` before Tool behavior loads. Engine mismatch, changed bytes, or an unexpected artifact set also fails closed. Recompile the original source with a compatible Firedrill release instead of editing generated files.

Local report bundles carry their own schema versions and exact hashes. `firedrill report verify` is the compatibility and integrity gate before a report is inspected or compared. Unsigned local verification proves internal consistency, not producer identity.

This release candidate also records controller-driven fault changes as
`fault_control` evidence, separately from a triggered `fault`. An older candidate
that does not recognize that evidence kind must reject the bundle; do not remove
entries to make it pass. Use the same release train for execution and inspection.

## Release-candidate promise

Release candidates may still change public APIs and source shapes before `0.1.0`. Each candidate must nevertheless reject unknown versions clearly, keep coding-agent diagnostics stable within that candidate, and install all framework packages from the same release train. Breaking changes after a stable release require a new major version or an explicit compatible upgrade path.
