import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SimulationProjectSchema, SimulationToolSourceDocumentSchema } from "../src/contracts.js";
import { startLocalSimulationServer } from "../src/server.js";

it("serves captured implementation files through the authenticated public API and refreshes them explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "firedrill-tool-source-http-"));
  const example = resolve(import.meta.dirname, "../../../examples/quickstart");
  cpSync(join(example, "firedrill.json"), join(root, "firedrill.json"));
  cpSync(join(example, "firedrill"), join(root, "firedrill"), { recursive: true });
  cpSync(join(example, "agent.mjs"), join(root, "agent.mjs"));
  const server = await startLocalSimulationServer({ root });
  const headers = { authorization: `Bearer ${server.token}` };
  try {
    const project = SimulationProjectSchema.parse(
      await (await fetch(`${server.baseUrl}/api/v1/project`, { headers })).json(),
    );
    const tool = project.tools[0];
    const file = tool?.implementation?.files.find((item) => item.role === "entry");
    expect(tool?.definition?.operations).toHaveLength(tool?.operations.length ?? 0);
    if (tool === undefined || file === undefined) throw new Error("expected the compiled entry module");
    const path = `/api/v1/tools/${tool.id}/implementation/${file.id}`;
    expect((await fetch(`${server.baseUrl}${path}`)).status).toBe(401);
    const response = await fetch(`${server.baseUrl}${path}`, { headers });
    expect(response.status).toBe(200);
    const source = SimulationToolSourceDocumentSchema.parse(await response.json());
    const original = readFileSync(join(root, file.path), "utf8");
    expect(source.content).toBe(original);
    expect(source.contentHash).toBe(`sha256:${createHash("sha256").update(original).digest("hex")}`);
    expect(source.snapshot).toBe("compiled_refresh");
    expect(source.content).toContain("context.state.put");
    writeFileSync(join(root, file.path), `${original}\n// Source-only comment added after refresh.\n`);
    expect(
      SimulationToolSourceDocumentSchema.parse(
        await (await fetch(`${server.baseUrl}${path}`, { headers })).json(),
      ).content,
    ).toBe(original);
    expect(
      (await fetch(`${server.baseUrl}/api/v1/tools/${tool.id}/implementation/%2e%2e%2f.env`, { headers }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${server.baseUrl}/api/v1/tools/absent/implementation/${file.id}`, { headers })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${server.baseUrl}/api/v1/tools/${tool.id}/implementation/file-${"f".repeat(64)}`, {
          headers,
        })
      ).status,
    ).toBe(404);
    const refreshed = await fetch(`${server.baseUrl}/api/v1/project/refresh`, { method: "POST", headers });
    expect(refreshed.status).toBe(200);
    const updated = SimulationToolSourceDocumentSchema.parse(
      await (await fetch(`${server.baseUrl}${path}`, { headers })).json(),
    );
    expect(updated.content).toContain("Source-only comment added after refresh.");
    expect(updated.contentHash).not.toBe(source.contentHash);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
