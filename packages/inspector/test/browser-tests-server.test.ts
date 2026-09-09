import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserTestRequestStatus, createBrowserTestRequestHandler } from "../src/browser-tests.js";

const token = "firedrill-browser-inspector-test-token";
const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];
const roots: string[] = [];
async function bind(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-inspector-"));
  roots.push(root);
  const handler = createBrowserTestRequestHandler(root, token);
  cleanups.push(() => handler.close());
  const url = await bind(
    createServer(async (request, response) => {
      if (!(await handler.handle(request, response))) {
        response.writeHead(404);
        response.end();
      }
    }),
  );
  const request = (path: string, body?: unknown, auth = true, extra: Record<string, string> = {}) =>
    fetch(`${url}/api/browser-tests${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, url, request, handler };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("optional browser inspector", () => {
  it("requires its token and exact loopback origin; rejects unknown fields and implicit model spend", async () => {
    const f = await fixture();
    expect((await f.request("", undefined, false)).status).toBe(401);
    expect((await f.request("", undefined, true, { origin: "https://untrusted.example" })).status).toBe(421);
    const available = (await (await f.request("")).json()) as { available: boolean };
    expect(available.available).toBe(true);
    expect(
      (
        await f.request("/requests", {
          definition: { schemaVersion: 1, id: "x", startUrl: "http://localhost:3000" },
          apiKey: "not-accepted",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/requests", {
          definition: { schemaVersion: 1, id: "x", startUrl: "http://localhost:3000", task: "Click save" },
          useAgent: true,
        })
      ).status,
    ).toBe(400);
    expect((await f.request("/requests", { path: "../../.env" })).status).toBe(400);
    expect((await f.request("/saved?limit=101")).status).toBe(400);
    expect(
      (await f.request("/reports/browser_00000000000000000000000000000000/artifacts/../../.env")).status,
    ).not.toBe(200);
  });
  it("runs an actual browser, saves recorded source, verifies history/detail/artifacts, and detects tampering", async () => {
    const f = await fixture();
    let clicks = 0;
    const app = await bind(
      createServer((request, response) => {
        if (request.url === "/clicked") {
          clicks++;
          response.end("ok");
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(
          "<button onclick=\"fetch('/clicked').then(()=>document.querySelector('output').textContent='Done')\">Submit</button><output>Ready</output>",
        );
      }),
    );
    const definition = {
      schemaVersion: 1,
      id: "submit",
      startUrl: app,
      steps: [{ action: "click", selector: { by: "role", role: "button", name: "Submit" } }],
      assertions: [{ id: "done", kind: "text", selector: { by: "css", value: "output" }, expected: "Done" }],
    };
    const started = await f.request("/requests", { definition, capture: { screenshot: "always" } });
    expect(started.status).toBe(202);
    const { requestId } = (await started.json()) as { requestId: string };
    let status: BrowserTestRequestStatus | undefined;
    await expect
      .poll(
        async () => {
          status = (await (await f.request(`/requests/${requestId}`)).json()) as BrowserTestRequestStatus;
          return status.status;
        },
        { timeout: 15000 },
      )
      .toBe("finished");
    if (!status?.result) throw new Error("No completed browser result");
    expect(status.result.status).toBe("passed");
    expect(clicks).toBe(1);
    expect(status.events.some((event: { type: string }) => event.type === "step")).toBe(true);
    const saved = await f.request(`/requests/${requestId}/save`, { id: "saved-submit" });
    expect(saved.status).toBe(201);
    const savedList = (await (await f.request("/saved?limit=1")).json()) as {
      items: { definition: { id: string } }[];
    };
    expect(savedList.items[0]?.definition.id).toBe("saved-submit");
    const history = (await (await f.request("/reports")).json()) as { items: { runId: string }[] };
    expect(history.items[0]?.runId).toBe(status.result.runId);
    const detail = await f.request(`/reports/${status.result.runId}`);
    expect(detail.status).toBe(200);
    expect((await f.request(`/reports/${status.result.runId}/save`, { id: "history-submit" })).status).toBe(
      201,
    );
    const bundle = await f.request(`/reports/${status.result.runId}/bundle`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("application/gzip");
    expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const image = await f.request(`/reports/${status.result.runId}/artifacts/screenshot.png`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const report = join(f.root, ".firedrill", "browser", status.result.runId, "index.html");
    writeFileSync(report, `${readFileSync(report, "utf8")}tamper`);
    expect((await f.request(`/reports/${status.result.runId}`)).status).toBe(404);
    const changed = (await (await f.request("/reports")).json()) as {
      items: unknown[];
      diagnostics: unknown[];
    };
    expect(changed.items).toHaveLength(0);
    expect(changed.diagnostics).toHaveLength(1);
  }, 20000);
  it("enforces one live request, cancellation and shutdown", async () => {
    const f = await fixture();
    const app = await bind(createServer((_request, response) => response.end("<p>Ready</p>")));
    const input = {
      definition: {
        schemaVersion: 1,
        id: "waiting",
        startUrl: app,
        steps: [{ action: "wait", milliseconds: 10000 }],
      },
      capture: { screenshot: "off" },
    };
    const started = (await (await f.request("/requests", input)).json()) as { requestId: string };
    expect((await f.request("/requests", input)).status).toBe(409);
    expect((await f.request(`/requests/${started.requestId}/cancel`, {})).status).toBe(202);
    await expect
      .poll(
        async () =>
          ((await (await f.request(`/requests/${started.requestId}`)).json()) as BrowserTestRequestStatus)
            .status,
        {
          timeout: 10000,
        },
      )
      .toBe("finished");
    expect(
      ((await (await f.request(`/requests/${started.requestId}`)).json()) as BrowserTestRequestStatus).result
        ?.status,
    ).toBe("cancelled");
    await f.handler.close();
    expect((await f.request("")).status).toBe(503);
  }, 15000);
});
