# @firedrill-tools/reporters

Account-free local reports for a completed Firedrill trial. It renders the same sealed run and ordered evidence as terminal text, combined JSON, JUnit XML, and a self-contained HTML file. Bundles also retain the redacted run and ordered JSONL evidence as separate machine-readable artifacts.

## One place to open reports

The CLI and `runDrills()` refresh `.firedrill/reports/index.html` after saving reports. Open that file to search by drill, agent, scenario or run ID, filter results, and browse pages of executions. Each row opens its verified individual report. The SDK returns this entry point as `reportIndex`; a custom `reportDirectory` gets its own index.

`writeReportIndex(reportDirectory)` provides the same refresh for custom reporting integrations. It scans at most 10,000 directory entries, considers the 500 newest report folders, and verifies at most 256 MiB of bundle content. The page visibly discloses when limits omit reports. "Report saved" is filesystem modification time, not execution time or virtual duration. Corrupt, incompatible, unreadable or symlinked reports are listed as unavailable without links to untrusted HTML; temporary directories are skipped.

The index lives outside immutable run bundles and does not modify them. It is a navigation aid, not signed or sealed evidence. Publication is an atomic file replacement behind a bounded cross-process lock. If a writer crashes, the next call reports the stale lock rather than stealing ownership; confirm no writer remains before removing only `.report-index.lock` from that report directory and rerunning. A live competing writer has five seconds to finish before the caller receives an actionable timeout.

Keep the index and generated reports Git-ignored. To share browsable history, copy the index together with its corresponding run folders after reviewing them for sensitive data; the index alone does not contain the reports.

## Bundle integrity

The report bundle is written atomically and contains no hosted-platform dependency. `verifyLocalReport()` checks the manifest, exact file set, artifact hashes, schemas, identities, evidence range, reproduction metadata, and agreement between every derived projection. The manifest keeps source hashes from the sealed unredacted run separately from semantic hashes of the redacted values actually stored in the bundle, so verification is never skipped merely because redaction occurred. Structural fields such as status, verdict, identity, and operation names are not rewritten when a secret happens to share the same string value. This detects corruption and internally inconsistent local bundles; it does not prove authorship because local bundles are deliberately unsigned.

`verifyEvidenceAttestation()` separately verifies an ECDSA P-256 signature over the exact manifest bytes and their reproduction, state, evidence, and trajectory hashes. The caller supplies the signed envelope and the issuer's public verification-key record, including its rotation or revocation status; the verifier makes no network request and does not treat a key embedded beside a signature as trusted. This open verifier lets a hosted service add authorship/provenance without changing local report semantics or making local execution depend on that service.

## Recorded comparison details

`compareLocalReports(baselineDirectory, candidateDirectory)` includes expectation-only check changes even when the recorded status and actual value match. `expectedChanged` is additive; no assertion is re-evaluated.

`compareLocalReportDetails(baselineDirectory, candidateDirectory, { kind, offset?, limit? })` verifies both complete reports and returns one bounded page of changed recorded entries. `kind` is `state_changes`, `operations`, or `assertions`; offset counts changed entries, defaults to zero, and `limit` defaults to 10 with a maximum of 25. `nextOffset` continues the same immutable pair.

- State changes align by exact package/namespace/record ID and per-record mutation ordinal. Each side retains the original before/after entry. Seed loading is included; this is neither agent-only changes nor reconstructed final state.
- Operations align by their one-based position among recorded calls. An insertion shifts subsequent positions; this is not a causal match or minimal edit script. Changed arguments, operations, outcomes, actor, idempotency and override fields are reported, excluding incidental evidence identities and timing.
- Checks align by checkpoint/assertion ID and retain their complete recorded result, including matcher conditions, actual values and evaluator status.

Each side is `available` with the unchanged JSON value, canonical-JSON UTF-8 byte count and SHA-256; `omitted` with exact bytes/digest when the value exceeds 16 KiB; or `absent` when no entry exists at that alignment key. Omission never returns a misleading prefix. Use the original verified `evidence.jsonl` or `run.json` to inspect the full entry. Absent does not imply a world record was deleted. Pages include exact manifest-byte digests and redaction metadata. Only retained values are compared; redacted originals are not recovered. Redacted reports are descriptive-only, and incompatible inputs remain incompatible. No model execution, world mutation or quality verdict is inferred.
