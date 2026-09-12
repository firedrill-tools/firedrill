# Publish a Tool from your own repository

A Firedrill Tool does not need to live in the Firedrill repository. Keep it in your
application, maintain an independent package, or contribute it to the built-in
library. All three use the same declaration and behavior contract. No account,
central approval, special namespace, or public repository is required to run it.

## Create an independent package

```sh
firedrill tool create record-store --package --name @your-team/record-store --root ./record-store
cd record-store
```

Use `--template stateless` for a Tool that computes a response without storing
state. The default stateful template supplies read/write behavior and a missing
record error. These are starting points, not limits on the operations you can add.

The destination must be new or empty. Nothing is installed or executed by this
command. The generated package contains:

```text
record-store/
  package.json                         # package identity, files, Tool entry point
  firedrill.json                       # author-owned conformance project
  starter.json                         # initial synthetic data for consumers
  firedrill/
    tools/record-store/
      record-store.tool.json           # operations, schemas, state, protocols
      behavior.mjs                     # the functions implementing those operations
    world.json                         # conformance actor and grants
    baseline.scenario.json
    agent.target.json
    tool-behavior.drill.json
    conformance.suite.json
  test/conformance.mjs                  # exercises the Tool over real local HTTP
  README.md
  .gitignore
```

Install the reviewed CLI and Tool SDK versions in `package.json`, then run
`npm run validate` and `npm test`. The generated target is an ordinary Node
script testing the Tool, not an LLM agent. No build step is required. Until
Firedrill packages are published, install reviewed local package archives instead
of assuming the versions are available from npm.

Change `UNLICENSED` to a license you choose and add the corresponding license file
before distributing the package. Firedrill does not require independently
maintained Tools to use its own license. Include your license in the package's
`files` list. Contribution to the Firedrill repository has its own
[contribution terms](../CONTRIBUTING.md).

## Package contract

The ordinary npm `package.json` identifies the declaration. It must export
`./package.json`, have a valid npm name and version, and include these fields:

```json
{
  "name": "@your-team/record-store",
  "version": "1.0.0",
  "type": "module",
  "exports": { "./package.json": "./package.json" },
  "firedrill": {
    "layer": "tool-pack",
    "tool": "firedrill/tools/record-store/record-store.tool.json",
    "starter": "starter.json",
    "lifecycle": "active",
    "conformance": {
      "schemaVersion": 1,
      "project": "firedrill.json",
      "suite": "conformance"
    }
  }
}
```

`starter` and portable `conformance` are optional. The Tool declaration's manifest
version must match the npm package version. `lifecycle` can be `active`,
`deprecated`, or `revoked`; revoked packages cannot be selected. Declaration,
behavior, starter, optional app assets, and conformance files must be packaged
inside the package. They must not depend on a framework source checkout.

The machine-readable metadata contract ships as
`@firedrill/compiler/schema/installed-tool-package`; the declaration contract is
`@firedrill/compiler/schema/tool-source`. The installed schemas work without a
documentation server. See [compatibility](compatibility.md) for engine/version
rules and [Tool apps](tool-apps.md) for optional browser interfaces sharing the
same state.

The older string form of `firedrill.conformance` names an author-repository suite
only. It is accepted for compatibility but does not mean consumers can run a
suite the package did not ship. Use the versioned object above for portable
conformance.

## Share and consume

`npm pack --ignore-scripts` creates an archive without running package lifecycle
scripts. Review its file list before sharing. Publish from your own registry or
repository when ready; publishing is not part of Tool creation. Never include
`.firedrill/`, dependencies, credentials, private evidence, or test transcripts.

An installed package is selected with its actual package name:

```sh
firedrill tool add @your-team/record-store
firedrill serve
```

The baseline remains editable in the consumer's repository. Adding another Tool
does not silently widen existing actors' permissions: the command reports the
exact grants the consumer should add. Tests can layer their own data, failures,
and behavior overrides without modifying the package.

## Independently check an installed Tool

```sh
firedrill tool inspect record-store
firedrill tool validate record-store
firedrill tool test record-store
```

Inspection reads source without executing behavior. Validation loads the Tool.
Testing runs conformance twice and checks declared operation/error/event/fault
coverage plus reproducible results, state, and activity. The result reports
`suiteSource: "repository"` or `"package"` so the source of the checks is clear.

A matching suite in the consumer project takes precedence. An explicit
`--suite` always means that consumer suite; a miss is an error, not a fallback.
When no consumer suite is selected, portable package conformance runs from a
bounded source copy under the consumer's `.firedrill/tool-tests/`. Installed
dependencies are never modified. The suite must be a self-contained project
with one Tool, no external `toolPackages`, and the exact installed Tool contract,
behavior, and app assets. A substitute implementation is rejected. Symlinks and
source copies exceeding 4096 entries, 32 directory levels, or 32 MiB are rejected.
Dependencies, Git metadata, generated state, and common secret files are excluded
from the copy. Conformance targets should use packaged source and Node built-ins;
no package install or build scripts are run during this process.

These are **author-supplied tests**, not independent certification that the Tool
perfectly reproduces a real service. State precise supported operations and known
limits in your README. Conformance targets and Tool behavior execute with local
authority: review them before running, just as you would a test dependency.
