import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentCallback,
  type FiredrillProjectError,
  inspectTool,
  prepareToolContribution,
  runDrills,
  testTool,
  validateTool,
  verifyReport,
} from "../src/index.js";

const directories: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "firedrill-sdk-"));
  directories.push(root);
  mkdirSync(join(root, "world"));
  writeFileSync(
    join(root, "firedrill.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" })}\n`,
  );
  writeFileSync(
    join(root, "world", "world.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "sdk-world",
      seed: "29",
      actors: [
        {
          id: "operator",
          grants: [{ packageId: "record-store", operationId: "records.set" }],
        },
      ],
      state: [
        {
          action: "upsert",
          packageId: "record-store",
          namespace: "records",
          rowId: "primary",
          value: { value: 0 },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(root, "world", "records.tool.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      module: "./records.js",
      manifest: {
        schemaVersion: 1,
        id: "record-store",
        version: "1.0.0",
        engine: ">=0.1.0 <0.2.0",
        capabilities: ["state.read", "state.write"],
        state: [
          {
            namespace: "records",
            schema: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "integer" } },
              additionalProperties: false,
            },
          },
        ],
        operations: [
          {
            id: "records.set",
            inputSchema: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "integer" } },
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "integer" } },
              additionalProperties: false,
            },
            idempotency: "required",
            fidelity: "stateful",
          },
        ],
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "world", "records.js"),
    'export default { operations: { "records.set": (input, context) => { const value = { value: Number(input.value) }; context.state.put("records", "primary", value); return value; } } };\n',
  );
  writeFileSync(
    join(root, "world", "agent.target.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target: { id: "agent-under-test", kind: "external", bindings: ["direct"], timeoutMs: 5_000 },
    })}\n`,
  );
  writeFileSync(
    join(root, "world", "set-record.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "set-record",
      tags: ["regression", "smoke"],
      targetId: "agent-under-test",
      actorId: "operator",
      inlineScenario: {
        virtualTimeUs: 0,
        actors: [
          {
            id: "operator",
            grants: [{ packageId: "record-store", operationId: "records.set" }],
          },
        ],
        state: [
          {
            action: "upsert",
            packageId: "record-store",
            namespace: "records",
            rowId: "primary",
            value: { value: 0 },
          },
        ],
      },
      task: { instruction: "Set the record to the requested value.", input: { value: 7 } },
      assertions: [
        {
          id: "record-set",
          kind: "state.value",
          packageId: "record-store",
          namespace: "records",
          rowId: "primary",
          path: ["value"],
          comparison: { operator: "equals", value: 7 },
        },
      ],
    })}\n`,
  );
  return root;
}

function addSecondDrillAndSuite(root: string): void {
  writeFileSync(
    join(root, "world", "audit-record.drill.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "audit-record",
      tags: ["nightly", "regression"],
      targetId: "agent-under-test",
      actorId: "operator",
      inlineScenario: {
        virtualTimeUs: 0,
        actors: [
          {
            id: "operator",
            grants: [{ packageId: "record-store", operationId: "records.set" }],
          },
        ],
        state: [
          {
            action: "upsert",
            packageId: "record-store",
            namespace: "records",
            rowId: "primary",
            value: { value: 0 },
          },
        ],
      },
      task: { instruction: "Write an auditable value.", input: { value: 11 } },
      assertions: [
        {
          id: "audit-value-set",
          kind: "state.value",
          packageId: "record-store",
          namespace: "records",
          rowId: "primary",
          path: ["value"],
          comparison: { operator: "equals", value: 11 },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(root, "world", "pr.suite.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "pr",
      drills: ["set-record"],
      tags: ["nightly"],
      concurrency: 2,
      retries: 0,
    })}\n`,
  );
}

function addConformanceSuite(root: string): void {
  writeFileSync(
    join(root, "world", "record-store-conformance.suite.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "record-store-conformance",
      drills: ["set-record"],
    })}\n`,
  );
}

function setValueAgent({ task, binding }: Parameters<AgentCallback>[0]) {
  const input = task.input as { value: number };
  const result = binding.world?.invoke(
    { packageId: "record-store", operationId: "records.set" },
    { value: input.value },
    { idempotencyKey: `set-primary-${input.value}` },
  );
  return { status: result?.outcome.status ?? "missing" };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-sdk-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe("repository-level TypeScript API", () => {
  it("runs, reports, and verifies a drill without exposing engine plumbing", async () => {
    const root = repository();
    const result = await runDrills({
      root,
      drill: "set-record",
      agent: ({ task, binding }) => {
        const input = task.input as { value: number };
        const outcome = binding.world?.invoke(
          { packageId: "record-store", operationId: "records.set" },
          { value: input.value },
          { idempotencyKey: "set-primary" },
        );
        return { status: outcome?.outcome.status ?? "missing" };
      },
    });

    expect(result).toMatchObject({
      verdict: "passed",
      drills: [
        {
          drillId: "set-record",
          verdict: "passed",
          trials: [
            {
              result: {
                status: "sealed",
                verdict: "passed",
                assertionResults: [{ assertionId: "record-set", status: "passed", actual: 7 }],
              },
            },
          ],
        },
      ],
    });
    const trial = result.drills[0]?.trials[0];
    expect(trial).toBeDefined();
    expect(existsSync(trial?.worldFilePath ?? "")).toBe(true);
    expect(existsSync(trial?.report.files.html ?? "")).toBe(true);
    expect(existsSync(trial?.report.files.json ?? "")).toBe(true);
    const verified = verifyReport({ report: trial?.report.directory ?? "" });
    expect(verified).toMatchObject({
      manifest: { runId: trial?.result.identity.runId, complete: true },
      result: { status: "sealed", verdict: "passed" },
    });

    writeFileSync(trial?.report.files.html ?? "", "tampered\n");
    expect(() => verifyReport({ report: trial?.report.directory ?? "" })).toThrowError(
      expect.objectContaining({
        code: "framework.REPORT_INVALID",
        details: { reporterCode: "reporter.ARTIFACT_MISMATCH" },
      }),
    );
  });

  it("returns a failed drill as data so the customer's test runner stays in control", async () => {
    const result = await runDrills({
      root: repository(),
      drill: "set-record",
      agent: () => ({ completedWithoutAction: true }),
    });
    expect(result).toMatchObject({
      verdict: "failed",
      drills: [{ trials: [{ result: { status: "sealed", verdict: "failed" } }] }],
    });
  });

  it("throws one typed setup error with compiler diagnostics", async () => {
    const root = repository();
    writeFileSync(join(root, "world", "world.json"), "{\n");

    await expect(runDrills({ root })).rejects.toMatchObject({
      name: "FiredrillProjectError",
      code: "framework.SOURCE_INVALID",
      diagnostics: [expect.objectContaining({ code: "FD1101" })],
    } satisfies Partial<FiredrillProjectError>);
  });

  it("selects repository suites, tags, filters, and deterministic shards", async () => {
    const root = repository();
    addSecondDrillAndSuite(root);

    const suite = await runDrills({ root, suite: "pr", agent: setValueAgent });
    expect(suite.selection).toMatchObject({ suite: "pr", drillIds: ["audit-record", "set-record"] });
    expect(suite.drills.map((drill) => drill.drillId)).toEqual(["audit-record", "set-record"]);

    const tagged = await runDrills({ root, tags: ["smoke"], agent: setValueAgent });
    expect(tagged.selection.drillIds).toEqual(["set-record"]);

    const filtered = await runDrills({ root, filter: "audit", agent: setValueAgent });
    expect(filtered.selection.drillIds).toEqual(["audit-record"]);

    const firstShard = await runDrills({
      root,
      tags: ["regression"],
      shard: { index: 0, total: 2 },
      agent: setValueAgent,
    });
    const secondShard = await runDrills({
      root,
      tags: ["regression"],
      shard: { index: 1, total: 2 },
      agent: setValueAgent,
    });
    expect(firstShard.selection.drillIds).toEqual(["audit-record"]);
    expect(secondShard.selection.drillIds).toEqual(["set-record"]);
  });

  it("retains retry attempts and reports a flaky fail-then-pass trial as inconclusive", async () => {
    let attempt = 0;
    const result = await runDrills({
      root: repository(),
      drill: "set-record",
      retries: 1,
      agent: (invocation) => {
        attempt += 1;
        return attempt === 1 ? { skipped: true } : setValueAgent(invocation);
      },
    });

    const trial = result.drills[0]?.trials[0];
    expect(result.verdict).toBe("inconclusive");
    expect(trial?.verdict).toBe("inconclusive");
    expect(trial?.attempts).toHaveLength(2);
    expect(trial?.attempts.map((item) => item.result.identity.attempt)).toEqual([1, 2]);
    expect(trial?.attempts.map((item) => item.result.identity.seed)).toEqual(["29", "29"]);
    expect(new Set(trial?.attempts.map((item) => item.result.identity.runId))).toHaveProperty("size", 2);
    expect(trial?.attempts.every((item) => existsSync(item.report.files.html))).toBe(true);
  });

  it("bounds concurrent trials and runs lifecycle hooks around logical trials", async () => {
    let active = 0;
    let maximumActive = 0;
    const hooks: string[] = [];
    const result = await runDrills({
      root: repository(),
      drill: "set-record",
      trials: 3,
      concurrency: 2,
      hooks: {
        beforeAll: () => {
          hooks.push("before-all");
        },
        beforeDrill: ({ drillId }) => {
          hooks.push(`before-drill:${drillId}`);
        },
        beforeTrial: ({ trial }) => {
          hooks.push(`before-trial:${trial}`);
        },
        afterTrial: ({ trial }) => {
          hooks.push(`after-trial:${trial}`);
        },
        afterDrill: ({ drillId }) => {
          hooks.push(`after-drill:${drillId}`);
        },
        afterAll: () => {
          hooks.push("after-all");
        },
      },
      agent: async (invocation) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
        const outcome = setValueAgent(invocation);
        active -= 1;
        return outcome;
      },
    });

    expect(result.verdict).toBe("passed");
    expect(maximumActive).toBe(2);
    expect(hooks[0]).toBe("before-all");
    expect(hooks[1]).toBe("before-drill:set-record");
    expect(hooks).toEqual(expect.arrayContaining(["before-trial:1", "after-trial:3"]));
    expect(hooks.at(-2)).toBe("after-drill:set-record");
    expect(hooks.at(-1)).toBe("after-all");
  });

  it("labels quality trials as estimates and reports a bounded confidence interval", async () => {
    const root = repository();
    const path = join(root, "world", "set-record.drill.json");
    const drill = JSON.parse(readFileSync(path, "utf8")) as {
      trials?: { count: number; classification: string };
    };
    drill.trials = { count: 4, classification: "quality" };
    writeFileSync(path, `${JSON.stringify(drill)}\n`);

    const result = await runDrills({ root, drill: "set-record", agent: setValueAgent });
    const statistics = result.drills[0]?.statistics;
    expect(statistics).toMatchObject({
      classification: "quality",
      interpretation: "sampled_estimate",
      requested: 4,
      observed: 4,
      excluded: 0,
      passed: 4,
      failed: 0,
      passRate: 1,
    });
    expect(statistics?.interval95?.lower).toBeGreaterThan(0);
    expect(statistics?.interval95?.upper).toBe(1);
  });

  it("inspects a Tool without executing it, then explicitly validates executable behavior", async () => {
    const root = repository();
    const marker = `__firedrill_tool_loaded_${Date.now()}`;
    const globals = globalThis as Record<string, unknown>;
    delete globals[marker];
    writeFileSync(
      join(root, "world", "records.js"),
      [
        `globalThis[${JSON.stringify(marker)}] = "loaded";`,
        'export default { operations: { "records.set": (input, context) => { const value = { value: Number(input.value) }; context.state.put("records", "primary", value); return value; } } };',
      ].join("\n"),
    );

    const inspection = await inspectTool({ root, toolId: "record-store" });
    expect(inspection).toMatchObject({
      toolId: "record-store",
      sourcePath: "world/records.tool.json",
      manifest: { operations: [{ id: "records.set" }] },
      artifact: { moduleFormat: "esm", exportName: "default" },
    });
    expect(globals[marker]).toBeUndefined();

    const validation = await validateTool({ root, toolId: "record-store" });
    expect(validation.executable).toBe(true);
    expect(existsSync(validation.buildDirectory)).toBe(true);
    expect(globals[marker]).toBe("loaded");
    delete globals[marker];
  });

  it("runs an ordinary suite twice as a deterministic Tool conformance test", async () => {
    const root = repository();
    addSecondDrillAndSuite(root);
    addConformanceSuite(root);

    const result = await testTool({ root, toolId: "record-store", agent: setValueAgent });

    expect(
      result.status,
      JSON.stringify({
        violations: result.violations,
        results: result.runs.map((run) =>
          run.drills.map((drill) =>
            drill.trials.map((trial) => ({
              seed: trial.seed,
              status: trial.result.status,
              ...(trial.result.status === "sealed"
                ? { stateHash: trial.result.stateHash, trajectoryHash: trial.result.trajectoryHash }
                : {}),
            })),
          ),
        ),
      }),
    ).toBe("passed");
    expect(result.suiteId).toBe("record-store-conformance");
    expect(result.runs.flatMap((run) => run.selection.drillIds)).toEqual(["set-record", "set-record"]);
    expect(result.deterministic).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.coverage.operations).toEqual([
      expect.objectContaining({
        operationId: "records.set",
        attempts: 1,
        statuses: expect.objectContaining({ ok: 1 }),
      }),
    ]);
    expect(result.runs.map((run) => run.verdict)).toEqual(["passed", "passed"]);
    for (const run of result.runs) {
      expect(existsSync(run.drills[0]?.trials[0]?.report.files.html ?? "")).toBe(true);
    }
  });

  it("fails conformance when a declared operation has no behavioral coverage", async () => {
    const root = repository();
    addConformanceSuite(root);
    const sourcePath = join(root, "world", "records.tool.json");
    const source = JSON.parse(readFileSync(sourcePath, "utf8")) as {
      manifest: { operations: unknown[] };
    };
    source.manifest.operations.push({
      id: "records.read",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
        additionalProperties: false,
      },
      idempotency: "none",
      fidelity: "stateful",
    });
    writeFileSync(sourcePath, `${JSON.stringify(source)}\n`);
    writeFileSync(
      join(root, "world", "records.js"),
      'export default { operations: { "records.read": (_input, context) => context.state.get("records", "primary") ?? { value: 0 }, "records.set": (input, context) => { const value = { value: Number(input.value) }; context.state.put("records", "primary", value); return value; } } };\n',
    );

    const result = await testTool({ root, toolId: "record-store", agent: setValueAgent });

    expect(result.status).toBe("failed");
    expect(result.runs.map((run) => run.verdict)).toEqual(["passed", "passed"]);
    expect(result.violations).toContainEqual({
      code: "OPERATION_UNCOVERED",
      subject: "records.read",
      message: "operation records.read was never called",
    });
  });

  it("detects reproducibility failures even when both ordinary drill passes succeed", async () => {
    const root = repository();
    addConformanceSuite(root);
    writeFileSync(
      join(root, "world", "records.js"),
      'let calls = 0; export default { operations: { "records.set": (input, context) => { calls += 1; context.state.put("records", "primary", { value: Number(input.value) }); return { value: Number(input.value) + calls - 1 }; } } };\n',
    );

    const result = await testTool({ root, toolId: "record-store", agent: setValueAgent });

    expect(result.runs.map((run) => run.verdict)).toEqual(["passed", "passed"]);
    expect(result.status).toBe("failed");
    expect(result.deterministic).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "NONDETERMINISTIC_RESULT",
        drillId: "set-record",
        trial: 1,
        difference: "trajectory",
        message: expect.stringContaining("world state reproduced, but the trajectory differed"),
      }),
    );
  });

  it("requires an explicit or conventional conformance suite", async () => {
    const root = repository();
    await expect(testTool({ root, toolId: "record-store", agent: setValueAgent })).rejects.toMatchObject({
      code: "framework.TOOL_CONFORMANCE_SUITE_REQUIRED",
      details: { expected: "record-store-conformance" },
    } satisfies Partial<FiredrillProjectError>);
  });

  it("prepares a non-overwriting, source-closed community review bundle after conformance", async () => {
    const root = repository();
    addConformanceSuite(root);
    writeFileSync(
      join(root, "world", "record-helper.js"),
      'export function writeRecord(input, context) { const value = { value: Number(input.value) }; context.state.put("records", "primary", value); return value; }\n',
    );
    writeFileSync(
      join(root, "world", "records.js"),
      'import { writeRecord } from "./record-helper.js"; export default { operations: { "records.set": writeRecord } };\n',
    );

    const result = await prepareToolContribution({
      root,
      toolId: "record-store",
      agent: setValueAgent,
      acceptApache2: true,
    });

    expect(result.conformance).toEqual({
      suiteId: "record-store-conformance",
      deterministic: true,
      drillIds: ["set-record"],
    });
    expect(result.sourceFiles.map((file) => file.path)).toEqual([
      "world/records.tool.json",
      "world/record-helper.js",
      "world/records.js",
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        "CONTRIBUTION.json",
        "LICENSE",
        "README.md",
        "SHA256SUMS",
        "conformance.json",
        "manifest.json",
        "source/world/record-helper.js",
        "source/world/records.js",
        "source/world/records.tool.json",
      ]),
    );
    const contribution = readFileSync(join(result.directory, "CONTRIBUTION.json"), "utf8");
    expect(contribution).not.toContain(root);
    expect(JSON.parse(contribution)).toMatchObject({
      license: "Apache-2.0",
      attestations: { rightToContribute: true, reviewedForSecretsAndCustomerData: true },
      tool: { id: "record-store", version: "1.0.0" },
    });
    expect(readFileSync(join(result.directory, "LICENSE"), "utf8")).toContain("Apache License");

    await expect(
      prepareToolContribution({
        root,
        toolId: "record-store",
        agent: setValueAgent,
        acceptApache2: true,
      }),
    ).rejects.toMatchObject({ code: "framework.TOOL_CONTRIBUTION_EXISTS" });
  });

  it("requires explicit rights attestation and blocks credential-like source", async () => {
    const root = repository();
    addConformanceSuite(root);
    await expect(
      prepareToolContribution({
        root,
        toolId: "record-store",
        agent: setValueAgent,
        acceptApache2: false,
      }),
    ).rejects.toMatchObject({ code: "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED" });

    writeFileSync(
      join(root, "world", "records.js"),
      `// ${"sk"}-this_is_a_credential_like_value_123456789\nexport default { operations: { "records.set": (input, context) => { const value = { value: Number(input.value) }; context.state.put("records", "primary", value); return value; } } };\n`,
    );
    await expect(
      prepareToolContribution({
        root,
        toolId: "record-store",
        agent: setValueAgent,
        acceptApache2: true,
      }),
    ).rejects.toMatchObject({
      code: "framework.TOOL_CONTRIBUTION_UNSAFE",
      details: { issues: [{ path: "world/records.js", issues: ["API key"] }] },
    });
    expect(existsSync(join(root, ".firedrill", "contributions", "record-store"))).toBe(false);
  });
});
