# The Firedrill Tool contract

A Firedrill-compatible Tool is a reusable synthetic dependency: its contract,
executable behavior, and optional starting data and app can be loaded into a
Firedrill world. The author can maintain it in any repository, under their own
package name and license. No account, registry listing, or contribution to this
repository is required.

This is an open, versioned contract and reference implementation—not a claim
that the wider industry has adopted a standard. Anyone can implement tooling
against the schemas, build compatible packages, or maintain a discovery index.

## Community and independent Tools

- **Community catalog:** reusable integrations are maintained in the independent
  community-tools repository and released under their own package versions.
- **Anywhere else:** a project-local Tool or independently distributed package.
  Its author owns releases, license, compatibility claims, and support.

The same compiler, runtime, bindings, and conformance checks apply to both.
Discovery helps people find packages; it is not permission to run them.
The `tool-packs/` directory in this repository contains framework fixtures used
to prove the open contract. Those fixtures are not the community catalog.

## What a package contains

| Part | Contract |
| --- | --- |
| Identity | An npm package name and semver version; the Tool also has an in-file ID. |
| Declaration | JSON or YAML `schemaVersion: 1`, a Tool manifest, and its behavior module path. |
| Behavior | Deterministic JavaScript/TypeScript implementing declared operations through the Tool context. |
| Engine range | Explicit supported engine versions, independent of package and source-schema versions. |
| Starting state | Optional bounded `starter` records copied into the consumer's repo-owned world. |
| Conformance | Optional portable project and suite; required to make an author-tested compatibility claim. |
| App | Optional packaged static UI that invokes the same operations and state as other bindings. |

The package's `firedrill` metadata identifies `layer: "tool-pack"`, the declaration
path, and lifecycle (`active`, `deprecated`, or `revoked`). It exports
`./package.json`. Declaration paths, behavior dependencies, starter data,
conformance files, and app assets must stay inside the package. Package and Tool
manifest versions must agree. Unknown engine/source versions fail clearly.

Normative machine-readable definitions ship with the implementation:

- `@firedrill-run/compiler/schema/tool-source`: authored declaration.
- `@firedrill-run/compiler/schema/installed-tool-package`: npm metadata envelope.
- `@firedrill-run/contracts/schema/tool-package-manifest`: semantic manifest.
- `@firedrill-run/cli/schema/tool-index.json`: optional discovery metadata.

See [package authoring](tool-packages.md) for the npm envelope and portable suite,
[Tool SDK](../packages/tool-sdk/README.md) for handler semantics, and
[version compatibility](compatibility.md) for independent version boundaries.

## Behavior, not transport, is the reusable unit

One operation can be called through direct functions, HTTP, MCP, or CLI bindings.
Provider-shaped HTTP codecs and connection aliases adapt existing clients at
the boundary. UI-backed Tools use these same operations. No Tool is required
to provide every transport or a UI. Declare only the surfaces actually supplied.

Mutations, expected errors, permissions, virtual time, seeded randomness, events,
and scheduled consequences use the world context and ordered evidence. SQLite
holds synthetic surrounding-service state; it does not replace the tested
agent's own database. Several independently owned Tools can coexist in one world.
Consumer scenarios and test-side overrides remain separate from package source.

Tools are trusted local code. Import restrictions, a schema-valid manifest, or
a passing conformance suite do **not** create a security sandbox.

## Make compatibility claims precise

1. `tool inspect` establishes the selected declaration and source without loading
   its behavior.
2. `tool validate` loads the implementation and checks the executable surface.
3. `tool test` runs declared conformance drills twice, checking assertions,
   declared coverage, resulting state, and repeatable activity.
4. A real-client compatibility claim additionally names an exact client version,
   supported calls, configuration seam, tested flows, and omissions.

An author-written suite can be incomplete or wrong. A passing suite proves its
checks passed—not complete provider fidelity, safe code, independent review,
or correct behavior by every agent. Reports identify the selected version/build
and whether conformance came from the consumer repository or package.

## Install, compose, and share

Create a standalone package with `firedrill tool create <id> --package --root <dir>`.
Validate and exercise it before sharing. Consumers use `tool add <source> --install`
for npm, Git, or a local package; acquisition pins the source and disables lifecycle
scripts. `tool add <installed-name>` remains an offline selection-only path.

Package-manager manifests/locks and any `.firedrill-tools/` vendored source belong
in version control. Runtime `.firedrill/` databases and reports do not. After
installation, starting and testing the world work offline unless the customer's
agent itself needs a model or another explicitly configured external service.

Publish from your own repository or share a reviewed archive. Optionally maintain
an index using the [discovery contract](tool-discovery.md). Indexing never transfers
source ownership, supplies a license, certifies a package, or silently upgrades it.
See [installation details](tool-installation.md) for exact selector and trust rules.
