import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorld } from "@firedrill/compiler";
import type { DataImportPlanInput } from "@firedrill/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalWorld,
  loadDataImportPlan,
  loadDataImportPreview,
  previewDataImport,
  saveDataImport,
  storeDataImportPreview,
} from "../src/index.js";

const directories: string[] = [];
const servers: Server[] = [];
function fixture(packageId = "records", namespace = "items", field = "count") {
  const root = mkdtempSync(join(tmpdir(), "firedrill-import-"));
  directories.push(root);
  mkdirSync(join(root, "world"));
  const json = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
  json("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  json("world/world.json", {
    schemaVersion: 1,
    id: "import-world",
    actors: [{ id: "worker", grants: [{ packageId, operationId: "put" }] }],
    state: [],
  });
  json("world/service.tool.json", {
    schemaVersion: 1,
    module: "./service.js",
    manifest: {
      schemaVersion: 1,
      id: packageId,
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read", "state.write"],
      state: [
        {
          namespace,
          schema: {
            type: "object",
            required: [field, "contact"],
            properties: {
              [field]: { type: "integer" },
              contact: { type: "string" },
              metadata: { type: "object" },
            },
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "put",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          idempotency: "none",
          fidelity: "stateful",
        },
      ],
    },
  });
  writeFileSync(
    join(root, "world/service.js"),
    `export default {operations:{put(input,context){context.state.put(${JSON.stringify(namespace)},input.id,input.value);return {};}}};`,
  );
  json("selected.json", [
    {
      id: "r1",
      amount: 7,
      email: "person@example.test",
      excluded: "never-selected",
      metadata: { token: "must-not-survive", label: "kept" },
    },
    { id: "r2", amount: 4, email: "other@example.test", metadata: {} },
  ]);
  const plan: DataImportPlanInput = {
    schemaVersion: 1,
    id: "imported",
    source: { kind: "json", path: "selected.json" },
    packageId,
    namespace,
    idPointer: "/id",
    fields: { [field]: "/amount", contact: "/email", metadata: "/metadata" },
    selectIds: ["r1"],
    redactions: [{ path: "/contact", replacement: "synthetic@example.test" }],
  };
  return { root, json, plan };
}
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("reviewed data import through the public SDK", () => {
  it.each([
    ["records", "items", "count"],
    ["warehouse", "stock", "available"],
    ["sensors", "readings", "temperature"],
  ])(
    "compiles, starts and resets imported %s state without a fixture-specific path",
    async (packageId, namespace, field) => {
      const { root, plan } = fixture(packageId, namespace, field);
      const live = await createLocalWorld({ root });
      try {
        const preview = await previewDataImport({ root, plan, consent: "read-selected-source" });
        expect(preview).toMatchObject({ recordCount: 1, redactedFields: 2, runtimeChanged: false });
        expect(JSON.stringify(preview)).not.toMatch(/must-not-survive|never-selected|person@example/);
        expect(existsSync(join(root, "world/scenarios"))).toBe(false);
        const stored = storeDataImportPreview(root, preview);
        expect(loadDataImportPreview(root, stored)).toEqual(preview);
        expect(storeDataImportPreview(root, preview)).toBe(stored);
        const saved = await saveDataImport({
          root,
          preview,
          expectedPreviewHash: preview.previewHash,
          confirm: "save-reviewed-data",
        });
        expect(saved.path).toBe("world/scenarios/imported.scenario.json");
        expect(live.state({ packageId, namespace })).toEqual([]);
        expect((await compileWorld({ repositoryRoot: root, materialize: false })).status).toBe("success");
        const imported = await createLocalWorld({ root, scenario: "imported" });
        try {
          const initial = imported.state({ packageId, namespace });
          expect(initial).toMatchObject([
            {
              rowId: "r1",
              value: {
                [field as string]: 7,
                contact: "synthetic@example.test",
                metadata: { token: "[REDACTED]", label: "kept" },
              },
            },
          ]);
          const call = imported.call({
            actorId: "worker",
            packageId,
            operationId: "put",
            arguments: { id: "r1", value: { [field as string]: 9, contact: "changed" } },
          });
          expect(call.outcome.status).toBe("ok");
          imported.reset();
          expect(imported.state({ packageId, namespace })).toEqual(initial);
        } finally {
          imported.close();
        }
        await expect(
          saveDataImport({
            root,
            preview,
            expectedPreviewHash: preview.previewHash,
            confirm: "save-reviewed-data",
          }),
        ).rejects.toThrow();
      } finally {
        live.close();
      }
    },
  );
  it("requires consent before HTTP reads, follows bounded same-origin pages, and never persists credentials", async () => {
    const { root, plan } = fixture();
    const requests: { path: string; authorization: string | undefined }[] = [];
    const origin = await serve((req, res) => {
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          rows: [
            {
              id: req.url === "/page2" ? "r2" : "r1",
              amount: 7,
              email: "private@example.test",
              metadata: { label: "value credential-12345" },
            },
          ],
          next: req.url === "/page2" ? null : "/page2",
        }),
      );
    });
    const httpPlan: DataImportPlanInput = {
      ...plan,
      selectIds: ["r1", "r2"],
      source: {
        kind: "http",
        url: `${origin}/page1`,
        headersFromEnvironment: { Authorization: "IMPORT_TOKEN" },
        pagination: { nextPointer: "/next" },
      },
      recordsPointer: "/rows",
    };
    await expect(
      previewDataImport({ root, plan: httpPlan, consent: undefined as never, allowedOrigin: origin }),
    ).rejects.toThrow("Approve");
    await expect(
      previewDataImport({
        root,
        plan: httpPlan,
        consent: "read-selected-source",
        environment: { IMPORT_TOKEN: "Bearer credential-12345" },
      }),
    ).rejects.toThrow("approved origin");
    expect(requests).toEqual([]);
    const preview = await previewDataImport({
      root,
      plan: httpPlan,
      consent: "read-selected-source",
      allowedOrigin: origin,
      environment: { IMPORT_TOKEN: "Bearer credential-12345" },
    });
    expect(preview).toMatchObject({ recordCount: 2, source: { pages: 2, recordsRead: 2 } });
    expect(requests).toEqual([
      { path: "/page1", authorization: "Bearer credential-12345" },
      { path: "/page2", authorization: "Bearer credential-12345" },
    ]);
    const path = storeDataImportPreview(root, preview);
    expect(readFileSync(join(root, path), "utf8")).not.toMatch(
      /credential-12345|private@example|127\.0\.0\.1/,
    );
    await saveDataImport({
      root,
      preview,
      expectedPreviewHash: preview.previewHash,
      confirm: "save-reviewed-data",
    });
    expect(requests).toHaveLength(2);
  });
  it("rejects redirects, cross-origin pagination, duplicate/missing ids, schema mismatch and partial limits", async () => {
    const { root, plan, json } = fixture();
    const common = { root, consent: "read-selected-source" as const };
    let mode = "redirect";
    const origin = await serve((_req, res) => {
      if (mode === "redirect") {
        res.writeHead(302, { location: "https://example.invalid/" });
        res.end();
        return;
      }
      res.end(JSON.stringify({ rows: [], next: "https://example.invalid/" }));
    });
    const httpPlan: DataImportPlanInput = {
      ...plan,
      source: { kind: "http", url: origin, pagination: { nextPointer: "/next" } },
      recordsPointer: "/rows",
    };
    await expect(previewDataImport({ ...common, plan: httpPlan, allowedOrigin: origin })).rejects.toThrow(
      "redirects",
    );
    mode = "cross-origin";
    await expect(previewDataImport({ ...common, plan: httpPlan, allowedOrigin: origin })).rejects.toThrow(
      "approved origin",
    );
    await expect(previewDataImport({ ...common, plan: { ...plan, maxRecords: 1 } })).rejects.toThrow(
      "maxRecords",
    );
    await expect(previewDataImport({ ...common, plan: { ...plan, selectIds: ["absent"] } })).rejects.toThrow(
      "No selected records",
    );
    json("selected.json", [{ id: "r1", amount: "bad", email: "x", metadata: {} }]);
    await expect(previewDataImport({ ...common, plan })).rejects.toThrow("Tool schema");
    json("selected.json", [
      { id: "r1", amount: 1, email: "x", metadata: {} },
      { id: "r1", amount: 2, email: "x", metadata: {} },
    ]);
    await expect(previewDataImport({ ...common, plan })).rejects.toThrow("duplicate");
    expect(existsSync(join(root, "world/scenarios"))).toBe(false);
  });
  it("rejects tampering, stale source, symlinks, secret files and cancellation without source writes", async () => {
    const { root, plan, json } = fixture();
    const preview = await previewDataImport({ root, plan, consent: "read-selected-source" });
    await expect(
      saveDataImport({
        root,
        preview: { ...preview, recordCount: 99 },
        expectedPreviewHash: preview.previewHash,
        confirm: "save-reviewed-data",
      }),
    ).rejects.toThrow("preview changed");
    symlinkSync(join(root, "selected.json"), join(root, "alias.json"));
    await expect(
      previewDataImport({
        root,
        plan: { ...plan, source: { kind: "json", path: "alias.json" } },
        consent: "read-selected-source",
      }),
    ).rejects.toThrow("real project");
    expect(() => loadDataImportPlan(root, ".env.local")).toThrow("Credential");
    json("bad-plan.json", { arbitrary: "x" });
    expect(() => loadDataImportPlan(root, "bad-plan.json")).toThrow("invalid");
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewDataImport({ root, plan, consent: "read-selected-source", signal: controller.signal }),
    ).rejects.toThrow();
    json("world/new.scenario.json", { schemaVersion: 1, id: "new" });
    await expect(
      saveDataImport({
        root,
        preview,
        expectedPreviewHash: preview.previewHash,
        confirm: "save-reviewed-data",
      }),
    ).rejects.toThrow("World source changed");
    expect(existsSync(join(root, "world/scenarios"))).toBe(false);
  });
});
