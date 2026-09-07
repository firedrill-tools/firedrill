import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceEntry, RunResult, ToolPackageManifest } from "@firedrill/contracts";
import { AssertionResultSchema, canonicalJson, JsonValueSchema, RunResultSchema } from "@firedrill/contracts";
import { trajectoryHash } from "@firedrill/world-ir";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareLocalReports,
  renderHtmlReport,
  renderJsonReport,
  renderJunitReport,
  renderTerminalReport,
  verifyLocalReport,
  writeLocalReport,
} from "../src/index.js";

const directories: string[] = [];
const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-report-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function semanticHash(value: unknown): string {
  const json = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
  return `sha256:${createHash("sha256").update(canonicalJson(json)).digest("hex")}`;
}

function evidence(): readonly EvidenceEntry[] {
  return [
    {
      schemaVersion: 1,
      sequence: 1,
      transactionId: "txn_report001",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 500,
      correlationId: "corr_report001",
      kind: "lifecycle",
      action: "world_created",
      worldInstanceId: "world_report001",
      details: {
        source: "<script>alert('unsafe')</script>",
        apiToken: "built-in-secret-1234",
        sessionMaterial: "declared-secret-5678",
        note: "configured with declared-secret-5678",
      },
    },
    {
      schemaVersion: 1,
      sequence: 2,
      transactionId: "txn_report002",
      transactionIndex: 0,
      transactionSize: 1,
      virtualTimeUs: 500,
      correlationId: "corr_report002",
      kind: "state_change",
      packageId: "generic-tool",
      namespace: "records",
      rowId: "item-1",
      change: "update",
      before: { status: "queued" },
      after: { status: "complete", sessionMaterial: "declared-secret-5678" },
      deltaHash: HASH,
    },
  ];
}

function run(entries: readonly EvidenceEntry[]): RunResult {
  const assertion = AssertionResultSchema.parse({
    schemaVersion: 1,
    assertionId: "no-extra-actions",
    kind: "operation.count",
    status: "passed",
    gate: true,
    message: "operation count matched",
    expected: { operator: "equals", value: 0 },
    actual: 0,
    location: {
      subject: "operation",
      operations: [{ packageId: "generic-tool", operationId: "items.update" }],
    },
    diff: { operator: "equals", matched: true, details: {} },
    evidenceSequences: [],
  });
  const interactions = [
    {
      schemaVersion: 1 as const,
      interactionId: "inspect-record",
      actorId: "operator",
      task: { instruction: "Verify the agent changes only the intended record." },
      scheduledAtVirtualUs: 500,
      startedAtVirtualUs: 500,
      finishedAtVirtualUs: 500,
      bindingEvidence: "issued" as const,
      targetResult: {
        schemaVersion: 1 as const,
        status: "completed" as const,
        output: {
          note: "<script>alert('unsafe')</script>",
          echoedToken: "built-in-secret-1234",
          forwarded: "declared-secret-5678",
        },
        attachments: [],
      },
    },
  ];
  const checkpoints = [
    {
      schemaVersion: 1 as const,
      checkpointId: "final",
      kind: "final" as const,
      virtualTimeUs: 500,
      verdict: "passed" as const,
      assertionResults: [assertion],
    },
  ];
  return RunResultSchema.parse({
    schemaVersion: 1,
    status: "sealed",
    identity: {
      runId: "run_report001",
      worldInstanceId: "world_report001",
      drillId: "generic-agent-behavior",
      scenarioId: "initial-state",
      targetId: "agent-under-test",
      buildHash: HASH,
      packageLockHash: HASH_B,
      seed: "41",
      trial: 1,
      trialCount: 1,
    },
    startedAtVirtualUs: 500,
    finishedAtVirtualUs: 500,
    bindingEvidence: "issued",
    worldConsistency: "atomic",
    budgetUsage: {
      toolCalls: { limit: 1000, attempted: 0, rejected: 0 },
      scheduledEvents: { limit: 10000, processed: 0, exhausted: false },
    },
    verdict: "passed",
    interactions,
    checkpoints,
    assertionResults: [assertion],
    evidenceRange: { fromSequence: 1, toSequence: entries.at(-1)?.sequence ?? 1 },
    stateHash: HASH,
    evidenceHash: semanticHash(entries),
    trajectoryHash: trajectoryHash({ interactions, checkpoints, evidence: entries }),
  });
}

function tools(): readonly ToolPackageManifest[] {
  return [
    {
      schemaVersion: 1,
      id: "generic-tool",
      version: "1.0.0",
      engine: "firedrill@1",
      capabilities: [],
      state: [],
      operations: [
        {
          id: "items.update",
          inputSchema: {
            type: "object",
            properties: {
              sessionMaterial: { type: "string", "x-firedrill-sensitive": true },
            },
          },
          outputSchema: { type: "object" },
          declaredErrors: [],
          idempotency: "none",
          fidelity: "contract",
        },
      ],
      events: [],
      faults: [],
      subscriptions: [],
      http: [
        {
          id: "update-item",
          operationId: "items.update",
          method: "PATCH",
          path: "/items/{itemId}",
          auth: { kind: "bearer", schemes: ["Bearer"] },
          requestBody: "json",
          response: { successStatus: 200, errors: [] },
        },
      ],
      callbacks: [],
      compatibility: [
        {
          id: "official-client",
          mode: "translated",
          protocol: "http",
          service: "Generic records",
          apiVersion: "2026-01-01",
          client: { ecosystem: "npm", name: "@example/records", version: "2.1.0" },
          configuration: { endpoint: "baseUrl", credential: "auth" },
          routes: [{ routeId: "update-item", clientMethod: "items.update" }],
          flows: [
            {
              id: "update-one",
              description: "Update one record.",
              routeIds: ["update-item"],
            },
          ],
          limitations: ["Only update is covered."],
        },
      ],
    },
  ];
}

describe("local evidence reporters", () => {
  it("renders terminal, JSON, JUnit, and escaped self-contained HTML from one sealed input", () => {
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };
    expect(renderTerminalReport(input)).toContain("PASSED  generic-agent-behavior");
    expect(renderTerminalReport(input)).toContain(`Trajectory ${run(entries).trajectoryHash}`);
    expect(renderTerminalReport(input)).toContain("Budgets: 0/1000 Tool calls");
    expect(renderTerminalReport(input)).toContain("@example/records@2.1.0 (1 covered route)");
    expect(JSON.parse(renderJsonReport(input))).toMatchObject({
      schemaVersion: 1,
      run: { identity: { runId: "run_report001" } },
      tools: [
        {
          id: "generic-tool",
          compatibility: [{ client: { name: "@example/records", version: "2.1.0" } }],
        },
      ],
    });
    expect(renderJunitReport(input)).toContain('<testsuites tests="2" failures="0"');
    expect(renderJunitReport(input)).toContain('name="firedrill.trajectoryHash"');
    expect(renderJunitReport(input)).toContain('name="firedrill.toolCalls.limit" value="1000"');
    const html = renderHtmlReport(input);
    expect(html).toContain("Firedrill / Drill report");
    expect(html).toContain("Run details and limits");
    expect(html).toContain("Synthetic tools used by this world");
    expect(html).toContain("@example/records");
    expect(html).toContain("2.1.0");
    expect(html).toContain("Only update is covered.");
    expect(html).not.toContain('class="eyebrow"');
    expect(html).toContain("Verify the agent changes only the intended record.");
    expect(html).toContain("generic-tool / records / item-1");
    expect(html).toContain("&lt;script&gt;alert(&#39;unsafe&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('unsafe')</script>");
    expect(html).not.toContain("built-in-secret-1234");
    expect(html).not.toContain("declared-secret-5678");
    expect(html).toContain(`firedrill run generic-agent-behavior --build-hash ${HASH} --seed 41 --trials 1`);
    expect(renderJsonReport(input)).not.toContain("built-in-secret-1234");
    expect(renderJunitReport(input)).not.toContain("declared-secret-5678");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<strong>completed</strong><p");
  });

  it("puts task and checks before implementation details and labels virtual time accurately", () => {
    const entries = evidence();
    const html = renderHtmlReport({ result: run(entries), evidence: entries, tools: tools() });
    const task = html.indexOf('<section id="task">');
    const checks = html.indexOf('<section id="checks">');
    const actions = html.indexOf('<section id="actions">');
    const changes = html.indexOf('<section id="changes">');
    const details = html.indexOf('<section id="details">');
    expect(task).toBeGreaterThan(0);
    expect(checks).toBeGreaterThan(task);
    expect(actions).toBeGreaterThan(checks);
    expect(changes).toBeGreaterThan(actions);
    expect(details).toBeGreaterThan(changes);
    expect(html.indexOf("Run details and limits")).toBeGreaterThan(details);
    expect(html).toContain("not elapsed execution time");
    expect(html).toContain("Agent output (not the test verdict)");
    expect(html).toContain("No tool calls were recorded. This alone does not prove the agent was connected.");
    expect(html).toContain("Passing means the configured checks passed");
  });

  it("shows received tool arguments and responses, escapes user text, and separates initial seed changes", () => {
    const unsafe = '<img src=x onerror="alert(1)">';
    const escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;";
    const entries: readonly EvidenceEntry[] = [
      evidence()[0] as EvidenceEntry,
      {
        schemaVersion: 1,
        sequence: 2,
        causeSequence: 1,
        transactionId: "txn_report002",
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 500,
        correlationId: "corr_report002",
        kind: "state_change",
        packageId: "generic-tool",
        namespace: "records",
        rowId: "initial-record",
        change: "insert",
        before: null,
        after: { value: "initial seed marker" },
        deltaHash: HASH,
      },
      {
        schemaVersion: 1,
        sequence: 3,
        transactionId: "txn_report003",
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 500,
        correlationId: "corr_report003",
        kind: "operation",
        invocation: {
          schemaVersion: 1,
          callId: "call_report003",
          correlationId: "corr_report003",
          operation: { packageId: "generic-tool", operationId: "items.update" },
          actorBindingId: "actor_report003",
          arguments: { requestedValue: unsafe },
        },
        actorId: "operator",
        outcome: { status: "ok", value: { acceptedValue: unsafe } },
        idempotency: "not_requested",
        toolOverride: {
          id: "use-stateful-handler",
          scope: { kind: "drill", drillId: "update-record" },
          outcome: "original",
          matchIndex: 2,
        },
      },
      {
        schemaVersion: 1,
        sequence: 4,
        causeSequence: 3,
        transactionId: "txn_report004",
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 500,
        correlationId: "corr_report004",
        kind: "state_change",
        packageId: "generic-tool",
        namespace: "records",
        rowId: unsafe,
        change: "update",
        before: { value: "before agent action" },
        after: { value: "after agent action" },
        deltaHash: HASH,
      },
    ];
    const base = run(entries);
    if (base.status !== "sealed") throw new Error("fixture must be sealed");
    const assertions = base.assertionResults.map((assertion) => ({
      ...assertion,
      expected: { operator: "equals", value: 1 },
      actual: 1,
      evidenceSequences: [3],
    }));
    const checkpoints = base.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      assertionResults: assertions,
    }));
    const interactions = base.interactions.map((interaction) => ({
      ...interaction,
      task: { instruction: `Set the record to ${unsafe}` },
    }));
    const result = RunResultSchema.parse({
      ...base,
      interactions,
      checkpoints,
      assertionResults: assertions,
      trajectoryHash: trajectoryHash({ interactions, checkpoints, evidence: entries }),
    });
    const html = renderHtmlReport({ result, evidence: entries, tools: tools() });
    const actions = html.slice(
      html.indexOf('<section id="actions">'),
      html.indexOf('<section id="changes">'),
    );
    const changes = html.slice(
      html.indexOf('<section id="changes">'),
      html.indexOf('<section id="details">'),
    );
    expect(html).not.toContain(unsafe);
    expect(html).toContain(`Set the record to ${escaped}`);
    expect(actions).toContain("generic-tool.items.update");
    expect(actions).toContain("Arguments sent");
    expect(actions).toContain("requestedValue");
    expect(actions).toContain("Response received");
    expect(actions).toContain("acceptedValue");
    expect(actions).toContain("Success");
    expect(actions).toContain("Override: use-stateful-handler");
    expect(actions).toContain("drill update-record · match 2");
    expect(actions).toContain("Used the tool&#39;s normal behavior");
    expect(changes).toContain(escaped);
    expect(changes).toContain("before agent action");
    expect(changes).toContain("after agent action");
    expect(changes).not.toContain("initial seed marker");
    expect(html).toContain("initial seed marker");
    expect(html).toContain('href="#event-3"');
  });

  it("prints concise expected and actual values for a failed terminal assertion", () => {
    const entries = evidence();
    const passed = run(entries);
    if (passed.status !== "sealed") throw new Error("fixture must be sealed");
    const original = passed.assertionResults[0];
    if (original === undefined) throw new Error("fixture has no assertion");
    const failedAssertion = AssertionResultSchema.parse({
      ...original,
      status: "failed",
      message: "operation count did not match",
      actual: 1,
      diff: { ...original.diff, matched: false },
    });
    const checkpoints = passed.checkpoints.map((checkpoint) =>
      checkpoint.kind === "final"
        ? { ...checkpoint, verdict: "failed" as const, assertionResults: [failedAssertion] }
        : checkpoint,
    );
    const failed = RunResultSchema.parse({
      ...passed,
      verdict: "failed",
      checkpoints,
      assertionResults: [failedAssertion],
      trajectoryHash: trajectoryHash({
        interactions: passed.interactions,
        checkpoints,
        evidence: entries,
      }),
    });

    const terminal = renderTerminalReport({ result: failed, evidence: entries });
    expect(terminal).toContain('expected {"operator":"equals","value":0}');
    expect(terminal).toContain("actual   1");
  });

  it("emits CI-safe JUnit with durations, error counts, stderr, and valid XML characters", () => {
    const entries = evidence();
    const original = run(entries);
    if (original.status !== "sealed") throw new Error("fixture must be sealed");
    const interactions = original.interactions.map((interaction) => ({
      ...interaction,
      finishedAtVirtualUs: 1_500_500,
      targetResult: {
        ...interaction.targetResult,
        attachments: [
          {
            kind: "process.stderr",
            text: "\u001b[31mwarning\u0000 from target",
            truncated: false,
          },
        ],
      },
    }));
    const result = RunResultSchema.parse({
      ...original,
      finishedAtVirtualUs: 1_500_500,
      interactions,
      trajectoryHash: trajectoryHash({ interactions, checkpoints: original.checkpoints, evidence: entries }),
    });

    const junit = renderJunitReport({ result, evidence: entries });
    expect(junit).toContain('errors="0"');
    expect(junit).toContain('time="1.5"');
    expect(junit).toContain("<system-err>�[31mwarning� from target</system-err>");
    expect(
      [...junit].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d;
      }),
    ).toBe(false);
  });

  it("writes an atomic, hash-addressed bundle and refuses replacement", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };
    const destination = join(root, "report");
    const written = writeLocalReport(input, destination);

    expect(readdirSync(destination).sort()).toEqual([
      "evidence.jsonl",
      "index.html",
      "junit.xml",
      "manifest.json",
      "report.json",
      "run.json",
      "terminal.txt",
    ]);
    expect(written.manifest.artifacts).toHaveLength(6);
    expect(written.manifest.redaction).toMatchObject({
      policy: "safe_fields_v2",
      applied: true,
    });
    expect(written.manifest.redaction.replacements).toBeGreaterThan(0);
    expect(written.manifest.reproduction).toMatchObject({
      scope: "world_inputs",
      drillId: "generic-agent-behavior",
      buildHash: HASH,
      seed: "41",
    });
    expect(written.manifest.trajectoryHash).toBe(input.result.trajectoryHash);
    expect(written.manifest.tools).toMatchObject([
      { id: "generic-tool", compatibility: [{ id: "official-client" }] },
    ]);
    expect(written.manifest.projectedRunResultHash).toBe(
      semanticHash(JSON.parse(readFileSync(written.files.run, "utf8"))),
    );
    expect(JSON.parse(readFileSync(written.files.manifest, "utf8"))).toEqual(written.manifest);
    for (const file of readdirSync(destination)) {
      const body = readFileSync(join(destination, file), "utf8");
      expect(body).not.toContain("built-in-secret-1234");
      expect(body).not.toContain("declared-secret-5678");
    }
    expect(verifyLocalReport(destination)).toMatchObject({
      manifest: { runId: "run_report001", complete: true },
      result: { identity: { drillId: "generic-agent-behavior" } },
      tools: [{ id: "generic-tool", compatibility: [{ id: "official-client" }] }],
    });
    expect(() => writeLocalReport(input, destination)).toThrow(/refusing to overwrite/);
  });

  it("retains controller fault changes separately from triggered failures in portable reports", () => {
    const entries: readonly EvidenceEntry[] = [
      ...evidence(),
      {
        schemaVersion: 1,
        sequence: 3,
        transactionId: "txn_report003",
        transactionIndex: 0,
        transactionSize: 1,
        virtualTimeUs: 500,
        correlationId: "corr_report003",
        kind: "fault_control",
        packageId: "generic-tool",
        faultId: "unavailable",
        previouslyActive: false,
        active: true,
      },
    ];
    const input = { result: run(entries), evidence: entries };
    const written = writeLocalReport(input, join(temporaryDirectory(), "controlled"));
    const verified = verifyLocalReport(written.directory);
    expect(verified.evidence.at(-1)).toMatchObject({ kind: "fault_control", active: true });
    expect(readFileSync(written.files.html, "utf8")).toContain("generic-tool.unavailable · enabled");
    expect(verified.evidence.filter((entry) => entry.kind === "fault")).toHaveLength(0);
    for (const file of [written.files.html, written.files.terminal]) {
      const text = readFileSync(file, "utf8");
      expect(text).toContain(file === written.files.html ? "Run again" : "Rerun initial world inputs");
      expect(text).toContain("Runtime fault controls require the original harness");
      expect(text).not.toContain("Reproduce");
    }
    const initialEntries = evidence();
    const baseline = writeLocalReport(
      { result: run(initialEntries), evidence: initialEntries },
      join(temporaryDirectory(), "uncontrolled"),
    );
    expect(compareLocalReports(baseline.directory, written.directory).compatibility).toMatchObject({
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      differences: ["runtime_controls"],
    });
    expect(compareLocalReports(written.directory, baseline.directory).compatibility).toMatchObject({
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      differences: ["runtime_controls"],
    });
    expect(compareLocalReports(written.directory, written.directory).compatibility).toMatchObject({
      status: "descriptive_only",
      canAttributeBehaviorChange: false,
      differences: [],
    });
  });

  it("copies, renders, and verifies bounded file attachments as report artifacts", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const original = run(entries);
    if (original.status !== "sealed") throw new Error("fixture must be sealed");
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const source = join(root, "screen.png");
    writeFileSync(source, body);
    const attachment = {
      schemaVersion: 1 as const,
      kind: "file" as const,
      id: "attachment-report-screen",
      name: "screen.png",
      mediaType: "image/png",
      bytes: body.byteLength,
      hash: `sha256:${createHash("sha256").update(body).digest("hex")}` as const,
      redaction: { status: "not_applied" as const, note: null },
    };
    const interactions = original.interactions.map((interaction, index) =>
      index === 0
        ? {
            ...interaction,
            targetResult: { ...interaction.targetResult, attachments: [attachment] },
          }
        : interaction,
    );
    const result = RunResultSchema.parse({
      ...original,
      interactions,
      trajectoryHash: trajectoryHash({ interactions, checkpoints: original.checkpoints, evidence: entries }),
    });
    const destination = join(root, "attachment-report");
    const written = writeLocalReport(
      {
        result,
        evidence: entries,
        attachmentSources: [{ attachmentId: attachment.id, path: source }],
      },
      destination,
    );

    expect(written.attachments).toEqual([
      {
        attachment,
        path: join(destination, "attachments", attachment.id, attachment.name),
      },
    ]);
    expect(readFileSync(written.attachments[0]?.path ?? "")).toEqual(body);
    expect(written.manifest.artifacts).toContainEqual({
      path: `attachments/${attachment.id}/${attachment.name}`,
      mediaType: "image/png",
      bytes: body.byteLength,
      hash: attachment.hash,
      role: "attachment",
    });
    const verified = verifyLocalReport(destination);
    expect(verified.attachments).toEqual([
      {
        attachment,
        path: join(destination, "attachments", attachment.id, attachment.name),
      },
    ]);
    expect(readFileSync(written.files.html, "utf8")).toMatch(/copied verbatim without redaction/i);

    writeFileSync(written.attachments[0]?.path ?? "", "tampered");
    expect(() => verifyLocalReport(destination)).toThrowError(
      expect.objectContaining({ code: "reporter.ARTIFACT_MISMATCH" }),
    );
  });

  it("rejects missing, extra, and symlinked attachment sources before publishing a report", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const original = run(entries);
    if (original.status !== "sealed") throw new Error("fixture must be sealed");
    const body = Buffer.from("supporting evidence");
    const source = join(root, "evidence.txt");
    writeFileSync(source, body);
    const attachment = {
      schemaVersion: 1 as const,
      kind: "file" as const,
      id: "attachment-report-evidence",
      name: "evidence.txt",
      mediaType: "text/plain",
      bytes: body.byteLength,
      hash: `sha256:${createHash("sha256").update(body).digest("hex")}` as const,
      redaction: { status: "applied_by_caller" as const, note: "Fixture output only" },
    };
    const interactions = original.interactions.map((interaction, index) =>
      index === 0
        ? { ...interaction, targetResult: { ...interaction.targetResult, attachments: [attachment] } }
        : interaction,
    );
    const result = RunResultSchema.parse({
      ...original,
      interactions,
      trajectoryHash: trajectoryHash({ interactions, checkpoints: original.checkpoints, evidence: entries }),
    });

    expect(() => writeLocalReport({ result, evidence: entries }, join(root, "missing"))).toThrow(
      /descriptors and staged sources must match exactly/,
    );
    expect(() =>
      writeLocalReport(
        {
          result: original,
          evidence: entries,
          attachmentSources: [{ attachmentId: attachment.id, path: source }],
        },
        join(root, "extra"),
      ),
    ).toThrow(/descriptors and staged sources must match exactly/);
    const linked = join(root, "linked.txt");
    symlinkSync(source, linked);
    expect(() =>
      writeLocalReport(
        {
          result,
          evidence: entries,
          attachmentSources: [{ attachmentId: attachment.id, path: linked }],
        },
        join(root, "linked-source"),
      ),
    ).toThrow(/regular file, not a symlink/);
  });

  it("redacts payload secrets without rewriting structural verdicts or statuses", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const original = run(entries);
    if (original.status !== "sealed") throw new Error("fixture must be sealed");
    const interactions = original.interactions.map((interaction) => ({
      ...interaction,
      targetResult: {
        ...interaction.targetResult,
        output: { sessionToken: "passed", forwarded: "long-secret-value" },
      },
    }));
    const secretEntries = entries.map((entry, index) =>
      index === 0 && entry.kind === "lifecycle"
        ? { ...entry, details: { ...entry.details, sessionToken: "passed", apiToken: "long-secret-value" } }
        : entry,
    );
    const result = RunResultSchema.parse({
      ...original,
      interactions,
      evidenceHash: semanticHash(secretEntries),
      trajectoryHash: trajectoryHash({
        interactions,
        checkpoints: original.checkpoints,
        evidence: secretEntries,
      }),
    });
    const destination = join(root, "structural-values");
    const written = writeLocalReport({ result, evidence: secretEntries }, destination);
    const projected = JSON.parse(readFileSync(written.files.run, "utf8")) as {
      verdict: string;
      interactions: Array<{ targetResult: { output: Record<string, string> } }>;
    };
    expect(projected.verdict).toBe("passed");
    expect(projected.interactions[0]?.targetResult.output).toEqual({
      sessionToken: "[REDACTED]",
      forwarded: "[REDACTED]",
    });
    expect(() => verifyLocalReport(destination)).not.toThrow();
  });

  it("rejects tampered artifacts, extra files, and symbolic links", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const input = { result: run(entries), evidence: entries, tools: tools() };

    const tampered = writeLocalReport(input, join(root, "tampered"));
    writeFileSync(tampered.files.html, "modified");
    expect(() => verifyLocalReport(tampered.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.ARTIFACT_MISMATCH" }),
    );

    const extra = writeLocalReport(input, join(root, "extra"));
    writeFileSync(join(extra.directory, "unlisted.txt"), "not in manifest");
    expect(() => verifyLocalReport(extra.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const linked = writeLocalReport(input, join(root, "linked"));
    symlinkSync(linked.files.html, join(linked.directory, "unlisted-link"));
    expect(() => verifyLocalReport(linked.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const linkedManifest = writeLocalReport(input, join(root, "linked-manifest"));
    const outsideManifest = join(root, "outside-manifest.json");
    writeFileSync(outsideManifest, "not a report manifest");
    rmSync(linkedManifest.files.manifest);
    symlinkSync(outsideManifest, linkedManifest.files.manifest);
    expect(() => verifyLocalReport(linkedManifest.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_CONTENT_MISMATCH" }),
    );

    const oversized = writeLocalReport(input, join(root, "oversized"));
    const oversizedManifest = JSON.parse(readFileSync(oversized.files.manifest, "utf8")) as {
      artifacts: Array<{ path: string; bytes: number }>;
    };
    const htmlArtifact = oversizedManifest.artifacts.find((artifact) => artifact.path === "index.html");
    if (htmlArtifact === undefined) throw new Error("fixture has no HTML artifact");
    htmlArtifact.bytes = 64 * 1024 * 1024 + 1;
    writeFileSync(oversized.files.manifest, `${JSON.stringify(oversizedManifest, null, 2)}\n`);
    expect(() => verifyLocalReport(oversized.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.BUNDLE_LIMIT_EXCEEDED" }),
    );
  });

  it("rejects a projection that is internally rehashed but disagrees with the run", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const written = writeLocalReport(
      { result: run(entries), evidence: entries, tools: tools() },
      join(root, "inconsistent"),
    );
    const changed = readFileSync(written.files.terminal, "utf8").replace("PASSED", "FAILED");
    writeFileSync(written.files.terminal, changed);
    const manifest = JSON.parse(readFileSync(written.files.manifest, "utf8")) as {
      artifacts: Array<{ path: string; bytes: number; hash: string }>;
    };
    const terminal = manifest.artifacts.find((artifact) => artifact.path === "terminal.txt");
    if (terminal === undefined) throw new Error("fixture has no terminal artifact");
    terminal.bytes = Buffer.byteLength(changed);
    terminal.hash = `sha256:${createHash("sha256").update(changed).digest("hex")}`;
    writeFileSync(written.files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyLocalReport(written.directory)).toThrowError(
      expect.objectContaining({ code: "reporter.REPORT_INVALID" }),
    );
  });

  it("rejects evidence that does not belong to the sealed result", () => {
    const entries = evidence();
    expect(() => renderTerminalReport({ result: run(entries), evidence: [] })).toThrow(
      /does not match the sealed run range/,
    );
  });

  it("compares exact-input runs without inventing a regression label", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const baselineResult = run(entries);
    const baseline = writeLocalReport({ result: baselineResult, evidence: entries }, join(root, "baseline"));
    if (baselineResult.status !== "sealed") throw new Error("fixture must be sealed");
    const baselineAssertion = baselineResult.assertionResults[0];
    if (baselineAssertion === undefined) throw new Error("fixture has no assertion");
    const failedAssertion = AssertionResultSchema.parse({
      ...baselineAssertion,
      status: "failed",
      message: "operation count did not match",
      actual: 1,
      diff: { ...baselineAssertion.diff, matched: false },
    });
    const checkpoints = baselineResult.checkpoints.map((checkpoint) =>
      checkpoint.kind === "final"
        ? { ...checkpoint, verdict: "failed" as const, assertionResults: [failedAssertion] }
        : checkpoint,
    );
    const candidateResult = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report002",
        worldInstanceId: "world_report002",
      },
      verdict: "failed",
      stateHash: HASH_B,
      checkpoints,
      assertionResults: [failedAssertion],
      trajectoryHash: trajectoryHash({
        interactions: baselineResult.interactions,
        checkpoints,
        evidence: entries,
      }),
    });
    const candidate = writeLocalReport(
      { result: candidateResult, evidence: entries },
      join(root, "candidate"),
    );

    const comparison = compareLocalReports(baseline.directory, candidate.directory);
    expect(comparison).toMatchObject({
      compatibility: {
        status: "exact_inputs",
        canAttributeBehaviorChange: true,
        differences: [],
      },
      outcome: "changed",
      baseline: { verdict: "passed" },
      candidate: { verdict: "failed" },
      changes: {
        verdictChanged: true,
        stateChanged: true,
        trajectoryChanged: true,
        assertions: [
          {
            checkpointId: "final",
            assertionId: "no-extra-actions",
            baseline: "passed",
            candidate: "failed",
            actualChanged: true,
          },
        ],
      },
    });
    expect(comparison).not.toHaveProperty("regression");
  });

  it("downgrades changed worlds and rejects mismatched run inputs", () => {
    const root = temporaryDirectory();
    const entries = evidence();
    const baselineResult = run(entries);
    const baseline = writeLocalReport({ result: baselineResult, evidence: entries }, join(root, "baseline"));
    const changedBuild = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report003",
        worldInstanceId: "world_report003",
        buildHash: HASH_B,
      },
    });
    const buildCandidate = writeLocalReport(
      { result: changedBuild, evidence: entries },
      join(root, "changed-build"),
    );
    expect(compareLocalReports(baseline.directory, buildCandidate.directory)).toMatchObject({
      compatibility: {
        status: "descriptive_only",
        canAttributeBehaviorChange: false,
        differences: ["build"],
      },
    });

    const changedSeed = RunResultSchema.parse({
      ...baselineResult,
      identity: {
        ...baselineResult.identity,
        runId: "run_report004",
        worldInstanceId: "world_report004",
        seed: "42",
      },
    });
    const seedCandidate = writeLocalReport(
      { result: changedSeed, evidence: entries },
      join(root, "changed-seed"),
    );
    expect(compareLocalReports(baseline.directory, seedCandidate.directory)).toMatchObject({
      compatibility: { status: "incompatible", differences: ["seed"] },
      outcome: "not_comparable",
    });
  });
});
