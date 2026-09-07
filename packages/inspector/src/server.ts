import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  createLocalSimulationRequestHandler,
  LocalSimulationSupervisor,
  type LocalSimulationSupervisorOptions,
} from "@firedrill/simulation";

const KNOWN_ROUTES = new Set([
  "/",
  "/world",
  "/schema",
  "/data",
  "/personas",
  "/scenarios",
  "/tools",
  "/drills",
  "/runs",
]);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface StartLocalInspectorOptions extends LocalSimulationSupervisorOptions {
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
}

interface InternalStartLocalInspectorOptions extends StartLocalInspectorOptions {
  readonly assetDirectory: string;
  readonly token?: string;
}

export interface LocalInspectorServer {
  readonly url: string;
  readonly supervisor: LocalSimulationSupervisor;
  close(): Promise<void>;
}

function staticAssets(directory: string): ReadonlyMap<string, StaticAsset> {
  const assets = new Map<string, StaticAsset>();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const route = `/${relative(directory, path).split(sep).join("/")}`;
      if (route === "/index.html") continue;
      const contentType = CONTENT_TYPES[extname(entry.name)];
      if (contentType === undefined) continue;
      assets.set(route, { body: readFileSync(path), contentType });
    }
  };
  visit(directory);
  return assets;
}

function staticHeaders(contentType: string): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      // Locally opened verified report blobs inherit this policy and carry their own inline CSS.
      // Only styles are relaxed; scripts and network requests remain same-origin restricted.
      "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writeStatic(response: ServerResponse, status: number, asset: StaticAsset, head: boolean): void {
  response.writeHead(status, {
    ...staticHeaders(asset.contentType),
    "content-length": asset.body.length,
  });
  response.end(head ? undefined : asset.body);
}

function writeNotFound(response: ServerResponse): void {
  const body = Buffer.from("Not found\n");
  response.writeHead(404, {
    ...staticHeaders("text/plain; charset=utf-8"),
    "content-length": body.length,
  });
  response.end(body);
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

export async function startLocalInspectorWithAssets(
  options: InternalStartLocalInspectorOptions,
): Promise<LocalInspectorServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }
  const assetDirectory = resolve(options.assetDirectory);
  const indexTemplate = readFileSync(join(assetDirectory, "index.html"), "utf8");
  if (!indexTemplate.includes("__FIREDRILL_TOKEN__")) {
    throw new Error("local inspector index is missing its token placeholder");
  }
  const assets = staticAssets(assetDirectory);
  const token = options.token ?? randomBytes(32).toString("base64url");
  const supervisor = await LocalSimulationSupervisor.create(options);
  const handler = createLocalSimulationRequestHandler(
    supervisor,
    token,
    (request: IncomingMessage, response: ServerResponse, context) => {
      const head = request.method === "HEAD";
      if (request.method !== "GET" && !head) {
        writeNotFound(response);
        return;
      }
      const asset = assets.get(context.url.pathname);
      if (asset !== undefined) {
        writeStatic(response, 200, asset, head);
        return;
      }
      if (!KNOWN_ROUTES.has(context.url.pathname)) {
        writeNotFound(response);
        return;
      }
      const body = Buffer.from(indexTemplate.replace("__FIREDRILL_TOKEN__", context.token));
      writeStatic(response, 200, { body, contentType: "text/html; charset=utf-8" }, head);
    },
  );
  const server = createServer(handler);
  try {
    await listen(server, port, hostname);
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await supervisor.close();
    await closeServer(server);
    throw new Error("local inspector has no TCP address");
  }
  const host = hostname === "::1" ? `[${hostname}]` : hostname;
  let closed = false;
  return {
    url: `http://${host}:${address.port}`,
    supervisor,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await supervisor.close();
    },
  };
}

/** Starts an offline, loopback-only inspector over the repository's real world runtime. */
export function startLocalInspector(options: StartLocalInspectorOptions = {}): Promise<LocalInspectorServer> {
  return startLocalInspectorWithAssets({
    ...options,
    assetDirectory: join(import.meta.dirname, "client"),
  });
}
