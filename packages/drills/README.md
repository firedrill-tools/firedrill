# @firedrill/drills

Local drill lifecycle for compiled Firedrill worlds. The package materializes a drill's resolved scenario into an isolated SQLite world, starts the declared direct/HTTP/MCP/CLI bindings plus any packaged Tool apps, invokes a module, command, HTTP, or caller-owned agent target, settles bounded virtual work, evaluates assertions, and seals state and evidence hashes.

`runDrill` executes the configured trial set with reproducible seeds. `runDrillTrial` is the lower-level single-trial seam. Local report projection lives in `@firedrill/reporters`.

Module and caller-owned targets share the runner process and may overlap under trial concurrency. Their adapters must be reentrant and must not temporarily replace process-global stdout/stderr, environment, working directory, signals, or registries. Inject logging/output dependencies into an importable agent seam, or use a command target when process isolation is required. Command targets are isolated processes: they write at most one JSON result to stdout and send narration or logs to stderr.

Target module and working-directory paths resolve from the consumer repository root. A Tool behavior module is instead relative to its own Tool source file. Command stdout is the target's output payload; do not emit a second `TargetResult` envelope because Firedrill creates that envelope around the parsed value.

Optional Tool apps start automatically, including for direct-only targets. Module and caller-owned handlers receive `context.binding.apps`; the invocation's `FIREDRILL_TOOL_APPS` environment value is the same array encoded as JSON, and command targets receive it as an environment variable. Each entry contains `packageId`, `title`, and `url`. Apps have separate loopback origins and use only their own Tool's operations with the interaction's actor. Browser actions therefore reach the same SQLite world, assertions, and evidence as other bindings.

App links are ephemeral credentials. Every interaction—including each retry—owns its listeners and closes them when the target finishes, fails, times out, or is cancelled. Framework-issued bindings take precedence over mapped host environment values. Issued app URLs and tokens echoed in target output, error messages, or inline stderr are redacted before the result is retained. Explicit file attachments remain copied verbatim under their existing caller-owned redaction contract; do not attach files or browser traces containing connection credentials.
