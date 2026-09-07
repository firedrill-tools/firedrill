# `@firedrill/compiler`

Compiles repository-owned Firedrill source and explicitly selected Tool packages into a versioned canonical IR, exact Tool artifact lock, and immutable local build.

The compiler discovers typed YAML or JSON resources by suffix inside the configured source root:

- `*.tool.yaml` / `*.tool.json`
- `*.scenario.yaml` / `*.scenario.json`
- `*.target.yaml` / `*.target.json`
- `*.drill.yaml` / `*.drill.json`
- `*.suite.yaml` / `*.suite.json`

Tool behavior is ordinary TypeScript or JavaScript supplied by the world author or an installed package listed in `firedrill.json` under `toolPackages`. Installed packages must export `./package.json` and declare `firedrill.layer: "tool-pack"`, their Tool resource as `firedrill.tool`, and an explicit lifecycle. The compiler resolves only those named packages, confines their authored declaration and behavior closure to the package, embeds the compiler-owned Tool behavior runtime into the content-hashed artifact, and records package name and version in the lock. A consumer installs the selected pack, not its implementation dependencies separately. A deprecated installed version compiles with `FD1403`; a revoked installed version is refused. This decision uses local package metadata and never contacts a registry.

Behavior is bundled and hashed without being executed by the compiler. Loading and validating executable artifacts is a separate runtime boundary. `firedrill format` only changes repository-owned files; dependencies are never rewritten.

Actors in the world baseline, named scenarios, and inline drill scenarios may include an optional `description` string of 1–500 characters containing at least one non-whitespace character. It is authoring and inspection metadata, separate from `attributes` and operation `grants`; it does not grant permissions or become an agent prompt. Authored text is preserved in the compiled build without trimming. Scenario actor entries still replace the complete baseline actor with the same `id`, so an overriding actor must repeat any description it should retain.

`packWorldBuildArtifact({ build, archivePath })` writes a portable, reproducible
`.tgz` from a materialized compiler result. It verifies and packages only compiled
artifacts, never executes Tool behavior, and never includes repository source,
environment files, live databases, or reports. The destination must be new;
existing files are not overwritten. The result includes its byte count and SHA-256.
