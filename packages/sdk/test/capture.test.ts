import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCaptureHandle, RunResult } from "@firedrill-run/contracts";
import { RunIdSchema } from "@firedrill-run/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCaptureManager } from "../src/capture.js";
import { type AgentInvocation, runDrills, verifyReport } from "../src/index.js";

const directories: string[] = [];
function repository(
  shape: "validator" | "ledger" | "counter" = "validator",
  targetKind: "external" | "module" | "command" = "external",
) {
  const root = mkdtempSync(join(tmpdir(), "firedrill-capture-test-"));
  directories.push(root);
  mkdirSync(join(root, "world"));
  const json = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
  json("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  const operationId =
    shape === "validator" ? "text.validate" : shape === "ledger" ? "entry.append" : "counter.increment";
  const operation = { packageId: shape, operationId };
  const state =
    shape === "ledger"
      ? [
          {
            namespace: "entries",
            schema: {
              type: "object",
              required: ["memo"],
              properties: { memo: { type: "string" } },
              additionalProperties: false,
            },
          },
        ]
      : shape === "counter"
        ? [
            {
              namespace: "counters",
              schema: {
                type: "object",
                required: ["count"],
                properties: { count: { type: "integer" } },
                additionalProperties: false,
              },
            },
          ]
        : [];
  json("world/world.json", {
    schemaVersion: 1,
    id: `${shape}-world`,
    seed: "42",
    actors: [{ id: "tester", grants: [operation] }],
    state:
      shape === "counter"
        ? [{ action: "upsert", packageId: shape, namespace: "counters", rowId: "one", value: { count: 0 } }]
        : [],
  });
  json("world/tool.tool.json", {
    schemaVersion: 1,
    module: "./tool.js",
    manifest: {
      schemaVersion: 1,
      id: shape,
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: shape === "validator" ? [] : ["state.read", "state.write"],
      state,
      operations: [
        {
          id: operationId,
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "boolean" },
          idempotency: "optional",
          fidelity: "stateful",
        },
      ],
    },
  });
  const handler =
    shape === "validator"
      ? "return true;"
      : shape === "ledger"
        ? 'context.state.put("entries", "written", { memo: "a ledger entry" }); return true;'
        : 'context.state.put("counters", "one", { count: 1 }); return true;';
  writeFileSync(
    join(root, "world/tool.js"),
    `export default { operations: { ${JSON.stringify(operationId)}: (input, context) => { ${handler} } } };`,
  );
  const binding = shape === "ledger" ? "http" : "direct";
  const target =
    targetKind === "module"
      ? { id: "agent", kind: "module", bindings: [binding], module: "agent.js", timeoutMs: 5000 }
      : targetKind === "command"
        ? {
            id: "agent",
            kind: "command",
            bindings: ["http"],
            executable: process.execPath,
            arguments: ["agent-command.js"],
            timeoutMs: 5000,
          }
        : { id: "agent", kind: "external", bindings: [binding], timeoutMs: 5000 };
  json("world/agent.target.json", { schemaVersion: 1, target });
  const assertion =
    shape === "ledger"
      ? {
          id: "written",
          kind: "state.count",
          packageId: shape,
          namespace: "entries",
          comparison: { operator: "equals", value: 1 },
        }
      : shape === "counter"
        ? {
            id: "incremented",
            kind: "state.value",
            packageId: shape,
            namespace: "counters",
            rowId: "one",
            path: ["count"],
            comparison: { operator: "equals", value: 1 },
          }
        : {
            id: "validated",
            kind: "operation.count",
            operation,
            comparison: { operator: "equals", value: 1 },
          };
  json("world/check.drill.json", {
    schemaVersion: 1,
    id: "check",
    targetId: "agent",
    actorId: "tester",
    scenarioId: "initial",
    task: { instruction: "Perform the declared operation." },
    assertions: [assertion],
  });
  json("world/initial.scenario.json", { schemaVersion: 1, id: "initial" });
  writeFileSync(
    join(root, "agent.js"),
    `export default (_invocation, context) => { context.capture.log("module-owned log"); return context.world.invoke(${JSON.stringify(operation)}, {}).outcome.status; };`,
  );
  writeFileSync(
    join(root, "agent-command.js"),
    'process.stderr.write("x".repeat(20000)); process.stdout.write(JSON.stringify({ completed: true }));',
  );
  writeFileSync(join(root, "screen.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(root, "recording.webm"), Buffer.from("1a45dfa3", "hex"));
  writeFileSync(join(root, "notes.txt"), "caller-owned notes");
  return { root, operation, binding };
}

async function act(invocation: AgentInvocation, fixture: ReturnType<typeof repository>) {
  if (fixture.binding === "direct")
    return invocation.binding.world?.invoke(fixture.operation, {}).outcome.status;
  const response = await fetch(
    `${invocation.binding.environment.FIREDRILL_HTTP_URL}/v1/operations/${fixture.operation.packageId}/${fixture.operation.operationId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${invocation.binding.environment.FIREDRILL_HTTP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ arguments: {} }),
    },
  );
  expect(response.ok).toBe(true);
  return response.json();
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("public opt-in run capture", () => {
  it("runs class prototype lifecycle methods with their caller-owned state bound to this", async () => {
    const fixture = repository();
    class BrowserDriver {
      readonly page = { calls: [] as string[], screenshot: { path: "screen.png", mediaType: "image/png" } };
      startVideo() {
        this.page.calls.push("start");
      }
      screenshot() {
        this.page.calls.push("screenshot");
        return this.page.screenshot;
      }
      stopVideo() {
        this.page.calls.push("stop");
        return { path: "recording.webm", mediaType: "video/webm" };
      }
      dispose() {
        this.page.calls.push("dispose");
      }
    }
    const driver = new BrowserDriver();
    const result = await runDrills({
      root: fixture.root,
      capture: { screenshots: "always", video: "always" },
      agent: async (invocation) => {
        await invocation.capture.registerDriver(driver);
        return act(invocation, fixture);
      },
    });
    expect(result.verdict).toBe("passed");
    expect(driver.page.calls).toEqual(["start", "screenshot", "stop", "dispose"]);
    expect(result.drills[0]?.trials[0]?.result.capture).toMatchObject({
      errors: [],
      attachments: [{ kind: "screenshot" }, { kind: "video" }],
    });
  });

  it("reads supported getters once and reports invalid or throwing accessors without changing the verdict", async () => {
    const fixture = repository();
    let reads = 0;
    const result = await runDrills({
      root: fixture.root,
      capture: { screenshots: "always" },
      agent: async (invocation) => {
        await invocation.capture.registerDriver({
          get screenshot() {
            reads += 1;
            return () => ({ path: "screen.png", mediaType: "image/png" });
          },
        });
        await invocation.capture.registerDriver({
          get screenshot(): () => { path: string; mediaType: string } {
            throw new Error("sensitive driver getter details");
          },
        });
        await invocation.capture.registerDriver({ screenshot: "not callable" } as unknown as Parameters<
          RunCaptureHandle["registerDriver"]
        >[0]);
        await invocation.capture.registerDriver({});
        await invocation.capture.registerDriver({
          screenshot: () => ({ path: "screen.png", mediaType: "image/png" }),
          typo: () => undefined,
        } as Parameters<RunCaptureHandle["registerDriver"]>[0]);
        return act(invocation, fixture);
      },
    });
    const capture = result.drills[0]?.trials[0]?.result.capture;
    expect(result.verdict).toBe("passed");
    expect(reads).toBe(1);
    expect(capture?.attachments).toHaveLength(1);
    expect(capture?.errors.map((error) => error.code)).toEqual([
      "capture.UNAVAILABLE",
      "capture.DRIVER_INVALID",
      "capture.DRIVER_INVALID",
      "capture.DRIVER_INVALID",
    ]);
    expect(JSON.stringify(capture)).not.toContain("sensitive driver getter");
  });
  it("is disabled without options and all-off skips every driver and source read", async () => {
    const fixture = repository();
    const driver = { screenshot: vi.fn(), startVideo: vi.fn(), stopVideo: vi.fn(), dispose: vi.fn() };
    for (const options of [undefined, {}]) {
      const result = await runDrills({
        root: fixture.root,
        ...(options === undefined ? {} : { capture: options }),
        agent: async (invocation) => {
          expect(invocation.capture.policies.logs).toBe("off");
          invocation.capture.file({ path: "absent", mediaType: "text/plain" });
          invocation.capture.log("ignored");
          await invocation.capture.registerDriver(driver);
          return act(invocation, fixture);
        },
      });
      const trial = result.drills[0]?.trials[0];
      expect(result.verdict).toBe("passed");
      expect(trial?.report.attachments).toHaveLength(0);
      if (options === undefined) expect(trial?.result).not.toHaveProperty("capture");
      else expect(trial?.result.capture?.errors).toEqual([]);
    }
    for (const callback of Object.values(driver)) expect(callback).not.toHaveBeenCalled();
  });

  it("decides retention after final assertions, isolates concurrent retries, and preserves legacy attach", async () => {
    const fixture = repository();
    const attempts = new Map<string, number>();
    const lifecycle: string[] = [];
    const result = await runDrills({
      root: fixture.root,
      trials: 2,
      retries: 1,
      concurrency: 2,
      capture: {
        logs: "retain-on-failure",
        screenshots: "retain-on-failure",
        video: "retain-on-failure",
        files: "retain-on-failure",
      },
      hooks: {
        attemptStarted: ({ runId, attempt }) => {
          attempts.set(runId, attempt);
        },
        attemptFinished: ({ runId, execution }) => {
          expect(execution.result.capture).toBeDefined();
          lifecycle.push(`${runId}:finished`);
        },
      },
      agent: async (invocation) => {
        const { capture, runId, attach } = invocation;
        capture.log(`run ${runId}`);
        capture.file({ path: "notes.txt", mediaType: "text/plain" });
        attach({ path: "notes.txt", name: "legacy.txt", mediaType: "text/plain" });
        await capture.registerDriver({
          startVideo: () => {
            lifecycle.push(`${runId}:start`);
          },
          screenshot: () => {
            lifecycle.push(`${runId}:screen`);
            return { path: "screen.png", mediaType: "image/png" };
          },
          stopVideo: () => {
            lifecycle.push(`${runId}:stop`);
            return { path: "recording.webm", mediaType: "video/webm" };
          },
          dispose: () => {
            lifecycle.push(`${runId}:dispose`);
          },
        });
        if (attempts.get(runId) === 2) return act(invocation, fixture);
        return "agent returned normally but final assertion must fail";
      },
    });
    for (const trial of result.drills[0]?.trials ?? []) {
      expect(trial.attempts).toHaveLength(2);
      const failed = trial.attempts[0];
      const passed = trial.attempts[1];
      expect(failed?.result).toMatchObject({ status: "sealed", verdict: "failed", capture: { errors: [] } });
      expect(failed?.result.capture?.attachments.map((item) => item.kind).sort()).toEqual([
        "file",
        "log",
        "screenshot",
        "video",
      ]);
      expect(failed?.report.attachments).toHaveLength(5);
      expect(passed?.result).toMatchObject({
        status: "sealed",
        verdict: "passed",
        capture: { attachments: [], discarded: { logs: 1, screenshots: 0, video: 1, files: 1 } },
      });
      expect(passed?.report.attachments).toHaveLength(1);
      for (const attempt of trial.attempts) {
        const id = attempt.result.identity.runId;
        expect(lifecycle.filter((value) => value.startsWith(id))).toEqual(
          attempt === failed
            ? [`${id}:start`, `${id}:screen`, `${id}:stop`, `${id}:dispose`, `${id}:finished`]
            : [`${id}:start`, `${id}:stop`, `${id}:dispose`, `${id}:finished`],
        );
        expect(verifyReport({ report: attempt.report.directory }).result.identity.runId).toBe(id);
      }
    }
    expect(readFileSync(join(fixture.root, "notes.txt"), "utf8")).toBe("caller-owned notes");
    expect(existsSync(join(fixture.root, "screen.png"))).toBe(true);
    expect(existsSync(join(fixture.root, "recording.webm"))).toBe(true);
  });

  it.each(["ledger", "counter"] as const)(
    "captures unrelated %s world through its ordinary agent shape and protocol",
    async (shape) => {
      const fixture = repository(shape, shape === "counter" ? "module" : "external");
      const result = await runDrills({
        root: fixture.root,
        capture: { logs: "always" },
        ...(shape === "counter"
          ? {}
          : {
              agent: async (invocation: AgentInvocation) => {
                invocation.capture.log("HTTP harness log");
                return act(invocation, fixture);
              },
            }),
      });
      expect(result.verdict).toBe("passed");
      const trial = result.drills[0]?.trials[0];
      expect(trial?.result.capture?.attachments).toHaveLength(1);
      expect(trial?.result.capture?.attachments[0]?.kind).toBe("log");
      expect(readFileSync(trial?.report.attachments[0]?.path ?? "", "utf8")).toContain(
        shape === "counter" ? "module-owned log" : "HTTP harness log",
      );
    },
  );

  it("keeps passing verdict and immutable evidence hashes despite sanitized driver errors, timeout and late completion", async () => {
    const fixture = repository();
    let lateHandle: RunCaptureHandle | undefined;
    let resolveLate: ((input: { path: string; mediaType: string }) => void) | undefined;
    const dispose = vi.fn();
    const plain = await runDrills({ root: fixture.root, agent: (invocation) => act(invocation, fixture) });
    const captured = await runDrills({
      root: fixture.root,
      capture: { screenshots: "always", logs: "always", driverTimeoutMs: 10 },
      agent: async (invocation) => {
        lateHandle = invocation.capture;
        await invocation.capture.registerDriver({
          screenshot: () =>
            new Promise((resolve) => {
              resolveLate = resolve;
            }),
          dispose,
        });
        await invocation.capture.registerDriver({
          screenshot: () => {
            throw new Error("secret private path /private/example");
          },
          dispose,
        });
        return act(invocation, fixture);
      },
    });
    const trial = captured.drills[0]?.trials[0];
    const before = JSON.stringify(trial?.result.capture);
    resolveLate?.({ path: "screen.png", mediaType: "image/png" });
    lateHandle?.log("too late");
    await Promise.resolve();
    expect(JSON.stringify(trial?.result.capture)).toBe(before);
    expect(before).not.toContain("secret private");
    expect(trial?.result.capture?.errors.map((error) => error.code)).toEqual([
      "capture.DRIVER_TIMEOUT",
      "capture.UNAVAILABLE",
    ]);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(captured.verdict).toBe("passed");
    const original = plain.drills[0]?.trials[0]?.result;
    if (trial?.result.status !== "sealed" || original?.status !== "sealed")
      throw new Error("expected sealed results");
    expect(trial.result.stateHash).toBe(original.stateHash);
    expect(trial.result.trajectoryHash).toBe(original.trajectoryHash);
    expect(trial.evidence.some((entry) => JSON.stringify(entry).includes("capture"))).toBe(false);
  });

  it("retains cancellation capture and tears down a registered driver once", async () => {
    const fixture = repository();
    const controller = new AbortController();
    const dispose = vi.fn();
    const result = await runDrills({
      root: fixture.root,
      signal: controller.signal,
      capture: { logs: "retain-on-failure", screenshots: "retain-on-failure" },
      agent: async (invocation) => {
        invocation.capture.log("before cancellation");
        await invocation.capture.registerDriver({
          screenshot: () => ({ path: "screen.png", mediaType: "image/png" }),
          dispose,
        });
        controller.abort();
      },
    });
    const trial = result.drills[0]?.trials[0];
    expect(trial?.result.status).toBe("cancelled");
    expect(trial?.result.capture?.attachments).toHaveLength(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("shares legacy file count budgets and rejects unsafe inputs without changing the verdict", async () => {
    const fixture = repository();
    symlinkSync(join(fixture.root, "notes.txt"), join(fixture.root, "linked.txt"));
    const result = await runDrills({
      root: fixture.root,
      capture: { files: "always", logs: "always" },
      agent: (invocation) => {
        invocation.attach({ path: "notes.txt", mediaType: "text/plain" });
        for (const path of ["../outside", "linked.txt", "/private/secret", "missing"])
          invocation.capture.file({ path, mediaType: "text/plain" });
        invocation.capture.log("x".repeat(16 * 1024 + 1));
        for (let index = 0; index < 33; index += 1)
          invocation.capture.file({ path: "notes.txt", mediaType: "text/plain" });
        return act(invocation, fixture);
      },
    });
    const trial = result.drills[0]?.trials[0];
    expect(result.verdict).toBe("passed");
    expect(trial?.report.attachments).toHaveLength(32);
    expect(trial?.result.capture?.errors).toHaveLength(7);
    expect(JSON.stringify(trial?.result.capture)).not.toContain("/private/secret");
  });

  it("preserves legacy attach verdict behavior when optional captures fill the budget first", async () => {
    const fixture = repository();
    const result = await runDrills({
      root: fixture.root,
      capture: { files: "always" },
      agent: (invocation) => {
        for (let index = 0; index < 32; index += 1)
          invocation.capture.file({ path: "notes.txt", mediaType: "text/plain" });
        invocation.attach({ path: "notes.txt", name: "legacy-last.txt", mediaType: "text/plain" });
        return act(invocation, fixture);
      },
    });
    const trial = result.drills[0]?.trials[0];
    expect(result.verdict).toBe("passed");
    expect(trial?.report.attachments).toHaveLength(32);
    expect(trial?.result.capture?.attachments).toHaveLength(31);
    expect(trial?.result.capture?.errors).toMatchObject([{ code: "capture.LIMIT_EXCEEDED" }]);
    expect(trial?.result.interactions[0]?.targetResult.attachments).toMatchObject([
      { name: "legacy-last.txt" },
    ]);
  });

  it("copies command stderr larger than one log message without dropping it", async () => {
    const fixture = repository("validator", "command");
    const result = await runDrills({ root: fixture.root, capture: { logs: "always" } });
    const trial = result.drills[0]?.trials[0];
    expect(trial?.result.capture?.errors).toEqual([]);
    const text = readFileSync(trial?.report.attachments[0]?.path ?? "", "utf8");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { message: string }).message)
        .join(""),
    ).toBe("x".repeat(20000));
    expect(trial?.result.interactions[0]?.targetResult.attachments[0]?.text).toBe("x".repeat(20000));
  });

  it("retains supporting captures for runner failure and inconclusive terminal results", async () => {
    const fixture = repository();
    const executed = await runDrills({ root: fixture.root, agent: (invocation) => act(invocation, fixture) });
    const original = executed.drills[0]?.trials[0]?.result;
    if (original === undefined) throw new Error("missing result");
    for (const terminal of [
      {
        ...original,
        status: "runner_failed",
        error: {
          schemaVersion: 1,
          code: "framework.INTERNAL_ERROR",
          source: "framework",
          message: "runner failed",
          retryable: false,
          issues: [],
        },
      },
      { ...original, status: "sealed", verdict: "inconclusive" },
    ] as RunResult[]) {
      const manager = new LocalCaptureManager(fixture.root, { logs: "retain-on-failure" }, () => ({
        count: 0,
        bytes: 0,
      }));
      const id = RunIdSchema.parse(terminal.identity.runId);
      manager.handle(id).log("terminal diagnostics");
      const captured = await manager.finish(terminal);
      expect(captured.capture?.attachments).toHaveLength(1);
      expect(captured.status).toBe(terminal.status);
      const { capture: _capture, ...withoutCapture } = captured;
      expect(withoutCapture).toEqual(terminal);
      await manager.dispose();
    }
  });

  it("counts discarded staging files against the global byte limit when unlink fails", async () => {
    const fixture = repository();
    const executed = await runDrills({ root: fixture.root, agent: (invocation) => act(invocation, fixture) });
    const original = executed.drills[0]?.trials[0]?.result;
    if (original === undefined) throw new Error("missing result");
    writeFileSync(join(fixture.root, "large.bin"), "");
    truncateSync(join(fixture.root, "large.bin"), 64 * 1024 * 1024);
    const manager = new LocalCaptureManager(fixture.root, { files: "retain-on-failure" }, () => ({
      count: 0,
      bytes: 0,
    }));
    const remove = fs.rmSync;
    const failedUnlinks: string[] = [];
    const unlink = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path).includes("firedrill-capture-stage-") && options === undefined) {
        failedUnlinks.push(String(path));
        throw Object.assign(new Error("injected private unlink failure"), { code: "EACCES" });
      }
      remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      for (let index = 0; index < 4; index += 1) {
        const runId = RunIdSchema.parse(`run_orphanbudget${index}`);
        manager.handle(runId).file({ path: "large.bin", mediaType: "application/zip" });
        const result = await manager.finish({ ...original, identity: { ...original.identity, runId } });
        expect(result.capture).toMatchObject({
          attachments: [],
          errors: [{ code: "capture.UNAVAILABLE" }],
          discarded: { files: 1 },
        });
      }
      expect(failedUnlinks).toHaveLength(4);
      expect(failedUnlinks.every((path) => existsSync(path))).toBe(true);
      const runId = RunIdSchema.parse("run_orphanbudgetblocked");
      manager.handle(runId).file({ path: "notes.txt", mediaType: "text/plain" });
      const blocked = await manager.finish({ ...original, identity: { ...original.identity, runId } });
      expect(blocked.capture).toMatchObject({
        attachments: [],
        errors: [{ code: "capture.LIMIT_EXCEEDED" }],
        discarded: { files: 0 },
      });
    } finally {
      unlink.mockRestore();
      syncBuiltinESMExports();
      await manager.dispose();
    }
    expect(failedUnlinks.every((path) => !existsSync(path))).toBe(true);
  });
});
