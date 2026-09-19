# Object storage Tool pack

A synthetic, actor-owned UTF-8 text object store for agent drills. HTTP and MCP share the same isolated world state, events, and evidence. This is a generic semantic API, not a provider-compatible storage service or a mounted filesystem.

## Select and connect

This pack is not published yet. Build it in this repository and install its locally packed archive into a consumer project, then select the installed package explicitly:

```sh
firedrill init --tool @firedrill-tools/object-storage
firedrill tool inspect object-storage
```

In an existing project, add `"@firedrill-tools/object-storage"` to `toolPackages` in `firedrill.json` and supply actor grants and scenario records. Selection alone does not insert starter data. Initialization supplies one text object under bucket `documents`, key `welcome.txt`, owned by the default `local-dev` actor.

HTTP uses `FIREDRILL_HTTP_URL` with `Authorization: Bearer $FIREDRILL_HTTP_TOKEN`. MCP uses `FIREDRILL_MCP_URL` and `FIREDRILL_MCP_TOKEN`; tools are `object-storage.objects.list`, `object-storage.objects.get`, `object-storage.objects.put`, and `object-storage.objects.delete`. Both bindings are framework-owned, loopback-only, and actor-scoped.

| Operation | HTTP request | Behavior |
| --- | --- | --- |
| `objects.list` | `GET /storage/objects?bucket=documents&prefix=notes/&limit=50&cursor=…` | Object metadata, excluding content |
| `objects.get` | `GET /storage/object?bucket=documents&key=notes/readme.txt` | Complete text object |
| `objects.put` | `PUT /storage/object` | Create or replace an object |
| `objects.delete` | `DELETE /storage/object?bucket=documents&key=notes/readme.txt&ifVersion=1` | Remove the object |

Percent-encode query values. Writes require an `Idempotency-Key` HTTP header. The put body and semantic MCP arguments are `{"bucket":"documents","key":"notes/readme.txt","content":"Synthetic text","contentType":"text/plain","metadata":{"purpose":"review"},"ifVersion":0}`. Content type and metadata are optional and default to `text/plain; charset=utf-8` and `{}`. Replacement replaces all content and metadata, not a patch. MCP uses request-scoped idempotency by default; stable retries may supply `_meta["dev.firedrill/idempotency-key"]`.

Omitting `ifVersion` permits replacing the current object. `0` requires absence; a positive value must match the current version. Successful put increments the version and computes UTF-8 `byteLength`. Put and delete emit `object.changed`. Missing reads/deletes return `tool.NOT_FOUND` (HTTP 404), version conflicts `tool.CONFLICT` (409), and malformed/filter-mismatched cursors `tool.INVALID_CURSOR` (400). Input validation and idempotency misuse return framework errors.

## Local app

`firedrill serve` starts the included Object storage app alongside the selected
protocol bindings. Open its printed app link or choose **Open app** in the
inspector. Browse a bucket and key prefix, inspect or edit text content, create
objects, and confirm deletions. The app uses the same actor-scoped operations and
optimistic version checks as HTTP and MCP. It preserves existing object metadata
when editing content. Assets are local; no CDN, Docker, account, or additional
frontend server is required. This remains a text-object tool, not binary storage.

## Pagination and fidelity limits

Lists default to 50 metadata records, maximum 100, in lexicographic state-row order. Each call filters at most 1,000 actor-prefixed rows, plus one continuation lookahead. An empty filtered page can carry `nextCursor`; continue until it is absent. Cursors bind the actor, bucket, and exact prefix. They are continuation data, not credentials. Pagination is live, not snapshot-isolated; new objects sorting before the cursor require a new listing.

Buckets are 1–63 lowercase letters, digits, or hyphens, starting with a letter or digit. Keys are 1–512 characters from letters, digits, dots, underscores, slashes, spaces, and hyphens, starting with a letter or digit. Keys are inert strings: slashes and dots have no filesystem meaning. Text content is limited to 16,384 characters. Metadata is at most 16 string properties with bounded names and values. Versions restart at 1 after deletion and recreation; they are not immutable historical versions.

State rows use `<actorId>:<bucket>:<key>` with matching `ownerId`; other actors cannot access them. Buckets are namespaces, not separately managed resources. There is no binary upload, multipart protocol, filesystem mount, signed URL, object version history, bucket policy, encryption-key management, storage class, replication, retention policy, eventual consistency, or vendor SDK compatibility claim. No external storage network is contacted.

## Verification

`pnpm --filter @firedrill-tools/object-storage test` runs the public Tool conformance command twice with an identical seed, followed by public SDK tests. Real HTTP and an unmodified MCP client cover all four operations and declared errors, UTF-8 byte counts, optimistic conflict handling, retry identity, events, pagination, and deletion. SDK tests additionally prove actor isolation, independent worlds, reset, invalid requests, and sparse pagination beyond the 1,000-row scan bound. The stateful fidelity label covers only this tested semantic subset.
