# `@firedrill/agent`

Optional local authoring agent for Firedrill. It uses the Claude Agent SDK with the developer's own `ANTHROPIC_API_KEY` to inspect a repository, author or repair Firedrill source, and iterate the public validation and drill loop.

The package is not required to define worlds or run drills. It never owns verdicts, commits, pushes, publishes, reads secret files, or calls hosted Firedrill services. The ordinary `firedrill` CLI and `@firedrill/sdk` remain the source of validation, execution, assertions, and evidence.

Running it invokes Anthropic through the Claude Agent SDK and may send repository content selected during the session to Anthropic under Anthropic's applicable terms. It does not send source to Firedrill. The wrapper is Apache-2.0; the Claude Agent SDK dependency is distributed under Anthropic's own terms.

```sh
pnpm add -D @firedrill/cli @firedrill/agent
export ANTHROPIC_API_KEY=your_key
firedrill init --path firedrill-agent
firedrill agent
```

Each invocation defaults to at most 40 turns, $2 of model spend, and a 15-minute wall-clock deadline. See `firedrill agent --help` for explicit overrides.
