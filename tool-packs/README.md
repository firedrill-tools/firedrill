# Reusable Tool packs

This directory is the home for reusable, community-maintained Tools that model common agent action surfaces. Tool packs are plugins; framework core must remain unaware of their vendors, operation names, state shapes, and policies.

It is one home, not the only home. Authors can maintain and distribute compatible
Tools in their own repositories without submitting anything here. See the
[open Tool contract](../docs/tool-compatibility.md),
[independent package workflow](../docs/tool-packages.md), and
[optional discovery indexes](../docs/tool-discovery.md).

The [`work-queue`](work-queue/README.md) package is a deliberately neutral reference implementation of the package contract. It proves that a separately packed dependency can be explicitly selected, inspected without executing code, bundled into an immutable build, executed through ordinary bindings, and refused by the contribution command when invoked from a consumer installation. The [`github-issues`](github-issues/README.md) package proves a separate, bounded compatibility path through an unchanged official client.

The [`mailbox`](mailbox/README.md) pack models actor-owned messages and a synthetic draft-to-sent lifecycle; the [`object-storage`](object-storage/README.md) pack models actor-owned UTF-8 text objects. Both supply bounded pagination, optimistic versions, deletion, and shared HTTP/MCP world state. They are generic semantic APIs, not complete email or storage service replicas. None of these packs is evidence of independent community adoption, and none is published yet.

Consumers install a pack with their normal package manager and list its package name once in `firedrill.json`:

```json
{
  "schemaVersion": 1,
  "sourceRoot": "firedrill",
  "world": "world.yaml",
  "toolPackages": ["@firedrill-tools/work-queue"]
}
```

The ordinary workflow is then:

```sh
firedrill tool inspect <tool-id>
firedrill tool validate <tool-id>
firedrill run <drill-id>
```

Pack authors keep conformance drills beside the pack and run `firedrill tool test <tool-id>`. The generated registry has a [human-readable catalog](../registry/README.md) and a [machine-readable index](../registry/index.json). Both record validated package metadata, operation-level fidelity, and any exact official-client compatibility profile. They are discovery metadata, never a claim that an entire service is replicated. Packages are independently versioned and explicitly selected, so installing one never activates the rest of the catalog.

Every reusable pack declares `active`, `deprecated`, or `revoked` lifecycle metadata. Deprecated installed versions remain runnable and produce warning `FD1403`; revoked installed versions are refused. These offline decisions use the metadata in the exact installed package. The catalog cannot silently disable code on a developer's machine.

An author may run `firedrill tool contribute <tool-id> --accept-apache-2.0` from the Tool's owned source repository. The command prepares a local, non-overwriting review bundle; it never uploads or opens a pull request. A consumer installation is intentionally refused. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for provenance, licensing, conformance, capability, fidelity, and secret-review rules.
