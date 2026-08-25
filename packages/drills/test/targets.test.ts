import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetInvocation } from "@firedrill/contracts";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { invokeTarget } from "../src/index.js";

const temporaryDirectories: string[] = [];

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-target-"));
  temporaryDirectories.push(directory);
  return directory;
}

function invocation(bindingEnvironment: Record<string, string> = {}): TargetInvocation {
  return {
    schemaVersion: 1,
    runId: "run_target001",
    interactionId: "initial-request",
    actorId: "operator",
    instruction: "Complete the assigned task.",
    input: { ticketId: "ticket-7" },
    bindingEnvironment,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agent target invocation", () => {
  it("loads a TypeScript module inside the repository and exposes only declared bindings", async () => {
    const root = repository();
    writeFileSync(
      join(root, "agent.ts"),
      [
        "export async function run(invocation: { instruction: string; bindingEnvironment: Record<string, string> }, context: { world?: unknown }) {",
        "  return { instruction: invocation.instruction, endpoint: invocation.bindingEnvironment.FIREDRILL_HTTP_URL, direct: context.world !== undefined };",
        "}",
      ].join("\n"),
    );

    const result = await invokeTarget({
      descriptor: {
        id: "typescript-agent",
        kind: "module",
        bindings: ["http"],
        module: "agent.ts",
        export: "run",
        timeoutMs: 1_000,
      },
      invocation: invocation({ FIREDRILL_HTTP_URL: "http://127.0.0.1:9000" }),
      repositoryRoot: root,
    });

    expect(result).toMatchObject({
      status: "completed",
      output: {
        instruction: "Complete the assigned task.",
        endpoint: "http://127.0.0.1:9000",
        direct: false,
      },
    });
  });

  it("runs a subprocess with JSON stdin and an allowlisted environment", async () => {
    const root = repository();
    writeFileSync(
      join(root, "agent.mjs"),
      [
        'let input = "";',
        "for await (const chunk of process.stdin) input += chunk;",
        "const invocation = JSON.parse(input);",
        "process.stdout.write(JSON.stringify({",
        "  instruction: invocation.instruction,",
        "  endpoint: process.env.FIREDRILL_MCP_URL,",
        "  mapped: process.env.AGENT_KEY,",
        "  hidden: process.env.UNMAPPED_SECRET ?? null",
        "}));",
      ].join("\n"),
    );

    const result = await invokeTarget({
      descriptor: {
        id: "command-agent",
        kind: "command",
        bindings: ["mcp"],
        executable: process.execPath,
        arguments: ["agent.mjs"],
        workingDirectory: ".",
        environmentFromHost: { AGENT_KEY: "SOURCE_SECRET" },
        timeoutMs: 2_000,
      },
      invocation: invocation({ FIREDRILL_MCP_URL: "http://127.0.0.1:9100/mcp" }),
      repositoryRoot: root,
      hostEnvironment: {
        PATH: process.env.PATH,
        SOURCE_SECRET: "allowed-value",
        UNMAPPED_SECRET: "must-not-leak",
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      output: {
        instruction: "Complete the assigned task.",
        endpoint: "http://127.0.0.1:9100/mcp",
        mapped: "allowed-value",
        hidden: null,
      },
    });
  });

  it("keeps bounded stderr evidence and reports command launch and exit failures precisely", async () => {
    const root = repository();
    writeFileSync(
      join(root, "failing.mjs"),
      'process.stderr.write("Traceback: helper failed\\nRuntimeError: model unavailable\\n"); process.exit(7);\n',
    );
    writeFileSync(
      join(root, "noisy.mjs"),
      'process.stderr.write("x".repeat(1024 * 1024 + 128)); process.stdout.write(JSON.stringify({ ok: true }));\n',
    );
    const base = {
      id: "command-agent",
      kind: "command" as const,
      bindings: ["mcp" as const],
      environmentFromHost: {},
      timeoutMs: 3_000,
    };

    const failed = await invokeTarget({
      descriptor: { ...base, executable: process.execPath, arguments: ["failing.mjs"] },
      invocation: invocation(),
      repositoryRoot: root,
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "target.COMMAND_FAILED",
        message: expect.stringContaining("RuntimeError: model unavailable"),
        details: { executable: process.execPath, stderrAvailable: true, stderrTruncated: false },
      },
      attachments: [
        {
          kind: "process.stderr",
          text: expect.stringContaining("Traceback: helper failed"),
          truncated: false,
        },
      ],
    });

    const noisy = await invokeTarget({
      descriptor: { ...base, executable: process.execPath, arguments: ["noisy.mjs"] },
      invocation: invocation(),
      repositoryRoot: root,
    });
    expect(noisy).toMatchObject({
      status: "completed",
      output: { ok: true },
      attachments: [
        {
          kind: "process.stderr",
          bytes: 1024 * 1024 + 128,
          capturedBytes: 1024 * 1024,
          truncated: true,
        },
      ],
    });

    const missing = await invokeTarget({
      descriptor: {
        ...base,
        executable: "firedrill-definitely-missing-command",
        arguments: [],
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    expect(missing).toMatchObject({
      status: "failed",
      error: {
        code: "target.COMMAND_START_FAILED",
        message: expect.stringContaining("firedrill-definitely-missing-command"),
        details: {
          executable: "firedrill-definitely-missing-command",
          filesystemCode: "ENOENT",
        },
      },
    });
  });

  it("invokes a local HTTP agent endpoint with mapped headers", async () => {
    const requests: Array<{ authorization?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await invokeTarget({
        descriptor: {
          id: "http-agent",
          kind: "http",
          bindings: ["http"],
          url: `http://127.0.0.1:${address.port}/run`,
          method: "POST",
          headersFromEnvironment: { authorization: "AGENT_TOKEN" },
          timeoutMs: 1_000,
        },
        invocation: invocation({ FIREDRILL_HTTP_URL: "http://127.0.0.1:9200" }),
        repositoryRoot: repository(),
        hostEnvironment: { AGENT_TOKEN: "Bearer local-agent" },
      });
      expect(result).toMatchObject({ status: "completed", output: { accepted: true } });
      expect(requests).toEqual([
        {
          authorization: "Bearer local-agent",
          body: expect.objectContaining({
            runId: "run_target001",
            bindingEnvironment: { FIREDRILL_HTTP_URL: "http://127.0.0.1:9200" },
          }),
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("does not follow HTTP redirects or send oversized invocations", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
    });
    await new Promise<void>((resolve, reject) => {
      destination.once("error", reject);
      destination.listen(0, "127.0.0.1", resolve);
    });
    const destinationAddress = destination.address() as AddressInfo;
    let initialRequests = 0;
    const redirect = createServer((_request, response) => {
      initialRequests += 1;
      response.writeHead(307, {
        location: `http://127.0.0.1:${destinationAddress.port}/receive`,
      });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      redirect.once("error", reject);
      redirect.listen(0, "127.0.0.1", resolve);
    });
    const redirectAddress = redirect.address() as AddressInfo;
    const descriptor = {
      id: "redirecting-agent",
      kind: "http" as const,
      bindings: ["http" as const],
      url: `http://127.0.0.1:${redirectAddress.port}/run`,
      method: "POST" as const,
      headersFromEnvironment: { authorization: "AGENT_TOKEN" },
      timeoutMs: 1_000,
    };

    try {
      const redirected = await invokeTarget({
        descriptor,
        invocation: invocation({ FIREDRILL_HTTP_TOKEN: "world-secret" }),
        repositoryRoot: repository(),
        hostEnvironment: { AGENT_TOKEN: "Bearer target-secret" },
      });
      expect(redirected).toMatchObject({
        status: "failed",
        error: { code: "target.HTTP_REDIRECT_FORBIDDEN", details: { status: 307 } },
      });
      expect(initialRequests).toBe(1);
      expect(redirectedRequests).toBe(0);

      const oversized = await invokeTarget({
        descriptor,
        invocation: {
          ...invocation(),
          input: { payload: "x".repeat(1024 * 1024) },
        },
        repositoryRoot: repository(),
        hostEnvironment: { AGENT_TOKEN: "Bearer target-secret" },
      });
      expect(oversized).toMatchObject({
        status: "failed",
        error: { code: "target.INPUT_TOO_LARGE" },
      });
      expect(initialRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all(
        [redirect, destination].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error))),
            ),
        ),
      );
    }
  });

  it("supports a caller-owned target with a direct world binding", async () => {
    let revoked = false;
    const world = {
      revoke: () => {
        revoked = true;
      },
    } as BoundWorldClient;
    const result = await invokeTarget({
      descriptor: {
        id: "embedded-agent",
        kind: "external",
        bindings: ["direct"],
        timeoutMs: 1_000,
      },
      invocation: invocation(),
      repositoryRoot: repository(),
      worldClient: world,
      externalHandler: (_request, context) => ({ receivedWorld: context.world === world }),
    });
    expect(result).toMatchObject({ status: "completed", output: { receivedWorld: true } });
    expect(revoked).toBe(true);
  });

  it("normalizes ordinary JSON-serializable callback output across launch modes", async () => {
    const result = await invokeTarget({
      descriptor: {
        id: "embedded-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 1_000,
      },
      invocation: invocation(),
      repositoryRoot: repository(),
      externalHandler: () => ({ status: "done", optionalDetail: undefined, attempts: [1, undefined, 3] }),
    });

    expect(result).toMatchObject({
      status: "completed",
      output: { status: "done", attempts: [1, null, 3] },
    });
    expect(result.output).not.toHaveProperty("optionalDetail");
  });

  it("propagates cooperative cancellation to a running target", async () => {
    const controller = new AbortController();
    let targetObservedCancellation = false;
    const pending = invokeTarget({
      descriptor: {
        id: "cancelled-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 1_000,
      },
      invocation: invocation(),
      repositoryRoot: repository(),
      signal: controller.signal,
      externalHandler: (_request, context) => {
        queueMicrotask(() => controller.abort());
        return new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              targetObservedCancellation = true;
              resolve({ stopped: true });
            },
            { once: true },
          );
        });
      },
    });

    const result = await pending;

    expect(targetObservedCancellation).toBe(true);
    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "target.CANCELLED" },
    });
  });

  it("fails safely for remote endpoints, missing handlers, timeouts, malformed output, and escaped modules", async () => {
    const root = repository();
    const outside = repository();
    writeFileSync(join(outside, "agent.mjs"), "export default () => ({ escaped: true });\n");
    symlinkSync(join(outside, "agent.mjs"), join(root, "escaped.mjs"));
    writeFileSync(
      join(root, "slow.mjs"),
      'process.stderr.write("waiting for model response\\n"); setInterval(() => {}, 1000);\n',
    );
    writeFileSync(join(root, "malformed.mjs"), 'process.stdout.write("not-json");\n');

    const remote = await invokeTarget({
      descriptor: {
        id: "remote-agent",
        kind: "http",
        bindings: ["http"],
        url: "https://agent.example.test/run",
        method: "POST",
        headersFromEnvironment: {},
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    const external = await invokeTarget({
      descriptor: {
        id: "missing-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    const timedOut = await invokeTarget({
      descriptor: {
        id: "slow-agent",
        kind: "command",
        bindings: ["http"],
        executable: process.execPath,
        arguments: ["slow.mjs"],
        environmentFromHost: {},
        timeoutMs: 30,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    const malformed = await invokeTarget({
      descriptor: {
        id: "malformed-agent",
        kind: "command",
        bindings: ["http"],
        executable: process.execPath,
        arguments: ["malformed.mjs"],
        environmentFromHost: {},
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidCallback = await invokeTarget({
      descriptor: {
        id: "invalid-callback-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
      externalHandler: () => cyclic,
    });
    const thrownCallback = await invokeTarget({
      descriptor: {
        id: "throwing-callback-agent",
        kind: "external",
        bindings: ["http"],
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
      externalHandler: () => {
        throw new Error("provider rejected request\u0007; check the local model configuration");
      },
    });
    const escaped = await invokeTarget({
      descriptor: {
        id: "escaped-agent",
        kind: "module",
        bindings: ["http"],
        module: "escaped.mjs",
        export: "default",
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });
    const missing = await invokeTarget({
      descriptor: {
        id: "missing-module-agent",
        kind: "module",
        bindings: ["http"],
        module: "firedrill/missing-agent.ts",
        export: "default",
        timeoutMs: 100,
      },
      invocation: invocation(),
      repositoryRoot: root,
    });

    expect(remote).toMatchObject({ status: "failed", error: { code: "target.REMOTE_HTTP_FORBIDDEN" } });
    expect(external).toMatchObject({
      status: "failed",
      error: { code: "target.EXTERNAL_HANDLER_REQUIRED" },
    });
    expect(timedOut).toMatchObject({
      status: "timed_out",
      error: { code: "target.TIMEOUT", details: { timeoutMs: 30, clock: "wall" } },
      attachments: [
        {
          kind: "process.stderr",
          text: "waiting for model response\n",
          truncated: false,
        },
      ],
    });
    expect(malformed).toMatchObject({
      status: "failed",
      error: { code: "target.INVALID_OUTPUT" },
    });
    expect(invalidCallback).toMatchObject({
      status: "failed",
      error: { code: "target.INVALID_OUTPUT" },
    });
    expect(thrownCallback).toMatchObject({
      status: "failed",
      error: {
        code: "target.EXECUTION_FAILED",
        message: "target execution failed: provider rejected request ; check the local model configuration",
        details: { errorName: "Error" },
      },
    });
    expect(escaped).toMatchObject({
      status: "failed",
      error: { code: "target.PATH_OUTSIDE_REPOSITORY" },
    });
    expect(missing).toMatchObject({
      status: "failed",
      error: {
        code: "target.PATH_NOT_FOUND",
        message: "target module firedrill/missing-agent.ts does not exist",
        details: { path: "firedrill/missing-agent.ts", purpose: "target module" },
      },
    });
  });
});
