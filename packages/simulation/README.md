# @firedrill/simulation

Versioned read and control projections for local Firedrill simulations.

`startLocalSimulationServer()` binds to loopback, compiles one repository, runs its drills through `@firedrill/sdk`, and exposes versioned World/Drill/Run JSON views for local inspectors. The World projection includes the compiled baseline, resolved scenarios, actors and permissions, seeded state, Tools, faults, initial events, and repository provenance. Clients can also compare two verified sealed runs; the response contains compatibility and factual deltas but no local report path. The server does not expose SQL, accept arbitrary filesystem paths, or give an evaluated agent world-control authority.

The server requires its random bearer token on every project, run, state, evidence, and control route. The static health route reveals no repository data.

Source reads are keyed by compiled resource kind and identity rather than a caller-provided path. They are limited to regular text files already present in the compiled repository projection and fail closed on missing files, symlinks, and files over 1 MiB.

It is an adapter, not another runtime: repository source is compiled by `@firedrill/compiler`, drills run through `@firedrill/sdk`, and live or retained state is read from the same per-run SQLite worlds that produce local evidence and reports.
