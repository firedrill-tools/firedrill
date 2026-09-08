import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectorApi } from "../api";
import type { RunningEnvironment } from "../environment-types";
import { readInspectorLocation, readToolSelection, toolHref } from "../navigation";
import type { SimulationProject, SimulationTool } from "../types";
import {
  ConnectionEndpoint,
  ConnectionSetup,
  connectionMcpOptions,
  connectionShell,
} from "./connection-setup";
import {
  ConnectAgentView,
  EnvironmentBanner,
  type EnvironmentControls,
  EnvironmentUnavailable,
  ResetEnvironmentDialog,
  TestTool,
  toolCallInput,
} from "./environment";
import { ToolsView } from "./tools";

const tool: SimulationTool = {
  id: "observatory",
  version: "1.0.0",
  operations: [
    {
      id: "observe",
      description: "Record a measured reading.",
      fidelity: "stateful",
      idempotency: "none",
      inputSchema: { type: "object" },
    },
  ],
  stateNamespaces: ["readings"],
  events: [],
  faults: [],
  httpRoutes: [],
};
const project: SimulationProject = {
  schemaVersion: 1,
  world: {
    id: "night-watch",
    buildHash: `sha256:${"a".repeat(64)}`,
    packageLockHash: `sha256:${"b".repeat(64)}`,
    seed: "1",
    baseline: { virtualTimeUs: 0, actors: [], state: [], faults: [], initialEvents: [] },
  },
  tools: [tool],
  scenarios: [],
  targets: [],
  drills: [],
  suites: [],
  diagnostics: [],
};
const runtime: RunningEnvironment = {
  schemaVersion: 1,
  available: true,
  source: "live_environment",
  agentTested: false,
  metadata: {
    worldInstanceId: "world_night_watch_001",
    buildHash: project.world.buildHash,
    seed: "1",
    virtualTimeUs: 0,
  },
  description: {
    generation: 0,
    worldId: project.world.id,
    buildHash: project.world.buildHash,
    tools: [
      {
        packageId: tool.id,
        version: tool.version,
        operations: ["observe"],
        operationContracts: tool.operations,
        stateNamespaces: tool.stateNamespaces,
      },
    ],
    actors: [{ actorId: "reader", attributes: {}, grants: [] }],
  },
  connections: [{ protocol: "mcp", url: "http://127.0.0.1:4000/mcp", actorId: "reader" }],
};
function controls(status: EnvironmentControls["status"] = runtime, error?: string): EnvironmentControls {
  return { status, error, refreshing: false, refresh: async () => undefined };
}

describe("tool-first local inspector", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lands on tools and preserves exact deep-linked tool selection", () => {
    expect(readInspectorLocation({ pathname: "/", search: "" })).toEqual({ route: "/tools", search: "" });
    expect(
      readToolSelection(new URL(toolHref("private/observatory", "test"), "http://localhost").search),
    ).toEqual({ id: "private/observatory", tab: "test" });
    expect(readToolSelection("?tool=first&tool=second").id).toBe("");
    expect(readInspectorLocation({ pathname: "/connect", search: "" }).route).toBe("/connect");
  });

  it("renders a navigable paginated tool directory, not a seven-step checklist", () => {
    const many = {
      ...project,
      tools: Array.from({ length: 30 }, (_, index) => ({ ...tool, id: `instrument-${index}` })),
    };
    const markup = renderToStaticMarkup(
      <ToolsView
        project={many}
        selection={{ id: undefined, tab: "behavior" }}
        onVisit={() => undefined}
        testTool={() => null}
      />,
    );
    expect(markup).toContain("Connect agent");
    expect(markup).toContain("instrument-11");
    expect(markup).not.toContain("instrument-12");
    expect(markup).toContain('aria-label="Next tools"');
    expect(markup).not.toContain("Step 1");
    expect(markup).not.toContain("Run drill");
  });

  it("never substitutes another tool for an unavailable link", () => {
    const markup = renderToStaticMarkup(
      <ToolsView
        project={project}
        selection={{ id: "removed", tab: "test" }}
        onVisit={() => undefined}
        testTool={() => <span>Unexpected test form</span>}
      />,
    );
    expect(markup).toContain("This tool is not in the current source");
    expect(markup).not.toContain("Unexpected test form");
  });

  it("does not represent source-only setup or failed status as a ready environment", () => {
    const absent = renderToStaticMarkup(
      <EnvironmentBanner
        environment={controls({ schemaVersion: 1, available: false })}
        onVisit={() => undefined}
      />,
    );
    expect(absent).toContain("No environment running");
    expect(absent).not.toContain("Local environment running");
    const failed = renderToStaticMarkup(
      <EnvironmentBanner environment={controls(runtime, "Listener unavailable")} onVisit={() => undefined} />,
    );
    expect(failed).toContain("Last known state is not current confirmation");
    expect(failed).not.toContain("Local environment running");
    const instructions = renderToStaticMarkup(<EnvironmentUnavailable project={project} />);
    expect(instructions).toContain("firedrill serve");
    expect(instructions).not.toContain("--world");
    expect(instructions).toContain("does not start your agent or load an example");
  });

  it("labels calls as operator tool tests, preserves actor scope and exposes denied grants", () => {
    const markup = renderToStaticMarkup(
      <TestTool tool={tool} project={project} environment={controls()} onVisit={() => undefined} />,
    );
    expect(markup).toContain("does not invoke or test your agent");
    expect(markup).toContain("world_night_watch_001");
    expect(markup).toContain("This actor has no grant");
    expect(markup).toContain('aria-label="Tool call actor"');
    expect(markup).toContain("Test tool");
    expect(markup).not.toContain("Agent passed");
  });

  it("uses live operations instead of current source when their immutable builds differ", () => {
    const changed: RunningEnvironment = {
      ...runtime,
      description: {
        ...runtime.description,
        buildHash: `sha256:${"c".repeat(64)}`,
        tools: [
          {
            packageId: tool.id,
            version: tool.version,
            operations: ["live-only-operation"],
            stateNamespaces: tool.stateNamespaces,
            operationContracts: [{ id: "live-only-operation", fidelity: "stateful", idempotency: "none" }],
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <TestTool tool={tool} project={project} environment={controls(changed)} onVisit={() => undefined} />,
    );
    expect(markup).toContain("running build differs from current source");
    expect(markup).toContain('value="live-only-operation"');
    expect(markup).not.toContain('value="observe"');
  });

  it("keeps connection credentials behind an explicit reveal and makes no agent claim", () => {
    const markup = renderToStaticMarkup(
      <ConnectAgentView project={project} environment={controls()} onVisit={() => undefined} />,
    );
    expect(markup).toContain("Reveal connection values");
    expect(markup).toContain("http://127.0.0.1:4000/mcp");
    expect(markup).toContain("Run a task in your agent");
    expect(markup).not.toContain("Open live activity");
    expect(markup).not.toContain("Live connection values · keep private");
  });

  it("renders only the selected protocol endpoint without a narrow URL table", () => {
    const allProtocols: RunningEnvironment = {
      ...runtime,
      connections: [
        { protocol: "http", url: "http://127.0.0.1:4100", actorId: "reader" },
        ...runtime.connections,
        { protocol: "cli", url: "http://127.0.0.1:4200", actorId: "reader" },
      ],
    };
    const markup = renderToStaticMarkup(
      <ConnectAgentView project={project} environment={controls(allProtocols)} onVisit={() => undefined} />,
    );
    expect(markup).toContain('aria-label="Connection protocol"');
    expect(markup).toContain('aria-pressed="true">HTTP');
    expect(markup).toContain("http://127.0.0.1:4100");
    expect(markup).not.toContain("http://127.0.0.1:4000/mcp");
    expect(markup).not.toContain("http://127.0.0.1:4200");
    const endpoint = renderToStaticMarkup(
      <ConnectionEndpoint
        connection={{ protocol: "http", url: "http://127.0.0.1:4100", actorId: "reader" }}
      />,
    );
    expect(endpoint).toContain("fd-connection-endpoint__scroll");
    expect(endpoint).toContain('tabindex="0"');
    expect(endpoint).not.toContain("<table");
  });

  it.each(["http", "mcp", "cli"] as const)(
    "produces two copyable %s exports without the control envelope or other credentials",
    (protocol) => {
      const connection = { protocol, url: "http://127.0.0.1:4100", token: "live-token", actorId: "reader" };
      expect(connectionShell(connection)).toBe(
        `export FIREDRILL_${protocol.toUpperCase()}_URL='http://127.0.0.1:4100'\nexport FIREDRILL_${protocol.toUpperCase()}_TOKEN='live-token'`,
      );
      const markup = renderToStaticMarkup(<ConnectionSetup connection={connection} />);
      expect(markup).toContain(`${protocol.toUpperCase()} shell exports`);
      expect(markup).not.toContain("schemaVersion");
      expect(markup).not.toContain("worldInstanceId");
      expect(markup).not.toContain("generation");
      expect(markup).not.toContain("actorId");
      if (protocol === "mcp") expect(markup).toContain("Claude Agent SDK");
      else expect(markup).not.toContain("Claude Agent SDK");
    },
  );

  it("quotes shell metacharacters literally and emits grounded MCP SDK options only for MCP", () => {
    const mcp = {
      protocol: "mcp" as const,
      url: "http://127.0.0.1:4100/mcp",
      token: "secret'$(echo unsafe)",
      actorId: "reader",
    };
    expect(connectionShell(mcp)).toContain("'secret'\\''$(echo unsafe)'");
    expect(JSON.parse(connectionMcpOptions(mcp))).toEqual({
      mcpServers: {
        firedrill: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
      },
    });
    expect(() => connectionMcpOptions({ ...mcp, protocol: "http" })).toThrow("MCP connection");
  });

  it("omits an unauthored tool description and uses singular operation/table counts", () => {
    const definitions = {
      ...project,
      tools: [
        {
          ...tool,
          operations: [{ id: "observe", fidelity: "stateful" as const, idempotency: "none" as const }],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ToolsView
        project={definitions}
        selection={{ id: undefined, tab: "behavior" }}
        onVisit={() => undefined}
        testTool={() => null}
      />,
    );
    expect(markup).toContain("1 operation");
    expect(markup).toContain("1 state table");
    expect(markup).not.toContain("1 operations");
    expect(markup).not.toContain("1 state tables");
    expect(markup).not.toContain("Behavior defined by");
  });

  it("requires exact typed reset confirmation and states the journal consequence", () => {
    const markup = renderToStaticMarkup(
      <ResetEnvironmentDialog runtime={runtime} onReset={async () => undefined} />,
    );
    expect(markup).toContain("All current state changes and activity return to the starting baseline");
    expect(markup).toContain("world_night_watch_001");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Reset entire environment<\/button>/);
    expect(markup).toContain('aria-label="Environment ID confirmation"');
  });

  it("rejects malformed manual calls before any mutation request", () => {
    expect(() => toolCallInput("", tool.id, "observe", "{}", "")).toThrow("Choose an actor");
    expect(() => toolCallInput("reader", tool.id, "observe", "{broken}", "")).toThrow("valid JSON");
    for (const input of ["[]", "null", "2", '"text"'])
      expect(() => toolCallInput("reader", tool.id, "observe", input, "")).toThrow("JSON object");
    expect(toolCallInput("reader", tool.id, "observe", '{"reading":7}', "repeat-1")).toEqual({
      actorId: "reader",
      packageId: tool.id,
      operationId: "observe",
      arguments: { reading: 7 },
      idempotencyKey: "repeat-1",
    });
  });

  it("sends authenticated generation-bound reads, exact operator calls, and typed reset identity", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("document", { querySelector: () => ({ content: "local-test-token" }) });
    await inspectorApi.environmentState("private/tool", "readings", 3, "row / 4");
    await inspectorApi.environmentActivity(3, 51);
    await inspectorApi.callEnvironmentTool(toolCallInput("reader", tool.id, "observe", '{"reading":7}', ""));
    await inspectorApi.resetEnvironment(runtime.metadata.worldInstanceId);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toContain("generation=3");
    expect(calls[0]?.[0]).toContain("afterRowId=row+%2F+4");
    expect(calls[1]?.[0]).toContain("fromSequence=51");
    expect(JSON.parse(String(calls[2]?.[1].body))).toEqual({
      actorId: "reader",
      packageId: tool.id,
      operationId: "observe",
      arguments: { reading: 7 },
    });
    expect(JSON.parse(String(calls[3]?.[1].body))).toEqual({
      worldInstanceId: runtime.metadata.worldInstanceId,
    });
    expect(
      calls.every(
        ([, init]) => (init.headers as Record<string, string>).authorization === "Bearer local-test-token",
      ),
    ).toBe(true);
  });
});
