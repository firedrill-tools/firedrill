# @firedrill/drills

Local drill lifecycle for compiled Firedrill worlds. The package materializes a drill's resolved scenario into an isolated SQLite world, starts only the declared direct/HTTP/MCP bindings, invokes a module, command, HTTP, or caller-owned agent target, settles bounded virtual work, evaluates assertions, and seals state and evidence hashes.

`runDrill` executes the configured trial set with reproducible seeds. `runDrillTrial` is the lower-level single-trial seam. Local report projection lives in `@firedrill/reporters`.

Module and caller-owned targets share the runner process and may overlap under trial concurrency. Their adapters must be reentrant and must not temporarily replace process-global stdout/stderr, environment, working directory, signals, or registries. Inject logging/output dependencies into an importable agent seam, or use a command target when process isolation is required. Command targets are isolated processes: they write at most one JSON result to stdout and send narration or logs to stderr.

Target module and working-directory paths resolve from the consumer repository root. A Tool behavior module is instead relative to its own Tool source file. Command stdout is the target's output payload; do not emit a second `TargetResult` envelope because Firedrill creates that envelope around the parsed value.
