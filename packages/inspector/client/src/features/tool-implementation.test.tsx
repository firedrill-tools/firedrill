import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SimulationTool } from "../types";
import { ToolImplementation } from "./tool-implementation";
import { ToolMain } from "./world";

const hash = `sha256:${"a".repeat(64)}`;
const base: SimulationTool = {
  id: "archive",
  version: "1.0.0",
  operations: [],
  stateNamespaces: [],
  events: [],
  faults: [],
  httpRoutes: [],
};

describe("Tool implementation workspace", () => {
  it("exposes separate operations, implementation, and declaration views without opening a drawer", () => {
    const markup = renderToStaticMarkup(<ToolMain tool={base} />);
    expect(markup).toContain('aria-label="Tool views"');
    expect(markup).toContain(">Implementation</button>");
    expect(markup).toContain(">Declaration</button>");
    expect(markup).not.toContain("<dialog");
  });

  it("explains missing implementation rather than substituting a declaration as source", () => {
    const markup = renderToStaticMarkup(<ToolImplementation tool={base} />);
    expect(markup).toContain("Implementation source unavailable");
    expect(markup).toContain("The declaration alone does not contain its behavior.");
  });

  it("defaults to the compiler-proven entry module and retains helper selection", () => {
    const tool: SimulationTool = {
      ...base,
      implementation: {
        snapshot: "compiled_refresh",
        buildHash: hash,
        artifactHash: hash,
        exportName: "default",
        origin: { kind: "repository" },
        files: [
          {
            id: `file-${"a".repeat(64)}`,
            path: "helpers.ts",
            role: "helper",
            language: "typescript",
            readable: true,
            contentHash: hash,
          },
          {
            id: `file-${"b".repeat(64)}`,
            path: "entry.ts",
            role: "entry",
            language: "typescript",
            readable: false,
            unavailableReason: "missing_source",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(<ToolImplementation tool={tool} />);
    expect(markup).toContain('aria-label="Implementation file"');
    expect(markup).toContain('selected="">entry.ts (entry module)</option>');
    expect(markup).toContain("helpers.ts</option>");
    expect(markup).toContain("not a saved run");
    expect(markup).toContain("Restore it, then refresh source.");
    expect(markup).not.toContain("Loading implementation");
  });
});
