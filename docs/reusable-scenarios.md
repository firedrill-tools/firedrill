# Save useful tool data for the next run

A scenario is a reusable starting situation. Once your agent or a manual tool
call has created useful data, you can save that data as an ordinary repository
file and start a fresh environment from it.

## In the inspector

1. Start the environment with `firedrill serve` and use its tools.
2. Open **State & activity → Save as scenario**.
3. Give the scenario an ID and optionally a title. Preview the records.
4. Choose **Save new scenario**. Firedrill creates
   `<sourceRoot>/scenarios/<id>.scenario.json` without overwriting anything.

The preview hides sensitive fields. If these exist, saving their original values
requires explicit confirmation. The saved file is source, not an ignored report:
inspect it for secrets before adding it to Git. The running world is unchanged.

Start a new environment with the saved data:

```sh
firedrill serve --scenario after-first-action
```

You can also select the scenario in a drill's `scenarioId` or with
`createLocalWorld({ scenario: "after-first-action" })`.

## From a test or coding agent

```ts
const preview = world.exportScenario({ id: "after-first-action" });

// Review preview.scenario before writing it. Export itself writes nothing.
const saved = await world.saveScenario({
  id: "after-first-action",
  expectedSourceHash: preview.sourceHash,
  expectedGeneration: preview.generation,
});
```

Both methods accept an optional `title` and `packages` array. With no package
selection, all tools are captured. The other tools keep baseline data when only
selected packages are captured. A stale preview, changed world baseline or tool
code, existing scenario ID, external symlink, or invalid source produces an
explicit error; nothing is overwritten. A reset invalidates the preview even if
it happens to restore identical records.

## What this captures

This is a **tool-data seed**, not a checkpoint. It includes current records and
explicit deletions of records that otherwise would return from the baseline.
It does not copy history, pending callbacks/events, consumed idempotency keys,
random position, clock, actor permissions, or fault state. Those settings inherit
the repository's world baseline. Add explicit scenario settings in source if
your next test needs them. Full runtime snapshots and data scenarios serve
different purposes.

The export is bounded to 50,000 records/deletions and 1 MiB of formatted JSON,
matching the compiler's source-file limit. Oversized exports fail before any file or
directory is created. For a larger world,
capture selected packages or create a scenario through ordinary source files.
Exporting or saving data never marks an agent as tested or passed.
