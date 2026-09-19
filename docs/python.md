# Python

Install Firedrill in your Python environment:

```sh
python -m pip install --pre "firedrill-run[pytest]"
firedrill init --path template
firedrill run changes-resource
firedrill inspect
```

The package includes the local runtime and inspector. Python users do not need
to install Node.js or npm. The distribution name is `firedrill-run`; import it as
`firedrill`.

Run drills from your test suite:

```python
from firedrill import run_drills

def test_agent():
    run_drills(root=".", drill="changes-resource").assert_passed()
```

An external target can call an existing Python agent through a sync or async
test callback. `mock_tool` patches imported functions and SDK methods using
ordinary Python test-side mocking. Protocol clients can use HTTP, MCP, or CLI
bindings. `World` and `AsyncWorld` provide direct access to state, virtual time,
faults, resets, and the inspector.

The [Python developer guide](../python/README.md) covers installation, pytest
fixtures, callbacks, subprocess targets, mocks, synthetic environments, browser
tests, captures, reports, tool packages, and the optional authoring agent.

Local Python and TypeScript tests execute the same world and assertion engine.
The separately published `firedrill-cloud` package is the hosted API client;
local tests use `firedrill-run`.
