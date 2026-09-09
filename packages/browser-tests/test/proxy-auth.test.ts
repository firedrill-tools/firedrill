import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { expect, it } from "vitest";
import { startBrowserProxy } from "../src/proxy.js";

it("requires proxy credentials and blocks unapproved CONNECT before any upstream connection", async () => {
  let hits = 0;
  const target = createTcpServer((socket) => {
    hits++;
    socket.on("error", () => undefined);
    socket.end("unexpected");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw Error("No listener");
  const proxy = await startBrowserProxy({
    origins: new Set(["https://127.0.0.1:1"]),
    timeoutMs: 1000,
    blocked: () => undefined,
  });
  const status = (auth: boolean) =>
    new Promise<number>((resolve, reject) => {
      const call = request(proxy.url, {
        method: "CONNECT",
        path: `127.0.0.1:${address.port}`,
        headers: auth
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`,
            }
          : {},
      });
      call.on("connect", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode ?? 0);
      });
      call.on("error", reject);
      call.end();
    });
  try {
    expect(await status(false)).toBe(407);
    expect(await status(true)).toBe(403);
    expect(hits).toBe(0);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

it("does not leak proxy authorization to an approved upstream", async () => {
  let proxyAuthorization: string | undefined;
  const server = createServer((incoming, response) => {
    proxyAuthorization = incoming.headers["proxy-authorization"];
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const proxy = await startBrowserProxy({
    origins: new Set([origin]),
    timeoutMs: 1000,
    blocked: () => undefined,
  });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const call = request(
        proxy.url,
        {
          path: `${origin}/`,
          headers: {
            "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      call.on("error", reject);
      call.end();
    });
    expect(status).toBe(200);
    expect(proxyAuthorization).toBeUndefined();
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
