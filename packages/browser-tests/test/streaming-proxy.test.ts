import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBrowserTest } from "../src/index.js";

const servers: Server[] = [];
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "firedrill-streaming-browser-"));
  roots.push(path);
  return path;
}
async function bind(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No listener");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("streaming browser origin proxy", () => {
  it("renders the first SSE event before the response finishes and follows an allowed redirect", async () => {
    let streamEnded = false;
    let streamOpened = false;
    const app = await bind(
      createServer((request, response) => {
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/page" });
          response.end();
          return;
        }
        if (request.url === "/events") {
          streamOpened = true;
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.flushHeaders();
          response.write("data: first live response\n\n");
          response.on("close", () => {
            streamEnded = true;
          });
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<output>Waiting</output><script>new EventSource("/events").onmessage=e=>document.querySelector("output").textContent=e.data;</script>',
        );
      }),
    );
    let checkedWhileOpen = false;
    const result = await runBrowserTest({
      root: root(),
      definition: {
        schemaVersion: 1,
        id: "stream",
        startUrl: `${app}/redirect`,
        assertions: [
          {
            id: "live",
            kind: "text",
            selector: { by: "css", value: "output" },
            expected: "first live response",
          },
        ],
      },
      onEvent: (event) => {
        if (event.type === "assertion") checkedWhileOpen = streamOpened && !streamEnded;
      },
    });
    expect(result.status).toBe("passed");
    expect(checkedWhileOpen).toBe(true);
    expect(result.errors).toEqual([]);
  });
  it("blocks an unapproved redirect before reaching its server", async () => {
    let reached = 0;
    const forbidden = await bind(
      createServer((_request, response) => {
        reached++;
        response.end("should not arrive");
      }),
    );
    const app = await bind(
      createServer((_request, response) => {
        response.writeHead(302, { location: forbidden });
        response.end();
      }),
    );
    const result = await runBrowserTest({
      root: root(),
      definition: { schemaVersion: 1, id: "blocked", startUrl: app },
      capture: { screenshot: "off" },
      stepTimeoutMs: 500,
    });
    expect(result.status).toBe("failed");
    expect(reached).toBe(0);
    expect(result.errors.some((error) => error.code === "browser.ORIGIN_BLOCKED")).toBe(true);
  });
  it("supports a permitted WebSocket upgrade without buffering its message", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<output>Waiting</output><script>const connection=new WebSocket(location.origin.replace("http:","ws:")+"/socket");connection.onmessage=e=>document.querySelector("output").textContent=e.data;</script>',
      );
    });
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("Ready")]));
      socket.on("error", () => undefined);
      socket.on("data", () => socket.end());
    });
    const app = await bind(server);
    const result = await runBrowserTest({
      root: root(),
      definition: {
        schemaVersion: 1,
        id: "websocket",
        startUrl: app,
        assertions: [
          { id: "message", kind: "text", selector: { by: "css", value: "output" }, expected: "Ready" },
        ],
      },
      stepTimeoutMs: 1500,
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
  });
});
