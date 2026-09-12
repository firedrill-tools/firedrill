# Install independently maintained Tools

A Tool does not need to live in Firedrill's repository or catalog. Its author can
publish an npm package, maintain it in a Git repository, or share a local package.
The same package contract and inspection rules apply to every author.

`tool add` without `--install` selects an already installed package. Installation
requires the explicit `--install` flag; inspecting a catalog never installs code.

```sh
firedrill tool add @your-team/device-store --install
firedrill tool add @your-team/device-store@1.2.0 --install
firedrill tool add ./packages/device-store --install
firedrill tool add ./device-store-1.2.0.tgz --install
firedrill tool add github:your-team/test-tools#v1.2.0::packages/device-store --install
firedrill tool add https://git.example.com/your-team/test-tools.git#main::packages/device-store --install
```

Registry selectors accept a package name, exact version, simple semver range such
as `^1.2.0`, or distribution tag. `owner/repo` is shorthand for GitHub; prefix it
with `github:` when you want the source to be especially clear. A Git selector
uses `#ref` for a branch, tag, or commit and `::directory` for a package subfolder.
Omit both for the repository's default branch and root package. Quote local paths
containing spaces. For an explicitly local Git repository, use
`git+file:///absolute/repository#main::packages/device-store`.

## What installation does

1. Fetches or packs the requested source without lifecycle scripts.
2. Inspects package metadata, the Tool declaration, declared module paths, engine
   compatibility, optional starter data, and optional UI assets without importing
   Tool behavior.
3. Installs it as an exact development dependency with lifecycle scripts disabled.
4. Checks installed source against the reviewed package bytes, then selects its
   package name in the Firedrill project.

`serve`, `run`, and Tool conformance checks still execute code. Installing or
passing source inspection does **not** certify safety or real-service fidelity.
Review the author and code as you would any executable testing dependency.

Tools must ship the files they need. Firedrill never runs `prepare`, `prepack`,
`postinstall`, a build command, Git hooks, or submodules during acquisition. If a
package's declaration refers to built files, its author must include those files
in the distributed source. Ordinary TypeScript or JavaScript behavior source can
also be shipped for Firedrill's compiler to bundle later.

Private registry credentials remain in your normal npm configuration. Private
HTTPS Git sources use your Git credential helper. URLs containing credentials or
query parameters are rejected; never paste a token into a Tool selector. Network
acquisition does not imply account creation or source upload to Firedrill.

## Files to commit

- `package.json` and the npm or pnpm lockfile.
- Firedrill's project configuration and authored world source.
- For Git, local directories, and tarballs: the referenced `.firedrill-tools/`
  content-addressed archive and its small provenance JSON file.

`.firedrill-tools/` contains **source dependencies**, unlike `.firedrill/`, which
contains generated runtime data and should remain ignored. Vendored archives make
a fresh clone installable without the author's original directory or a temporary
checkout. Git provenance records the exact resolved commit; local provenance
records the archive digest, not the author's absolute filesystem path. npm
packages use their exact resolved version and ordinary package-manager integrity
lock. Updating a branch or changing local source requires another explicit add;
existing installed builds do not silently track moving source.

Installation rejects links, parent traversal, duplicate archive paths, generated
reports/state, and known secret-bearing files. Limits are 32 MiB compressed,
64 MiB expanded, 16 MiB per file, and 4,096 entries. These checks reduce accidental
exposure; they cannot identify every secret in arbitrary source. Use a package
`files` allowlist and review its packed contents before sharing.

For both Git repositories and local directories, the safety check applies to the
final npm package after its `files` allowlist. An excluded `.env.example` or
generated-report folder does not prevent installation. If either is included in
the distributable archive, installation rejects it. Raw Git staging still rejects
links, parent traversal, duplicate files, and oversized contents before packing.

Local directories are size-checked before packing. Acquisition commands have a
two-minute deadline, and Git/archive downloads use a 128 MiB temporary-storage
watchdog. The watchdog is a best-effort resource limit, not an operating-system
disk quota; use a small package repository or select its package subdirectory.
Registry installation verifies the entire installed file set against the fetched
archive and checks npm's saved integrity before selecting the Tool.

If dependency installation fails, no Tool is selected. npm or pnpm may have changed
the dependency manifest or lock before failing; inspect those changes before
retrying. Acquisition never rolls back unrelated project edits or deletes source
dependencies.
