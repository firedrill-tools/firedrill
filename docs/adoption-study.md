# External adoption study

Use this study before calling Firedrill easy to adopt. It is for an existing action-taking agent repository that was not created as a Firedrill fixture. The participant should not receive architecture notes, internal source paths, or a prepared world.

## What the participant receives

- A versioned Firedrill release bundle or published package coordinates.
- The repository's normal development setup and model credentials, if its owner permits live-model use.
- This prompt and nothing more:

> Add Firedrill to this agent. Preserve its normal entry point and production behavior. Use the Firedrill coding-agent skill installed by `firedrill init --path coding-agent`. Model one real action surface, then add one meaningful drill that verifies an observable consequence or safety invariant. Iterate until validation and the drill pass. Prove the failure path by temporarily breaking one expectation, confirm a non-zero result and local HTML report, restore it, and rerun. Do not publish, upload, or expose secrets.

The participant may read public Firedrill documentation and CLI help. A maintainer may fix genuine framework defects, but must record every intervention.

## Evidence to retain

Record only non-secret study metadata:

- start and finish time;
- agent language, runtime, and action seam;
- Firedrill target and binding used;
- commands attempted and diagnostics encountered;
- human interventions and questions;
- whether the agent invented unsupported source fields or changed production behavior;
- final validation result;
- observed world-backed Tool calls;
- passing drill result and report path;
- intentional failing result, process exit code, and report path;
- restored rerun result;
- whether `.firedrill/` is ignored by Git.

Do not copy the participant's source, prompts, model output, credentials, reports, repository name, or synthetic records into public notes without explicit permission.

## Acceptance

The exercise counts only when all of these are true:

1. Installation uses published packages or the exact packed release artifacts supplied to external consumers, never workspace imports.
2. The existing agent selects and calls a world-backed Tool through one declared Firedrill binding.
3. At least one assertion examines state, Tool behavior, events, or ordering rather than response phrasing.
4. A passing drill produces a locally verifiable report.
5. A deliberately broken expectation fails, returns the documented non-zero result, and produces a useful HTML diff.
6. Restoring the source returns the drill to passing without changing the agent's production logic.
7. No account, networked Firedrill service, or private hosted code is required.

Internal fixtures, maintainer-run clean rooms, and supplied demo agents are useful regression evidence but do not count as external adoption.

## Optional community Tool exercise

Run this separately with a participant who owns a reusable Tool implementation. After its declared conformance suite passes, the owner may run:

```sh
firedrill tool contribute <tool-id> --accept-apache-2.0
```

The participant must inspect the generated bundle and explicitly confirm source ownership, provenance, and Apache-2.0 contribution intent. The command prepares local files only; it must not upload, open a pull request, or imply acceptance into the registry.

## Study summary

For each session, report:

```text
Outcome: passed | framework defect | documentation defect | participant stopped
Time to first observed Tool call:
Time to first passing drill:
Human interventions:
Framework defects found:
Documentation changes needed:
Would the participant use it again? yes | no | unknown
Reason:
```

Five independent sessions across more than one agent stack are the current pre-release acceptance target. At least one session must author a private Tool, and one source owner must prepare the optional sanitized contribution bundle.
