# @firedrill/reporters

Account-free local reports for a completed Firedrill trial. It renders the same sealed run and ordered evidence as terminal text, combined JSON, JUnit XML, and a self-contained HTML file. Bundles also retain the redacted run and ordered JSONL evidence as separate machine-readable artifacts.

The report bundle is written atomically and contains no hosted-platform dependency. `verifyLocalReport()` checks the manifest, exact file set, artifact hashes, schemas, identities, evidence range, reproduction metadata, and agreement between every derived projection. This detects corruption and internally inconsistent local bundles; it does not prove authorship because local bundles are deliberately unsigned. Hosted attestation is a separate operational capability.
