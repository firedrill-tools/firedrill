# Find independently published Tools

A Tool does not have to live in Firedrill's repository. Its author can maintain
it in any repository, publish an npm package, or share a Git revision directly.
Adding it to the bundled catalog is optional. Discovery is metadata lookup—not
installation, code execution, or a security endorsement.

## Search a catalog

Without an index option, search reads only the catalog shipped with your CLI:

```sh
firedrill tool list
firedrill tool search records
```

An author, team, or community can share its own index:

```sh
firedrill tool search records --index https://example.org/tool-index.json
firedrill tool list --index ./team-tools.json --offset 0 --limit 25 --json
```

Search results include the package name, exact version, declared operations,
limits, metadata origin, and an `installSource` to pass to `tool add` explicitly.
Searching an index never installs or activates its entries. Installing a Tool
does not prove its behavior matches a real service; read the source and run its
conformance checks before trusting it.

Pagination uses `offset` and `limit` (default 25, maximum 100). `total` counts
matching active entries. Deprecated and revoked entries are not offered for
installation. Search matches the title, package name, description, Tool ID,
operation IDs, and keywords, preserving the index's order.

Tool selection searches the full index, not only the displayed page. If the same
name or Tool ID has multiple active versions, select an exact `name@version` or
the result's `installSource`; Firedrill does not silently pick the last entry.

## Publish an index

The same version-1 shape is used by the bundled catalog and external indexes.
A minimal entry looks like this:

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "packageName": "@your-team/tool-records",
      "packageVersion": "1.2.3",
      "title": "Synthetic records",
      "description": "Stateful records for testing agents.",
      "lifecycle": "active",
      "keywords": ["records"],
      "tool": {
        "id": "records",
        "operations": [
          { "id": "records.get", "fidelity": "stateful" }
        ],
        "compatibility": [
          { "limitations": ["Only explicitly declared operations are supported."] }
        ]
      }
    }
  ]
}
```

`packageVersion` is an exact version, never `latest`, `*`, or a range. Omitted
`source` means npm distribution. Git-backed entries add an explicit immutable
source; `subdirectory` is optional:

```json
{
  "kind": "git",
  "url": "https://example.org/your-team/tools.git",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "subdirectory": "tools/records"
}
```

Put that object in the entry's `source` field. The full Git revision and
subdirectory become the installation selector. Git metadata must still declare
the package's name and exact version, so users can identify it independently of
where it is stored. An index cannot substitute a mutable branch for a revision.

The public Draft 2020-12 JSON Schema ships at
`@firedrill/cli/schema/tool-index.json`. The matching runtime validator and reader
are exported from `@firedrill/cli/tool-discovery`:

```ts
import { discoverTools, resolveDiscoveredTool, ToolIndexSchema } from "@firedrill/cli/tool-discovery";

ToolIndexSchema.parse(yourIndex);
const results = await discoverTools({
  root: process.cwd(),
  index: "./team-tools.json",
  query: "records",
  offset: 0,
  limit: 25,
});
const selected = await resolveDiscoveredTool({
  root: process.cwd(),
  index: "./team-tools.json",
  selector: "@your-team/tool-records@1.2.3",
});
```

No central registration, Firedrill login, or contribution agreement is required.
Package licensing and redistribution remain the author's responsibility.

## What is verified

Every index is parsed and validated before results appear. Duplicate package
name/version entries and duplicate operation IDs are rejected rather than
silently merged. The runtime validator enforces these cross-entry checks in
addition to the exported JSON Schema's structural checks.

When the same package name, exact version, and Tool ID are installed locally,
discovery reads its declaration without importing its behavior. Operation and
limitation metadata then comes from that declaration and is labeled
`installed-declaration`. Otherwise it is labeled `publisher`. Titles and
descriptions always come from the index. Neither label means independent
provider-parity verification, signature verification, or safe executable code.
The installed check does not establish that a package came from the index's
Git URL; installation provenance and locked build identity are separate checks.

Indexes are limited to 2 MiB and 1,000 entries. Remote requests require HTTPS
(HTTP is allowed for loopback development), finish within 10 seconds, and never
follow redirects or send authentication. Index URLs cannot contain credentials,
queries, or fragments. For a private authenticated index, download it through
your existing authenticated tooling and pass the local JSON file. Cancellation
is supported through the programmatic reader's `signal`.

The CLI has no background registry lookups. Installed Tools continue working
without access to an index.
