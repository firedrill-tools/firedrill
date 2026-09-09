# Import selected data

Imports turn a deliberately selected JSON export or read-only HTTP response into
reviewable scenario seed data. They do not change production or your running
environment. Generating synthetic data is still the default; importing real data
is optional and requires your permission to use it.

1. Select the source, Tool namespace and fields in a JSON plan.
2. Preview. Only mapped fields are retained; credentials are never saved.
3. Review all records, including personal or confidential information.
4. Save the exact preview as a new scenario and start an environment with it.

Example `imports/records.import.json` (names are your Tool's own contract):

```json
{
  "schemaVersion": 1,
  "id": "review-dataset",
  "source": { "kind": "json", "path": "exports/records.json" },
  "recordsPointer": "/records",
  "packageId": "record-store",
  "namespace": "records",
  "idPointer": "/id",
  "fields": { "status": "/status", "contact": "/email" },
  "redactions": [{ "path": "/contact", "replacement": "person@example.test" }],
  "maxRecords": 100
}
```

```sh
firedrill data preview imports/records.import.json --allow-read
# Open the printed preview file and review its complete contents.
firedrill data save .firedrill/imports/<hash>.json --expect sha256:<hash> --confirm save-reviewed-data
firedrill serve --scenario review-dataset
```

The CLI prints the exact save command. JSON mode includes the entire preview,
record count, redaction count and expected digest for coding agents. Keep plans
in version control when appropriate. Keep raw exports and `.firedrill/` ignored;
review imported scenario source before committing it.

## Read-only HTTP sources

Replace `source` with an explicit HTTP source. Supply a read-only credential in
the named process environment variable; its value never belongs in the plan:

```json
{
  "kind": "http",
  "url": "https://api.example.test/records?limit=50",
  "headersFromEnvironment": { "Authorization": "IMPORT_AUTHORIZATION" },
  "pagination": { "nextPointer": "/nextCursor", "cursorParameter": "cursor" }
}
```

Run preview with `--allow-read --allow-origin https://api.example.test`. Set
`IMPORT_AUTHORIZATION` to the complete header value required by your source
(for example a Bearer value). Use a credential limited to reading the selected
resource. Firedrill performs GET only, never changes a provider and never follows
redirects. The selected API must actually implement read-only GET semantics.

For a provider returning a next-page URL, omit `cursorParameter`; the next URL
must remain on the exact approved origin. Missing/null/empty cursors end paging.
Repeated pages, excessive pages, excessive records or missing selected IDs fail
instead of silently giving a partial dataset. Defaults: 500 records, 10 pages,
60-second deadline. HTTP requires HTTPS except for explicit loopback fixtures.
This generic connector works with JSON APIs and exports; it does not invent
provider OAuth scopes or claim support for every proprietary pagination scheme.

## Selection and redaction

`recordsPointer`, `idPointer`, field mappings and redaction paths use JSON Pointer
syntax. `fields` is an allowlist: everything else is dropped. `selectIds` can
narrow the retained rows. The Tool's existing schema is authoritative; missing
fields, invalid values and undeclared namespaces fail before saving.

Known credential field names are automatically redacted recursively, including
credentials used by the connector. Personal fields such as email, names and
message bodies require explicit redactions or omission. This is not an automatic
anonymization guarantee. Import fails if redaction no longer satisfies the Tool
schema; use a schema-valid synthetic replacement in `redactions`.

Saving creates only upserts for selected records. Unselected baseline records
remain. It never deletes source, overwrites a scenario, executes Tool behavior,
refetches the provider, changes world time or resets the active environment.
Changed source or a changed preview requires another review.

## SDK

`previewDataImport({ root, plan, consent: "read-selected-source", allowedOrigin,
environment, signal })` returns the same redacted preview. Pass that preview,
its `expectedPreviewHash`, and `confirm: "save-reviewed-data"` to
`saveDataImport()`. The SDK never contacts a source merely because a plan exists.
