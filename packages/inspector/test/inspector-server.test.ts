import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalInspectorServer } from "../src/server.js";
import { startLocalInspectorWithAssets } from "../src/server.js";

const directories: string[] = [];
const servers: LocalInspectorServer[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function repository(): string {
  const root = temporary("firedrill-inspector-world-");
  const quickstart = resolve(import.meta.dirname, "../../../examples/quickstart");
  cpSync(join(quickstart, "firedrill.json"), join(root, "firedrill.json"));
  cpSync(join(quickstart, "firedrill"), join(root, "firedrill"), { recursive: true });
  cpSync(join(quickstart, "agent.mjs"), join(root, "agent.mjs"));
  return root;
}

function assets(): string {
  const root = temporary("firedrill-inspector-assets-");
  mkdirSync(join(root, "assets"));
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><meta name="firedrill-token" content="__FIREDRILL_TOKEN__"><script src="/assets/app.js"></script>',
  );
  writeFileSync(join(root, "assets", "app.js"), 'document.body.textContent = "ready";\n');
  writeFileSync(join(root, "ignored.txt"), "must not be served\n");
  return root;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local inspector server", () => {
  it("serves fixed offline assets and the authenticated simulation API from one loopback origin", async () => {
    const token = "inspector-test-token-00000001";
    const server = await startLocalInspectorWithAssets({
      root: repository(),
      assetDirectory: assets(),
      token,
    });
    servers.push(server);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await page.text();
    expect(html).toContain(`content="${token}"`);
    expect(html).not.toContain("__FIREDRILL_TOKEN__");

    const route = await fetch(`${server.url}/runs`);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(html);

    const script = await fetch(`${server.url}/assets/app.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toContain("ready");

    const head = await fetch(`${server.url}/assets/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const project = await fetch(`${server.url}/api/v1/project`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({ world: { id: "quickstart-world" } });

    const unauthorized = await fetch(`${server.url}/api/v1/project`);
    expect(unauthorized.status).toBe(401);
    const foreign = await fetch(server.url, { headers: { origin: "https://outside.test" } });
    expect(foreign.status).toBe(421);

    expect((await fetch(`${server.url}/ignored.txt`)).status).toBe(404);
    expect((await fetch(`${server.url}/missing`)).status).toBe(404);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(404);
  });

  it("fails before listening when packaged assets are incomplete", async () => {
    const assetDirectory = temporary("firedrill-inspector-invalid-");
    writeFileSync(join(assetDirectory, "index.html"), "<!doctype html><p>missing token</p>");
    await expect(startLocalInspectorWithAssets({ root: repository(), assetDirectory })).rejects.toThrow(
      /token placeholder/,
    );
  });
});
