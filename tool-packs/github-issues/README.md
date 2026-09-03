# GitHub Issues Tool pack

This package supplies a small, stateful GitHub REST API-compatible Issues surface to a Firedrill world. An existing agent can point the official JavaScript client at the per-drill HTTP URL and use its normal `auth` option. Reads, comments, issue updates, failures, events, and resulting state remain part of the same isolated world and evidence timeline.

The compatibility claim is deliberately narrow. Version `0.1.0-rc.1` is checked with `@octokit/rest@22.0.1` against four methods:

- `rest.issues.get`
- `rest.issues.createComment`
- `rest.issues.listComments`
- `rest.issues.update`

No other GitHub API operation is implied. Unsupported routes fail locally and never fall through to GitHub. The pack does not reproduce permission scopes, pagination metadata, conditional requests, custom media types, or the complete response field set. Run `firedrill tool inspect github-issues` to see the exact client version, routes, verified flows, fidelity, and limitations from machine-readable manifest data.

## Select the Tool

Install the package with the package manager used by the agent project, then select it in `firedrill.json`:

```json
{
  "schemaVersion": 1,
  "toolPackages": ["@firedrill/tool-github-issues"]
}
```

Define issue and comment records in the repository's world or scenario source. During a drill, configure the existing client with the binding values supplied by Firedrill:

- client `baseUrl` ← `FIREDRILL_HTTP_URL`
- client `auth` ← `FIREDRILL_HTTP_TOKEN`

The token is random, actor-scoped, invocation-scoped, and accepted only by the local synthetic routes. The agent's client remains otherwise unchanged.

## Conformance

Maintainers run the same public check available to other Tool authors:

```sh
firedrill tool test github-issues
```

The conformance suite uses the unchanged official client to execute a successful read-comment-close flow and a provider-shaped rate-limit failure. It covers every declared operation and error, verifies emitted events and state consequences, rejects an unsupported official-client method at loopback, and repeats the suite with the same seed to prove deterministic world behavior.
