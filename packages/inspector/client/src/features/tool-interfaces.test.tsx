import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SimulationTool } from "../types";
import { ToolInterfaces } from "./tool-interfaces";
import { ToolMain } from "./world";

const tool: SimulationTool = {
  id: "records",
  version: "1.0.0",
  operations: [{ id: "read", fidelity: "contract", idempotency: "none" }],
  stateNamespaces: [],
  events: [],
  faults: [],
  httpRoutes: [],
};

describe("Tool interface labels", () => {
  it("shows available adapters, including generic HTTP without custom routes", () => {
    const markup = renderToStaticMarkup(<ToolInterfaces tool={tool} />);
    for (const label of ["MCP", "HTTP API", "Firedrill CLI", "Direct function"])
      expect(markup).toContain(`<li>${label}</li>`);
    expect(markup).toContain("Available interfaces");
    expect(markup).toContain("connection settings and permissions");
    expect(markup).not.toContain("declared HTTP");
    expect(markup).not.toContain("Connected");
    expect(markup).not.toContain("<button");
  });

  it("counts declared routes without claiming they are active or used", () => {
    const route = { id: "read", operationId: "read", method: "GET" as const, path: "/records/:id" };
    const markup = renderToStaticMarkup(<ToolInterfaces tool={{ ...tool, httpRoutes: [route] }} />);
    expect(markup).toContain("1 declared HTTP route");
    expect(markup).not.toContain("1 declared HTTP routes");
    const multiple = renderToStaticMarkup(
      <ToolInterfaces
        tool={{ ...tool, httpRoutes: [route, { ...route, id: "alias", path: "/lookup/:id" }] }}
      />,
    );
    expect(multiple).toContain("2 declared HTTP routes");
  });

  it("does not infer interfaces from names, events, or a route on a non-callable catalog entry", () => {
    const markup = renderToStaticMarkup(
      <ToolInterfaces
        tool={{ ...tool, id: "mcp-cli-http-filesystem", operations: [], events: ["delivered"] }}
      />,
    );
    expect(markup).toContain("No callable operations declared.");
    expect(markup).not.toContain("<li>");
  });

  it("keeps interfaces visible in the main workspace without opening Details", () => {
    const markup = renderToStaticMarkup(<ToolMain tool={tool} />);
    expect(markup).toContain('aria-label="Available interfaces"');
    expect(markup).toContain('aria-label="Tool interfaces"');
    expect(markup.indexOf('aria-label="Available interfaces"')).toBeLessThan(markup.indexOf("<table"));
    expect(markup).not.toMatch(/<dialog\b[^>]*\bopen(?:=|\s|>)/);
  });
});
