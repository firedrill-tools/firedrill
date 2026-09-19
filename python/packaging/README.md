# Python releases

The Python distribution is `firedrill-run`. The import and executable are
`firedrill`. It uses the same local engine and Tool format as the npm packages.

Each supported operating system builds its own wheel. End-user installation
does not invoke an npm build or fetch a runtime. Native runtime archives and
package-manager archives are pinned by digest. The release deliberately has no
source distribution or universal fallback wheel.

## Build and verify locally

From the repository root, using the normal contributor build environment:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx tooling/build-python-runtime.mts
python -m pip install build
cd python
python -m build --wheel --no-isolation
cd ..
python python/packaging/verify_wheel.py python/dist/<wheel>.whl --agent --sdk-tests python/tests
```

The verifier creates a separate environment, installs the wheel offline, and
removes external Node/npm/pnpm from PATH. It exercises CLI initialization, actual
Tool operations, assertions, reports, tamper detection, Tool installation and
conformance, the inspector, and the Python SDK suite. Install the test browser
first with `pnpm --filter @firedrill-run/browser-tests exec playwright install
--with-deps chromium`. The optional Agent probe initializes the official SDK
with no provider credentials or model request.

## Publish

Configure a PyPI pending trusted publisher before the first release:

- Project: `firedrill-run`
- Owner: `firedrill-tools`
- Repository: `firedrill`
- Workflow: `python.yml`
- GitHub environment: `pypi`

Use GitHub environment protection for release approval. No PyPI API token is
stored in the repository. Trusted publishing exchanges the workflow identity
for a short-lived upload credential.

Update the version in `python/pyproject.toml` and `python/build_backend.py`
together, then merge the reviewed change. From the canonical repository:

```sh
gh workflow run python.yml --ref main -f publish=true
```

The workflow builds and exercises all five native wheels. Publication cannot
start unless every native job passes. The upload job accepts only the complete
platform set with one matching distribution/version, using artifacts from that
same workflow run. PR runs never publish. A manual run without `publish=true`
only produces verified artifacts.

After upload, verify PyPI lists all five files and install from the registry in
a fresh Python environment. Do not claim publication from a local wheel or a
successful build alone. Never replace an already published version's bytes.
