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
