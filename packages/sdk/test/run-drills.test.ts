import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const callbackServers: Server[] = [];

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

function addApplicationCallback(root: string): void {
  const toolPath = join(root, "world", "records.tool.json");
  const declaration = JSON.parse(readFileSync(toolPath, "utf8")) as {
    manifest: Record<string, unknown> & { capabilities: string[] };
  };
  declaration.manifest.capabilities.push("event.emit");
  declaration.manifest.events = [
    {
      id: "record.set",
      payloadSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
        additionalProperties: false,
      },
    },
  ];
  declaration.manifest.callbacks = [
    {
      id: "notify-application",
      eventId: "record.set",
      receiverId: "application",
      method: "POST",
      path: "/callbacks/records",
      idempotencyHeader: "Idempotency-Key",
    },
  ];
  writeFileSync(toolPath, `${JSON.stringify(declaration)}\n`);
  writeFileSync(
    join(root, "world", "records.js"),
    [
      "export default {",
      '  operations: { "records.set": (input, context) => {',
      "    const value = { value: Number(input.value) };",
      '    context.state.put("records", "primary", value);',
      '    context.events.emit("record.set", value);',
      "    return value;",
      "  } },",
      "  callbacks: {",
      '    "notify-application": { encode: ({ deliveryId, payload }) => ({',
      '      body: { kind: "json", value: { deliveryId, ...payload } },',
      "    }) },",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const drillPath = join(root, "world", "set-record.drill.json");
  const drill = JSON.parse(readFileSync(drillPath, "utf8")) as { assertions: unknown[] };
  drill.assertions.push({
    id: "application-notified",
    kind: "callback.count",
    callback: { packageId: "record-store", callbackId: "notify-application" },
    phase: "delivered",
    comparison: { operator: "equals", value: 1 },
  });
  writeFileSync(drillPath, `${JSON.stringify(drill)}\n`);
}

async function startCallbackReceiver(received: unknown[]): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(204);
      response.end();
    });
  });
  callbackServers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("callback receiver did not bind");
  return `http://127.0.0.1:${String(address.port)}`;
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

async function setValueOverHttp(
  environment: Readonly<Record<string, string>>,
  value: number,
  idempotencyKey: string,
) {
  const baseUrl = environment.SERVICE_URL;
  const token = environment.SERVICE_TOKEN;
  if (baseUrl === undefined || token === undefined) throw new Error("projected service binding is missing");
  const response = await fetch(`${baseUrl}/v1/operations/record-store/records.set`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ arguments: { value }, idempotencyKey }),
  });
  const body = (await response.json()) as { outcome?: { status?: string; value?: unknown } };
  if (!response.ok) throw new Error(`synthetic service returned HTTP ${response.status}`);
  return body;
}

afterEach(async () => {
  await Promise.all(
    callbackServers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeAllConnections();
        }),
    ),
  );
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

  it("copies caller-owned file evidence into a verified report without leaking its source path", async () => {
    const root = repository();
    mkdirSync(join(root, "test-results"));
    const source = join(root, "test-results", "agent-screen.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(source, bytes);

    const result = await runDrills({
      root,
      drill: "set-record",
      agent: (invocation) => {
        invocation.attach({
          path: "test-results/agent-screen.png",
          mediaType: "image/png",
          redaction: {
            status: "applied_by_caller",
            note: "Test fixture contains no customer data.",
          },
        });
        writeFileSync(source, "changed after registration");
        return setValueAgent(invocation);
      },
    });

    const trial = result.drills[0]?.trials[0];
    const attachment = trial?.result.interactions[0]?.targetResult.attachments[0];
    expect(result.verdict).toBe("passed");
    expect(attachment).toMatchObject({
      schemaVersion: 1,
      kind: "file",
      name: "agent-screen.png",
      mediaType: "image/png",
      bytes: bytes.byteLength,
      redaction: { status: "applied_by_caller" },
    });
    expect(JSON.stringify(attachment)).not.toContain(source);
    expect(trial?.report.attachments).toHaveLength(1);
    expect(readFileSync(trial?.report.attachments[0]?.path ?? "")).toEqual(bytes);
    expect(trial?.report.manifest.artifacts).toContainEqual(
      expect.objectContaining({ role: "attachment", mediaType: "image/png", bytes: bytes.byteLength }),
    );
    const verified = verifyReport({ report: trial?.report.directory ?? "" });
    expect(verified.attachments).toHaveLength(1);
    expect(verified.attachments[0]?.attachment).toMatchObject({ name: "agent-screen.png" });
    const html = readFileSync(trial?.report.files.html ?? "", "utf8");
    expect(html).toContain(`href="attachments/${attachment?.id}/agent-screen.png"`);
    expect(html).toContain('download="agent-screen.png">agent-screen.png</a>');
  });

  it("fails closed when an agent tries to attach an outside or symlinked file", async () => {
    const root = repository();
    const otherRoot = repository();
    const outside = join(otherRoot, "outside.png");
    writeFileSync(outside, "outside");
    const outsideResult = await runDrills({
      root,
      drill: "set-record",
      agent: ({ attach }) => {
        attach({ path: outside, mediaType: "image/png" });
      },
    });
    expect(outsideResult.drills[0]?.trials[0]?.result.interactions[0]?.targetResult).toMatchObject({
      status: "failed",
      error: { code: "target.ATTACHMENT_PATH_OUTSIDE_REPOSITORY" },
      attachments: [],
    });

    const owned = join(root, "owned.png");
    writeFileSync(owned, "owned");
    symlinkSync(owned, join(root, "linked.png"));
    const linkedResult = await runDrills({
      root,
      drill: "set-record",
      agent: ({ attach }) => {
        attach({ path: "linked.png", mediaType: "image/png" });
      },
    });
    expect(linkedResult.drills[0]?.trials[0]?.result.interactions[0]?.targetResult).toMatchObject({
      status: "failed",
      error: { code: "target.ATTACHMENT_SYMLINK_FORBIDDEN" },
      attachments: [],
    });
  });

  it("retains an attachment when the caller-owned agent fails afterward", async () => {
    const root = repository();
    const source = join(root, "failure-screen.png");
    writeFileSync(source, "failure evidence");
    const result = await runDrills({
      root,
      drill: "set-record",
      agent: ({ attach }) => {
        attach({ path: "failure-screen.png", mediaType: "image/png" });
        throw new Error("UI agent failed after rendering its error state");
      },
    });

    const trial = result.drills[0]?.trials[0];
    expect(result.verdict).toBe("failed");
    expect(trial?.result.interactions[0]?.targetResult).toMatchObject({
      status: "failed",
      error: { code: "target.EXECUTION_FAILED" },
      attachments: [{ kind: "file", name: "failure-screen.png" }],
    });
    expect(trial?.report.attachments).toHaveLength(1);
    expect(readFileSync(trial?.report.attachments[0]?.path ?? "", "utf8")).toBe("failure evidence");
    expect(verifyReport({ report: trial?.report.directory ?? "" }).attachments).toHaveLength(1);
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

  it("injects test-local data as a reproducible derived build and leaves source untouched", async () => {
    const root = repository();
    const worldPath = join(root, "world", "world.json");
    const drillPath = join(root, "world", "set-record.drill.json");
    const worldBefore = readFileSync(worldPath, "utf8");
    const drillBefore = readFileSync(drillPath, "utf8");
    const setupForValue = (value: number) => ({
      scenario: {
        state: [
          {
            action: "upsert" as const,
            packageId: "record-store",
            namespace: "records",
            rowId: "primary",
            value: { value },
          },
        ],
      },
    });

    const passing = await runDrills({
      root,
      drill: "set-record",
      setup: setupForValue(7),
      agent: () => ({ inspected: true }),
    });
    const passingTrial = passing.drills[0]?.trials[0];
    expect(passing.verdict).toBe("passed");
    expect(passing.setup).toMatchObject({
      drillId: "set-record",
      setup: { scenario: { state: [expect.objectContaining({ value: { value: 7 } })] } },
    });
    expect(passingTrial?.result.identity.setupHash).toBe(passing.setup?.setupHash);
    expect(readFileSync(passingTrial?.report.files.json ?? "", "utf8")).toContain(
      passing.setup?.setupHash ?? "missing-setup-hash",
    );
    const html = readFileSync(passingTrial?.report.files.html ?? "", "utf8");
    expect(html).toContain("Test-local setup");
    expect(html).toContain("record-store");

    const failing = await runDrills({
      root,
      drill: "set-record",
      setup: setupForValue(4),
      agent: () => ({ inspected: true }),
    });
    expect(failing.verdict).toBe("failed");
    expect(failing.setup?.setupHash).not.toBe(passing.setup?.setupHash);
    expect(failing.buildHash).not.toBe(passing.buildHash);
    expect(failing.drills[0]?.trials[0]?.result.assertionResults).toContainEqual(
      expect.objectContaining({
        assertionId: "record-set",
        status: "failed",
        actual: 4,
        expected: { operator: "equals", value: 7 },
      }),
    );

    const reproduced = await runDrills({
      root,
      drill: "set-record",
      buildHash: passing.buildHash,
      agent: () => ({ inspected: true }),
    });
    expect(reproduced.verdict).toBe("passed");
    expect(reproduced.buildHash).toBe(passing.buildHash);
    expect(reproduced.setup).toEqual(passing.setup);
    expect(readFileSync(worldPath, "utf8")).toBe(worldBefore);
    expect(readFileSync(drillPath, "utf8")).toBe(drillBefore);
    expect(passingTrial?.report.directory).toContain(join(root, ".firedrill", "reports"));
  });

  it("injects a traceable Tool behavior replacement and an authored fault without hidden mutations", async () => {
    const overriddenRoot = repository();
    const drillPath = join(overriddenRoot, "world", "set-record.drill.json");
    const drill = JSON.parse(readFileSync(drillPath, "utf8")) as {
      assertions: Array<{ comparison?: { value?: number } }>;
    };
    const stateAssertion = drill.assertions.find((assertion) => assertion.comparison?.value === 7);
    if (stateAssertion?.comparison === undefined) throw new Error("fixture has no state assertion");
    stateAssertion.comparison.value = 8;
    writeFileSync(drillPath, `${JSON.stringify(drill)}\n`);
    mkdirSync(join(overriddenRoot, "test-support"));
    const overridePath = join(overriddenRoot, "test-support", "records.override.js");
    writeFileSync(
      overridePath,
      'export default { operations: { "records.set": (input, context) => { const value = { value: Number(input.value) + 1 }; context.state.put("records", "primary", value); return value; } } };\n',
    );
    const sourceBefore = readFileSync(join(overriddenRoot, "world", "records.js"), "utf8");
    const overrideBefore = readFileSync(overridePath, "utf8");
    const overridden = await runDrills({
      root: overriddenRoot,
      drill: "set-record",
      setup: {
        tools: {
          behaviorOverrides: [{ packageId: "record-store", module: "test-support/records.override.js" }],
        },
      },
      agent: setValueAgent,
    });
    expect(overridden.verdict).toBe("passed");
    expect(overridden.drills[0]?.trials[0]?.result.assertionResults).toContainEqual(
      expect.objectContaining({ assertionId: "record-set", status: "passed", actual: 8 }),
    );
    const lock = JSON.parse(
      readFileSync(
        join(
          overriddenRoot,
          ".firedrill",
          "builds",
          overridden.buildHash.slice("sha256:".length),
          "packages.lock.json",
        ),
        "utf8",
      ),
    ) as { packages: Array<{ source: unknown }> };
    expect(lock.packages[0]?.source).toEqual({
      kind: "repository_override",
      module: "test-support/records.override.js",
      base: { kind: "repository" },
    });
    expect(readFileSync(join(overriddenRoot, "world", "records.js"), "utf8")).toBe(sourceBefore);
    expect(readFileSync(overridePath, "utf8")).toBe(overrideBefore);

    const faultRoot = repository();
    const toolPath = join(faultRoot, "world", "records.tool.json");
    const declaration = JSON.parse(readFileSync(toolPath, "utf8")) as {
      manifest: {
        operations: Array<{ declaredErrors?: string[] }>;
        faults?: unknown[];
      };
    };
    const operation = declaration.manifest.operations[0];
    if (operation === undefined) throw new Error("fixture has no operation");
    operation.declaredErrors = ["WRITE_BLOCKED"];
    declaration.manifest.faults = [
      {
        id: "write-blocked",
        appliesTo: ["records.set"],
        timing: "before",
        error: { code: "WRITE_BLOCKED", message: "writes are unavailable", retryable: true },
      },
    ];
    writeFileSync(toolPath, `${JSON.stringify(declaration)}\n`);
    const faultDrillPath = join(faultRoot, "world", "set-record.drill.json");
    const faultDrill = JSON.parse(readFileSync(faultDrillPath, "utf8")) as { assertions: unknown[] };
    faultDrill.assertions = [
      {
        id: "write-rejected",
        kind: "operation.denied",
        operation: { packageId: "record-store", operationId: "records.set" },
        outcomes: ["tool_error"],
        errorCode: "tool.WRITE_BLOCKED",
      },
      {
        id: "record-unchanged",
        kind: "state.value",
        packageId: "record-store",
        namespace: "records",
        rowId: "primary",
        path: ["value"],
        comparison: { operator: "equals", value: 0 },
      },
    ];
    writeFileSync(faultDrillPath, `${JSON.stringify(faultDrill)}\n`);
    const faulted = await runDrills({
      root: faultRoot,
      drill: "set-record",
      setup: {
        scenario: { faults: [{ packageId: "record-store", faultId: "write-blocked" }] },
      },
      agent: setValueAgent,
    });
    expect(faulted.verdict).toBe("passed");
    expect(faulted.drills[0]?.trials[0]?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "fault",
        packageId: "record-store",
        faultId: "write-blocked",
        timing: "before",
      }),
    );
    expect(faulted.drills[0]?.trials[0]?.result.assertionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: "write-rejected", status: "passed" }),
        expect.objectContaining({ assertionId: "record-unchanged", status: "passed", actual: 0 }),
      ]),
    );
  });

  it("projects an invocation-scoped synthetic service into an unchanged agent configuration", async () => {
    const root = repository();
    writeFileSync(
      join(root, "world", "agent.target.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        target: { id: "agent-under-test", kind: "external", bindings: ["http"], timeoutMs: 5_000 },
      })}\n`,
    );
    let called = 0;
    let issuedUrl = "";
    let issuedToken = "";
    const result = await runDrills({
      root,
      drill: "set-record",
      setup: {
        bindings: {
          environment: {
            SERVICE_URL: "FIREDRILL_HTTP_URL",
            SERVICE_TOKEN: "FIREDRILL_HTTP_TOKEN",
          },
        },
      },
      agent: async ({ task, binding }) => {
        called += 1;
        expect(binding.world).toBeUndefined();
        expect(binding.environment.SERVICE_URL).toBe(binding.environment.FIREDRILL_HTTP_URL);
        expect(binding.environment.SERVICE_TOKEN).toBe(binding.environment.FIREDRILL_HTTP_TOKEN);
        issuedUrl = binding.environment.SERVICE_URL ?? "";
        issuedToken = binding.environment.SERVICE_TOKEN ?? "";
        const input = task.input as { value: number };
        return setValueOverHttp(binding.environment, input.value, "unchanged-agent-set");
      },
    });
    expect(called).toBe(1);
    expect(result.verdict).toBe("passed");
    expect(result.drills[0]?.trials[0]?.result.bindingEvidence).toBe("observed");
    expect(issuedUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(issuedToken.length).toBeGreaterThan(15);
    await expect(fetch(`${issuedUrl}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();

    let unsafeAgentCalled = false;
    await expect(
      runDrills({
        root,
        drill: "set-record",
        setup: { bindings: { environment: { SERVICE_URL: "FIREDRILL_MCP_URL" } } },
        agent: () => {
          unsafeAgentCalled = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({
      code: "framework.SOURCE_INVALID",
      diagnostics: [
        expect.objectContaining({
          code: "FD1202",
          message: expect.stringContaining(
            "FIREDRILL_MCP_URL is unavailable because target agent-under-test does not declare",
          ),
          path: expect.arrayContaining(["setup", "bindings", "environment"]),
        }),
      ],
    });
    expect(unsafeAgentCalled).toBe(false);
  });

  it("injects projected bindings into an existing command target without a runner callback", async () => {
    const root = repository();
    writeFileSync(
      join(root, "world", "agent.target.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        target: {
          id: "agent-under-test",
          kind: "command",
          bindings: ["http"],
          executable: process.execPath,
          arguments: ["agent-command.mjs"],
          workingDirectory: ".",
          timeoutMs: 5_000,
        },
      })}\n`,
    );
    writeFileSync(
      join(root, "agent-command.mjs"),
      [
        'let source = "";',
        "for await (const chunk of process.stdin) source += chunk;",
        "const invocation = JSON.parse(source);",
        "const baseUrl = process.env.RECORDS_SERVICE_URL;",
        "const token = process.env.RECORDS_SERVICE_TOKEN;",
        'if (!baseUrl || !token) throw new Error("the agent\'s normal service configuration is missing");',
        'const response = await fetch(baseUrl + "/v1/operations/record-store/records.set", {',
        '  method: "POST",',
        '  headers: { authorization: "Bearer " + token, "content-type": "application/json" },',
        '  body: JSON.stringify({ arguments: { value: Number(invocation.input.value) }, idempotencyKey: "command-set" }),',
        "});",
        "const result = await response.json();",
        'if (!response.ok || result.outcome?.status !== "ok") throw new Error("synthetic service call failed");',
        "process.stdout.write(JSON.stringify({ value: result.outcome.value.value }));",
        "",
      ].join("\n"),
    );

    const result = await runDrills({
      root,
      drill: "set-record",
      setup: {
        bindings: {
          environment: {
            RECORDS_SERVICE_URL: "FIREDRILL_HTTP_URL",
            RECORDS_SERVICE_TOKEN: "FIREDRILL_HTTP_TOKEN",
          },
        },
      },
      hostEnvironment: {
        PATH: process.env.PATH,
        RECORDS_SERVICE_URL: "https://production.invalid",
        RECORDS_SERVICE_TOKEN: "must-not-be-forwarded",
      },
    });

    expect(result.verdict).toBe("passed");
    expect(result.drills[0]?.trials[0]?.result).toMatchObject({
      bindingEvidence: "observed",
      interactions: [
        {
          targetResult: { status: "completed", output: { value: 7 } },
        },
      ],
    });
  });

  it("delivers repository-defined callbacks through the primary runDrills API", async () => {
    const root = repository();
    addApplicationCallback(root);
    const received: unknown[] = [];
    const baseUrl = await startCallbackReceiver(received);
    const result = await runDrills({
      root,
      drill: "set-record",
      agent: setValueAgent,
      callbackReceivers: { application: { baseUrl } },
    });

    expect(result.verdict).toBe("passed");
    expect(received).toEqual([expect.objectContaining({ value: 7 })]);
    const trial = result.drills[0]?.trials[0];
    expect(trial?.result.assertionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: "application-notified", status: "passed", actual: 1 }),
      ]),
    );
    expect(trial?.evidence.filter((entry) => entry.kind === "callback").map((entry) => entry.phase)).toEqual([
      "queued",
      "attempt_started",
      "delivered",
    ]);
    expect(readFileSync(trial?.report.files.html ?? "", "utf8")).toContain("notify-application");
  });

  it("rejects unsafe and unknown callback receiver configuration as a setup error", async () => {
    await expect(
      runDrills({
        root: repository(),
        callbackReceivers: { application: { baseUrl: "https://example.com" } },
      }),
    ).rejects.toMatchObject({
      code: "framework.INVALID_ARGUMENT",
      message: "callback receiver application must be a credential-free loopback HTTP origin",
    });

    await expect(
      runDrills({
        root: repository(),
        callbackReceivers: { typo: { baseUrl: "http://127.0.0.1:4319" } },
      }),
    ).rejects.toMatchObject({
      code: "framework.INVALID_ARGUMENT",
      message: "callback receiver typo is not declared by a selected Tool",
      details: { available: [] },
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
    const firstIds = firstShard.selection.drillIds;
    const secondIds = secondShard.selection.drillIds;
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect([...firstIds, ...secondIds].sort()).toEqual(["audit-record", "set-record"]);
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

  it("keeps a central report index across separate invocations and after an afterAll hook fails", async () => {
    const root = repository();
    const first = await runDrills({ root, drill: "set-record", agent: setValueAgent });
    expect(first.reportIndex).toBe(join(root, ".firedrill", "reports", "index.html"));
    const original = new Error("caller afterAll failed");
    let secondRunId = "";
    await expect(
      runDrills({
        root,
        drill: "set-record",
        agent: setValueAgent,
        hooks: {
          afterAll: ({ result }) => {
            secondRunId = result.drills[0]?.trials[0]?.result.identity.runId ?? "";
            expect(readFileSync(result.reportIndex ?? "", "utf8")).toContain(secondRunId);
            throw original;
          },
        },
      }),
    ).rejects.toBe(original);
    const html = readFileSync(first.reportIndex ?? "", "utf8");
    expect(html).toContain(first.drills[0]?.trials[0]?.result.identity.runId);
    expect(secondRunId).not.toBe("");
    expect(html).toContain(secondRunId);
  });

  it("reports index failures without overwriting an original hook failure", async () => {
    const root = repository();
    const original = new Error("caller hook failed");
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await expect(
        runDrills({
          root,
          drill: "set-record",
          agent: setValueAgent,
          hooks: {
            afterDrill: () => {
              mkdirSync(join(root, ".firedrill", "reports", "index.html"));
              throw original;
            },
          },
        }),
      ).rejects.toBe(original);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not refresh the report index"), {
        code: "FIREDRILL_REPORT_INDEX_FAILED",
      });
    } finally {
      warn.mockRestore();
    }
    await expect(runDrills({ root, drill: "set-record", agent: setValueAgent })).rejects.toMatchObject({
      code: "framework.INTERNAL_ERROR",
      message: expect.stringContaining("reports were saved"),
    });
  });

  it("bounds concurrent trials and runs lifecycle hooks around logical trials", async () => {
    let active = 0;
    let maximumActive = 0;
    const hooks: string[] = [];
    const startedAttempts = new Map<string, string>();
    const finishedAttempts = new Set<string>();
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
        attemptStarted: ({ runId, worldFilePath, trial }) => {
          expect(existsSync(worldFilePath)).toBe(true);
          startedAttempts.set(runId, `${trial}:${worldFilePath}`);
        },
        attemptFinished: ({ runId, worldFilePath, execution }) => {
          expect(execution.result.identity.runId).toBe(runId);
          expect(execution.worldFilePath).toBe(worldFilePath);
          finishedAttempts.add(runId);
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
    expect(startedAttempts.size).toBe(3);
    expect(finishedAttempts).toEqual(new Set(startedAttempts.keys()));
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

  it("requires declared callbacks to be delivered by Tool conformance drills", async () => {
    const root = repository();
    addApplicationCallback(root);
    addConformanceSuite(root);
    const received: unknown[] = [];
    const baseUrl = await startCallbackReceiver(received);

    const result = await testTool({
      root,
      toolId: "record-store",
      agent: setValueAgent,
      callbackReceivers: { application: { baseUrl } },
    });

    expect(result.status).toBe("passed");
    expect(result.coverage.callbacks).toEqual([
      {
        callbackId: "notify-application",
        queued: 1,
        delivered: 1,
        retryScheduled: 0,
        failed: 0,
      },
    ]);
    expect(received).toHaveLength(2);

    const uncovered = await testTool({ root, toolId: "record-store", agent: setValueAgent });
    expect(uncovered.status).toBe("failed");
    expect(uncovered.violations).toContainEqual({
      code: "CALLBACK_UNCOVERED",
      subject: "notify-application",
      message: "callback notify-application was never delivered successfully",
    });
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
