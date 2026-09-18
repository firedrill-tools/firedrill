# Start local tools for your agent

Firedrill gives your existing agent fake tools with controlled data and behavior.
Start the backend, try a call, and see the data change. Add repeatable tests when
you need to check the agent's decisions.

Everything here runs locally without an account or Docker. Tools are trusted test
code, not sandboxed code. Only the optional authoring assistant needs a model key.
The agent you test keeps its own model/provider configuration.

## Install this release candidate

In the project that contains your agent, install the CLI locally:

```sh
npm install --save-dev @firedrill-run/cli@next
npx firedrill init
npx firedrill serve
```

The commands below use `firedrill` for readability. Prefix them with `npx` when
you have not added a package-manager script or shell alias. Framework contributors
can still build and invoke the CLI from a source checkout.

## 1. Choose tools

From your agent's project:

```sh
firedrill init
```

The terminal offers real catalog tools and an option to create your own. A pack
lists its actual supported operations and limitations. Installing a catalog pack
requires permission and uses the package manager with lifecycle scripts disabled.
An installed pack is selected without downloading it again. Missing packages
produce a clear installation error; Firedrill never substitutes a sample
and calls it compatible.

For coding agents and scripts:

```sh
firedrill init --search queue --json       # inspect the catalog; no writes
firedrill init --tool @scope/firedrill-tool # select an installed package
firedrill init --custom my-tool --json     # create editable local source
```

The custom starter implements a small record store. It is scaffolding to adapt,
not a replica of the service your agent uses. Replace its declaration and behavior
with the real inputs, responses, errors and effects you need. A stateless tool is
also supported: `firedrill tool create my-tool --template stateless`.

Use `firedrill tool list` to browse packages and `firedrill tool search <text>`
to narrow the catalog, or add `--index <path-or-url>`
to read an independently maintained index. `init --index <path-or-url>` uses that
index in the same setup chooser. An index is optional; it doesn't own or certify
the packages it lists.

Install a Tool directly with `firedrill tool add <source> --install`: an npm package,
Git repository/subdirectory, or local package directory/archive. See
[exact syntax and source pinning](tool-installation.md). No contribution to the
Firedrill repository is required. Without `--install`, selection remains offline.

Add tools later with `firedrill tool add <installed-package>` or
`firedrill tool create <id>`. Your project may use several tools together in one
synthetic environment. They can change shared state through declared contracts.
Neither the kernel nor the setup flow assumes a particular vendor or agent type.

## 2. Customize only what you need

Use the defaults, edit the repository files, ask your own coding agent, or choose
**Firedrill Agent** during setup. The choices use the same source format.

- **Your coding agent:** setup installs the canonical skill and a repository
  brief. Ask it to prepare tools for your actual agent. Detection is a hint, not
  proof of the interfaces your agent uses.
- **Firedrill Agent:** the optional `@firedrill-run/agent` package uses Claude Agent SDK
  with `ANTHROPIC_API_KEY` from your shell or secret manager. It explains source
  transmission and spending before starting from the wizard. No key is requested
  in a text prompt or written to source. If the key/package is missing, the CLI
  gives a resume command; manual setup still works.

```sh
firedrill agent                       # prepare or edit a synthetic environment
firedrill agent --workflow drill      # explicitly author an agent test
```

The assistant's environment completion is independently checked: valid source,
loadable tools and actual listener startup. It does not prove tool fidelity or
that your agent has been tested. Source-only programmatic authoring reports
`source-validated`, not runtime readiness.

No sign-in is required, and authenticating an optional cloud client never changes
local execution. Cloud authoring is not implemented by this OSS flow.

## 3. Start the environment

```sh
firedrill serve
```

Keep this terminal open. It starts the tools and a local inspector for **the same
running world**, prints connection variables, and opens the browser. Ctrl+C closes
the listeners. Use `--no-open` to keep browser launching manual, or `--json` for
machine-readable startup and shutdown messages. Generated files stay under the
project's ignored `.firedrill/` directory.

No drill, target or assertions are required. By default, the world file supplies
starting data and actor permissions. `--scenario <id>` chooses a defined variation;
`--actor <id>` chooses an identity if there is more than one. Ports default to
available loopback ports; use the actual connection values, not a memorized URL.

In the inspector:

- **Tools:** open a tool to read its inputs, outputs and implemented behavior,
  inspect starting data, and try an operation against the running backend.
  If the pack includes a UI, **Open app** opens its usable interface in a new tab.
  It shares the backend's live state; see [Tool apps](tool-apps.md).
- **State & activity:** see current records and recorded calls. Manual
  playground calls are operator checks, not agent test results.
- **Connect agent:** explicitly reveal/copy the actual HTTP, MCP or CLI connection
  settings. Tokens grant local actor access; do not commit or share them.
- **Drills and results:** define repeatable tasks and review their saved outcomes
  when you are ready. Empty results do not mean anything has passed.

Source views describe repository definitions. Live views describe the immutable
build currently running. Editing source does not hot-mutate that running build:
stop and start to compile your updated definitions.

## 4. Connect the existing agent

Use its existing configurable seam: an HTTP client's base URL, an MCP server,
a CLI adapter, or a separate test harness for native functions and SDK methods.
Firedrill provides the connection values; the application must actually consume
them. Exporting variables an application never reads does not redirect anything.

See [binding recipes](quickstart.md#3-keep-the-agent-integration-at-one-seam) and
[test-side mocks](test-mocking.md). Keep production logic unchanged. Do not fall
back to production for unsupported calls or pretend arbitrary code can be
intercepted. Vendor-specific HTTP routes must be declared by the selected tool;
the generic HTTP protocol is not every vendor's API.

Run your agent as you normally would, with those test-owned connections. Its
actions appear in live activity and change the synthetic records. Your model
continues to choose the actions. A tool sandbox is not an agent runner.

## Reset and repeat

Reset restores the selected baseline, not repository files or the customer's
agent memory. The inspector requires confirmation. A full world reset restores
data, clock, pending work and the baseline journal; current live activity is
cleared back to that baseline. It does not delete saved drill reports. Connections
remain usable. SDK callers can also reset selected tool packages; see
[local world control](local-world-control.md).

For durable repeatable outcomes, add a target and a drill containing the task and
checks. `firedrill run <id>` creates an isolated world and saves a report; it does
not reuse or overwrite the exploratory `serve` world. The same tool behavior and
starting definitions power both paths. Logs/screenshots/video are optional
[capture](capture.md), not prerequisites for simulation.

## Files you own

```text
firedrill.json                 # source location and selected tool packages
firedrill/
  world.yaml                  # baseline data, identities, access and time
  tools/my-tool/
    my-tool.tool.yaml         # inputs, outputs, state schema and capabilities
    behavior.mjs              # what operations actually do
  scenarios/                  # optional starting variations
  targets/                    # optional agent connection for repeatable drills
  drills/                     # optional tasks and assertions
.firedrill/                   # ignored runtime data, builds and reports
```

The initial setup creates only the files it needs, not all these optional folders.
Package-owned starter records are copied into repository-owned source on new-world
creation. Existing worlds are preserved. Runtime writes change SQLite, not YAML
or JSON. You may organize source differently; stable in-file IDs, not these folder
names, define references. Typed source supports both YAML and JSON.
