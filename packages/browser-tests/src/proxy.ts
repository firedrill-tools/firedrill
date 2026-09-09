import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface BrowserProxy {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
}
/** A streaming application proxy. It never follows redirects; every new origin is checked again. */
export async function startBrowserProxy(options: {
  readonly origins: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly blocked: (message: string) => void;
}): Promise<BrowserProxy> {
  const username = "firedrill";
  const password = randomBytes(32).toString("base64url");
  const credential = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const sockets = new Set<Duplex>();
  let closing: Promise<void> | undefined;
  let stopped = false;
  let requests = 0;
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const authorized = (request: IncomingMessage) => {
    const actual = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return actual.length === credential.length && timingSafeEqual(actual, credential);
  };
  const allowed = (url: URL) =>
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    options.origins.has(url.origin);
  const requestUrl = (request: IncomingMessage) => {
    try {
      const url = new URL(request.url ?? "");
      return allowed(url) ? url : undefined;
    } catch {
      return undefined;
    }
  };
  const requestHeaders = (headers: IncomingHttpHeaders, url: URL) => {
    const result: IncomingHttpHeaders = { ...headers, host: url.host };
    delete result["proxy-authorization"];
    delete result["proxy-connection"];
    return result;
  };
  const blocked = () => {
    if (!stopped) options.blocked("Blocked an application connection outside the explicitly allowed origins");
  };
  const server = createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(407, { "proxy-authenticate": "Basic realm=Firedrill" });
      response.end();
      return;
    }
    const url = requestUrl(request);
    if (!url || ++requests > 10000 || stopped) {
      blocked();
      response.writeHead(403);
      response.end("Browser connection blocked");
      return;
    }
    const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: request.method, headers: requestHeaders(request.headers, url), timeout: options.timeoutMs },
      (remote) => {
        const headers = { ...remote.headers };
        delete headers["proxy-authenticate"];
        response.writeHead(remote.statusCode ?? 502, headers);
        let received = 0;
        remote.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > 128 * 1024 * 1024) {
            if (!stopped) options.blocked("Application response exceeded the 128 MiB browser request limit");
            remote.destroy();
            response.destroy();
          }
        });
        remote.on("error", () => response.destroy());
        remote.pipe(response);
      },
    );
    upstream.on("socket", track);
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    let sent = 0;
    request.on("data", (chunk: Buffer) => {
      sent += chunk.byteLength;
      if (sent > 64 * 1024 * 1024) {
        if (!stopped) options.blocked("Application request exceeded the 64 MiB browser request limit");
        upstream.destroy();
        request.destroy();
      }
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", track);
  // HTTPS (and browser WebSocket tunnels) still pass through the proxy for every
  // destination. No remote socket opens before authority and initial protocol agree.
  server.on("connect", (request, rawSocket, head) => {
    const socket = track(rawSocket as Socket);
    if (!authorized(request)) {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=Firedrill\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    let target: URL;
    try {
      target = new URL(`https://${request.url ?? ""}`);
    } catch {
      blocked();
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const httpsAllowed = allowed(target);
    const plaintext = new URL(target.href);
    plaintext.protocol = "http:";
    // Keep an explicit :443 when mapping a CONNECT authority to plaintext HTTP.
    if (!target.port) plaintext.port = "443";
    const httpAllowed = allowed(plaintext);
    if (
      (!httpsAllowed && !httpAllowed) ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      ++requests > 10000 ||
      stopped
    ) {
      blocked();
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.setTimeout(Math.min(options.timeoutMs, 10000), () => socket.destroy());
    const open = (initial: Buffer) => {
      socket.pause();
      const encrypted = initial[0] === 0x16;
      if ((encrypted && !httpsAllowed) || (!encrypted && !httpAllowed)) {
        blocked();
        socket.destroy();
        return;
      }
      const upstream = track(
        connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port || 443) }),
      );
      upstream.setTimeout(options.timeoutMs, () => upstream.destroy());
      upstream.once("connect", () => {
        socket.setTimeout(options.timeoutMs);
        upstream.write(initial);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    };
    if (head.length) open(head);
    else socket.once("data", open);
  });
  server.on("upgrade", (request, rawSocket, head) => {
    const socket = track(rawSocket as Socket);
    if (!authorized(request)) {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=Firedrill\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const url = requestUrl(request);
    if (!url || ++requests > 10000 || stopped) {
      blocked();
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstreamRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: request.method,
      headers: requestHeaders(request.headers, url),
      timeout: options.timeoutMs,
    });
    upstreamRequest.on("socket", track);
    upstreamRequest.on("upgrade", (response, remote, remoteHead) => {
      track(remote);
      const safeHeaders = Object.entries(response.headers)
        .filter(([key]) => !key.startsWith("proxy-"))
        .flatMap(([key, value]) =>
          Array.isArray(value)
            ? value.map((item) => `${key}: ${item}`)
            : value === undefined
              ? []
              : [`${key}: ${value}`],
        );
      socket.write(
        `HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n${safeHeaders.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket);
      socket.pipe(remote);
      socket.once("close", () => remote.destroy());
      remote.once("close", () => socket.destroy());
      remote.on("error", () => socket.destroy());
    });
    upstreamRequest.on("response", () => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstreamRequest.destroy();
    });
    upstreamRequest.on("error", () => socket.destroy());
    upstreamRequest.on("timeout", () => upstreamRequest.destroy());
    socket.on("error", () => upstreamRequest.destroy());
    upstreamRequest.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser proxy did not acquire a local port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close() {
      closing ??= new Promise<void>((resolve) => {
        stopped = true;
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
