import type { SimulationTool } from "../types";
import "./tool-interfaces.css";

/** These are available operation adapters, not a claim about an agent's live connection. */
export function ToolInterfaces({ tool }: { readonly tool: SimulationTool }) {
  if (tool.operations.length === 0) {
    return (
      <section className="fd-tool-interfaces" aria-label="Available interfaces">
        <p>No callable operations declared.</p>
      </section>
    );
  }
  return (
    <section className="fd-tool-interfaces" aria-label="Available interfaces">
      <div className="fd-tool-interfaces__row">
        <span className="fd-tool-interfaces__label">Available interfaces</span>
        <ul aria-label="Tool interfaces">
          <li>MCP</li>
          <li>HTTP API</li>
          <li>Firedrill CLI</li>
          <li>Direct function</li>
        </ul>
        {tool.httpRoutes.length > 0 ? (
          <span className="fd-tool-interfaces__routes">
            {tool.httpRoutes.length} declared HTTP {tool.httpRoutes.length === 1 ? "route" : "routes"}
          </span>
        ) : null}
      </div>
      <p>Enabled by your agent’s connection settings and permissions.</p>
    </section>
  );
}
