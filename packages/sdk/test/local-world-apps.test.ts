import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalWorld,
  FiredrillProjectError,
  type LocalWorldApp,
  type LocalWorldBinding,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(withUi = true) {
  const root = mkdtempSync(join(tmpdir(), "firedrill-local-apps-"));
  roots.push(root);
  mkdirSync(join(root, "world"));
  writeFileSync(
    join(root, "firedrill.json"),
    JSON.stringify({ schemaVersion: 1, sourceRoot: "world", world: "world.json" }),
  );
  const packages = ["records", "inventory", "headless"];
  writeFileSync(
    join(root, "world/world.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "apps-world",
      actors: [
        {
          id: "operator",
          grants: packages.flatMap((packageId) =>
            ["read", "write"].map((operationId) => ({ packageId, operationId })),
          ),
        },
      ],
      state: packages.map((packageId) => ({
        action: "upsert",
        packageId,
        namespace: "items",
        rowId: "main",
        value: { count: 7 },
      })),
    }),
  );
  const output = {
    type: "object",
    required: ["count"],
    properties: { count: { type: "integer" } },
    additionalProperties: false,
  };
  for (const packageId of packages) {
    const ui = withUi && packageId !== "headless";
    writeFileSync(
      join(root, `world/${packageId}.tool.json`),
      JSON.stringify({
        schemaVersion: 1,
        module: `./${packageId}.js`,
        ...(ui ? { ui: { root: `${packageId}-ui` } } : {}),
        manifest: {
          schemaVersion: 1,
          id: packageId,
          version: "1.0.0",
          engine: ">=0.1.0",
          capabilities: ["state.read", "state.write"],
          state: [{ namespace: "items", schema: output }],
          operations: [
            {
              id: "read",
              inputSchema: { type: "object", additionalProperties: false },
              outputSchema: output,
              idempotency: "none",
              fidelity: "stateful",
            },
            ...["write", "admin"].map((id) => ({
              id,
              inputSchema: output,
              outputSchema: output,
              idempotency: "required",
              fidelity: "stateful",
            })),
          ],
        },
      }),
    );
    writeFileSync(
      join(root, `world/${packageId}.js`),
      'const write = (input, context) => { context.state.put("items", "main", input); return input; }; export default { operations: { read: (_input, context) => context.state.get("items", "main"), write, admin: write } };',
    );
    if (ui) {
      mkdirSync(join(root, `world/${packageId}-ui`));
      writeFileSync(
        join(root, `world/${packageId}-ui/index.html`),
        `<!doctype html><title>${packageId}</title><script type="module" src="app.js"></script>`,
      );
      writeFileSync(
        join(root, `world/${packageId}-ui/app.js`),
        'import { getContext, invoke } from "/_firedrill/client.js"; document.body.textContent = (await getContext()).packageId;',
      );
    }
  }
  return root;
}

function connection(app: LocalWorldApp) {
  const url = new URL(app.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("App token missing");
  return { origin: url.origin, token, headers: { authorization: `Bearer ${token}`, origin: url.origin } };
}

function requiredApp(binding: LocalWorldBinding, packageId: string): LocalWorldApp {
  const app = binding.apps.find((value) => value.packageId === packageId);
  if (app === undefined) throw new Error(`App missing for ${packageId}`);
  return app;
}

async function localWorld(root: string) {
  try {
    return await createLocalWorld({ root });
  } catch (error) {
    if (error instanceof FiredrillProjectError)
      throw new Error(JSON.stringify({ code: error.code, diagnostics: error.diagnostics }), { cause: error });
    throw error;
  }
}
async function context(app: LocalWorldApp) {
  const endpoint = connection(app);
  const result = await fetch(`${endpoint.origin}/_firedrill/context`, { headers: endpoint.headers });
  expect(result.status).toBe(200);
  return (await result.json()) as {
    revision: { generation: number; evidenceSequence: number };
    packageId: string;
    actorId: string;
    worldInstanceId: string;
  };
}
async function invoke(
  app: LocalWorldApp,
  operationId: string,
  arguments_: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  const endpoint = connection(app);
  const response = await fetch(`${endpoint.origin}/_firedrill/invoke`, {
    method: "POST",
    headers: { ...endpoint.headers, "content-type": "application/json" },
    body: JSON.stringify({
      operationId,
      arguments: arguments_,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  });
  return { status: response.status, body: await response.json() };
}

describe("standalone immutable Tool apps", () => {
  it("automatically serves only declared UIs even with MCP-only, shares real actor-bound state, and detects changes without journaling context reads", async () => {
    const root = repository();
    const world = await localWorld(root);
    const binding = await world.listen({ protocols: ["mcp"] });
    const client = new Client({ name: "app-contract-client", version: "1.0.0" });
    try {
      expect(binding.http).toBeUndefined();
      expect(binding.cli).toBeUndefined();
      expect(binding.apps.map((app) => app.packageId)).toEqual(
        ["headless", "inventory", "records"].filter((id) => id !== "headless"),
      );
      expect(Object.isFrozen(binding.apps)).toBe(true);
      const app = requiredApp(binding, "records");
      const other = requiredApp(binding, "inventory");
      const mcp = binding.mcp;
      if (mcp === undefined) throw new Error("Missing MCP binding");
      expect(new URL(app.url).origin).not.toBe(new URL(other.url).origin);
      expect(connection(app).token).not.toBe(mcp.token);
      expect(connection(app).token).not.toBe(connection(other).token);
      expect(Object.values(binding.environment).join(" ")).not.toContain(connection(app).token);
      const before = await context(app);
      expect(before).toMatchObject({
        packageId: "records",
        actorId: "operator",
        worldInstanceId: world.metadata().worldInstanceId,
        revision: { generation: 0 },
      });
      const evidence = world.evidence();
      expect(await context(app)).toEqual(before);
      expect(world.evidence()).toEqual(evidence);
      await invoke(app, "read");
      await invoke(other, "read");
      expect(world.evidence().length).toBeGreaterThan(evidence.length);
      expect(await context(app)).toEqual(before); // Two app windows cannot trigger an endless read/refresh loop.
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp.url), {
          authProvider: { token: async () => mcp.token },
        }),
      );
      expect(
        (await client.callTool({ name: "records.write", arguments: { count: 11 } })).structuredContent,
      ).toEqual({ count: 11 });
      expect(await invoke(app, "read")).toMatchObject({ body: { outcome: { value: { count: 11 } } } });
      expect(await invoke(app, "write", { count: 12 }, "one-intent")).toMatchObject({
        status: 200,
        body: { outcome: { status: "ok", value: { count: 12 } } },
      });
      expect((await client.callTool({ name: "records.read", arguments: {} })).structuredContent).toEqual({
        count: 12,
      });
      expect(world.state({ packageId: "records", namespace: "items" })[0]?.value).toEqual({ count: 12 });
      expect(world.state({ packageId: "inventory", namespace: "items" })[0]?.value).toEqual({ count: 7 });
      expect((await context(app)).revision.evidenceSequence).toBeGreaterThan(
        before.revision.evidenceSequence,
      );
      expect(await invoke(app, "admin", { count: 99 }, "denied-intent")).toMatchObject({
        status: 403,
        body: { outcome: { status: "denied" } },
      });
      expect(await invoke(app, "write", { count: 99 }, "one-intent")).toMatchObject({
        status: 400,
        body: { outcome: { status: "invalid" } },
      });
      // Source edits after compilation never replace the bytes in a live app.
      writeFileSync(join(root, "world/records-ui/index.html"), "changed source only");
      expect(await (await fetch(app.url)).text()).toContain("<title>records</title>");
      expect(await (await fetch(`${connection(app).origin}/.env`)).text()).not.toContain(
        "changed source only",
      );
    } finally {
      await client.close();
      await binding.close();
      world.close();
    }
  });

  it("keeps app URLs through full/package resets, refreshes actor clients, and revokes all listeners on either close path", async () => {
    const world = await localWorld(repository());
    const binding = await world.listen({ protocols: ["http"] });
    const app = requiredApp(binding, "records");
    try {
      const initial = await context(app);
      for (const reset of [undefined, { packages: ["records"] }]) {
        expect(await invoke(app, "write", { count: 18 }, "same-after-reset")).toMatchObject({ status: 200 });
        world.reset(reset);
        expect((await context(app)).revision.generation).toBeGreaterThan(initial.revision.generation);
        expect(await invoke(app, "read")).toMatchObject({ body: { outcome: { value: { count: 7 } } } });
        expect(await invoke(app, "admin", { count: 99 }, "always-denied")).toMatchObject({ status: 403 });
      }
      const second = await world.listen({ protocols: ["mcp"] });
      const secondApp = requiredApp(second, "records");
      expect(secondApp.url).not.toBe(app.url);
      await binding.close();
      await binding.close();
      await expect(fetch(app.url)).rejects.toThrow();
      expect(await invoke(secondApp, "read")).toMatchObject({ status: 200 });
      world.close();
      await second.close();
      await expect(fetch(secondApp.url)).rejects.toThrow();
    } finally {
      await binding.close();
      world.close();
    }
  });

  it("preserves backend-only listeners and closes a pending UI startup with its world", async () => {
    const plain = await localWorld(repository(false));
    let binding: LocalWorldBinding | undefined;
    try {
      binding = await plain.listen();
      expect(binding.apps).toEqual([]);
    } finally {
      await binding?.close();
      plain.close();
    }
    const root = repository();
    // No actor override or synthetic privileged actor is introduced by apps.
    const path = join(root, "world/world.json");
    const source = JSON.parse(readFileSync(path, "utf8"));
    source.actors.push({ id: "reader", grants: [{ packageId: "records", operationId: "read" }] });
    writeFileSync(path, JSON.stringify(source));
    const world = await localWorld(root);
    await expect(world.listen()).rejects.toMatchObject({ code: "framework.INVALID_ARGUMENT" });
    const starting = world.listen({ actorId: "reader", protocols: ["mcp"] });
    world.close();
    await expect(starting).rejects.toMatchObject({ code: "framework.WORLD_CLOSED" });
  });
});
