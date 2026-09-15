# Mailbox Tool pack

A synthetic, actor-owned mailbox for agent drills. HTTP and MCP operate on the same isolated world state and evidence timeline. This is a generic semantic API, not a provider-compatible email service.

## Select and connect

This pack is not published yet. From this repository, build it and install its locally packed archive into a consumer project. Then explicitly select the installed package:

```sh
firedrill init --tool @firedrill/tool-mailbox
firedrill tool inspect mailbox
```

For an existing project, add `"@firedrill/tool-mailbox"` to `toolPackages` in `firedrill.json`. Installing a package does not activate it. Initialization includes one synthetic inbox message owned by the default `local-dev` actor. Existing worlds supply their own actor grants and scenario data; selecting a pack alone does not insert its starter data.

Use `FIREDRILL_HTTP_URL` as the HTTP origin and `Authorization: Bearer $FIREDRILL_HTTP_TOKEN`. MCP clients connect to `FIREDRILL_MCP_URL` using `FIREDRILL_MCP_TOKEN`; tool names are `mailbox.messages.list`, `mailbox.messages.get`, `mailbox.messages.write`, `mailbox.messages.send`, and `mailbox.messages.delete`. Both bindings are framework-owned, loopback-only, and actor-scoped.

| Operation | HTTP request | Behavior |
| --- | --- | --- |
| `messages.list` | `GET /mailbox/messages?folder=draft&limit=50&cursor=…` | Message headers, excluding bodies |
| `messages.get` | `GET /mailbox/messages/{id}` | Complete message |
| `messages.write` | `PUT /mailbox/messages/{id}` | Create or replace a draft |
| `messages.send` | `POST /mailbox/messages/{id}/send?ifVersion=1` | Draft → sent; emit `message.sent` |
| `messages.delete` | `DELETE /mailbox/messages/{id}?ifVersion=2` | Remove the message |

Writes require an `Idempotency-Key` HTTP header. A draft body is `{"from":"writer@example.test","to":["reader@example.test"],"subject":"Review","body":"Synthetic text","ifVersion":0}`. Semantic MCP arguments additionally include `id`. MCP uses the framework's request-scoped idempotency by default; callers needing retry identity may supply `_meta["dev.firedrill/idempotency-key"]`.

An omitted `ifVersion` permits replacement of the current draft; `0` requires absence, and a positive version must match. Replacement increments the version and resets `read` to false. Only drafts may be replaced or sent. Send does not contact a network service or create a recipient mailbox message. Missing records return `tool.NOT_FOUND` (HTTP 404); optimistic conflicts and invalid lifecycle transitions return `tool.CONFLICT` / `tool.INVALID_STATE` (409). Malformed/filter-mismatched cursors return `tool.INVALID_CURSOR` (400). Input validation and idempotency misuse return framework errors.

## Local app

`firedrill serve` starts the included Mailbox app alongside the selected protocol
bindings. Open its printed app link or choose **Open app** in the inspector.
Browse folders, read messages, compose, save drafts, send synthetic messages, and
delete with confirmation. The app uses the same actor-scoped operations, version
checks, faults, and SQLite state as HTTP and MCP. It does not deliver real email.
App assets are packaged locally; no CDN, Docker, account, or extra server setup is
required. See the developer guide's Tool apps chapter for custom app authoring.

## Pagination and fidelity limits

Lists default to 50 headers, maximum 100, in lexicographic state-row order. A page filters at most 1,000 actor-prefixed rows, plus one continuation lookahead. Sparse filters can produce an empty page with `nextCursor`: keep following that cursor until it is absent. Cursors are bound to the actor and exact folder filter, and are opaque continuation data, not authentication credentials. Pagination is live, not a snapshot; concurrent insertions before a cursor require a fresh listing.

Message IDs are 1–96 safe identifier characters. Bodies are at most 16,384 characters, subjects 512, and recipient lists 1–20 bounded address strings. Addresses are labels, not validated RFC mailboxes. Scenarios may seed inbox, draft, sent, or archive records; state rows are keyed `<actorId>:<messageId>` and include a matching `ownerId`. Other actors cannot read or mutate those messages. Versions restart at 1 after deletion and recreation; they are optimistic counters, not permanent object identities.

There is no external delivery, SMTP/IMAP, MIME, attachment handling, threading, spam filtering, search ranking, mailbox ACL delegation, provider OAuth, delivery receipt, or vendor client compatibility claim. All data is synthetic; use public fixture addresses and content, never live mailbox credentials.

## Verification

`pnpm --filter @firedrill/tool-mailbox test` runs the ordinary public Tool conformance command twice with an identical seed, then public SDK tests. The conformance target uses real HTTP and an unmodified MCP client to cover all five operations, every declared error, a draft lifecycle, retry identity, pagination, emitted events, and deletion. SDK tests additionally cover cross-actor refusal, independent worlds, reset, malformed requests, and sparse pagination beyond the 1,000-row scan bound. The operation fidelity labels describe this tested subset only.
