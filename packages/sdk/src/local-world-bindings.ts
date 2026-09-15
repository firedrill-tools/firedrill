import type { ActorId, WorldInstanceId } from "@firedrill/contracts";
import { startCliWorldBinding } from "@firedrill/protocol-cli";
import { startHttpWorldBinding, startToolUiBinding, type ToolUiRevision } from "@firedrill/protocol-http";
import { startMcpWorldBinding } from "@firedrill/protocol-mcp";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { FiredrillProjectError } from "./project-error.js";

export type LocalWorldProtocol = "http" | "mcp" | "cli";
export interface LocalWorldListenOptions {
  /** Omit only when the selected world has exactly one actor. */
  readonly actorId?: string;
  /** Defaults to HTTP, MCP, and CLI. Declared Tool apps start independently of this selection. */
  readonly protocols?: readonly LocalWorldProtocol[];
  /** Defaults to an ephemeral port. Zero also selects an ephemeral port. */
  readonly httpPort?: number;
  readonly mcpPort?: number;
  readonly cliPort?: number;
}
export interface LocalWorldBinding {
  readonly worldInstanceId: WorldInstanceId;
  readonly actorId: ActorId;
  readonly environment: Readonly<Record<string, string>>;
  readonly http?: { readonly url: string; readonly token: string };
  readonly mcp?: { readonly url: string; readonly token: string };
  readonly cli?: { readonly url: string; readonly token: string };
  /** Optional Tool UIs, each on its own origin with a package- and actor-scoped credential. */
  readonly apps: readonly LocalWorldApp[];
  /** Resolved per-package recipes. Values may include tokens; apply explicitly in a test process only. */
  readonly connections?: readonly LocalWorldConnection[];
  /** Revokes this listener immediately, then waits for all its sockets to close. */
  close(): Promise<void>;
}

export interface LocalWorldApp {
  readonly packageId: string;
  readonly title: string;
  /** Scoped credential for an explicit browser/agent connection. Never persist it in logs or reports. */
  readonly url: string;
}

export interface LocalWorldConnection {
  readonly packageId: string;
  readonly id: string;
  readonly title: string;
  readonly protocol: LocalWorldProtocol;
  readonly environment: Readonly<Record<string, string>>;
  /** Untrusted package-authored help text, not a command to execute. */
  readonly instructions?: string;
}

const PROTOCOLS = ["http", "mcp", "cli"] as const;
export function validateLocalWorldListenOptions(
  options: LocalWorldListenOptions,
): readonly LocalWorldProtocol[] {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => !["actorId", "protocols", "httpPort", "mcpPort", "cliPort"].includes(key),
    )
  )
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "listen accepts actorId, protocols, and loopback ports only",
    );
  const protocols = options.protocols === undefined ? PROTOCOLS : options.protocols;
  if (
    !Array.isArray(protocols) ||
    protocols.length < 1 ||
    protocols.length > 3 ||
    protocols.some((protocol) => !PROTOCOLS.includes(protocol)) ||
    new Set(protocols).size !== protocols.length
  )
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "protocols must be a non-empty, unique list of http, mcp, and cli",
    );
  for (const protocol of PROTOCOLS) {
    const port = options[`${protocol}Port`];
    if (
      port !== undefined &&
      (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !protocols.includes(protocol))
    )
      throw new FiredrillProjectError(
        "framework.INVALID_ARGUMENT",
        `${protocol}Port requires that protocol and an integer from 0 through 65535`,
      );
  }
  return [...protocols];
}

/** Internal lifetime owner. It exposes only an invocation facade to protocol adapters. */
export class LocalWorldBindingSession {
  readonly #worldInstanceId: WorldInstanceId;
  readonly #actorId: ActorId;
  readonly #tools: LoadedWorldBuild["tools"];
  readonly #toolUis: LoadedWorldBuild["toolUis"];
  readonly #getRevision: () => ToolUiRevision;
  readonly #client: Pick<BoundWorldClient, "invoke">;
  readonly #protocols: readonly LocalWorldProtocol[];
  readonly #options: LocalWorldListenOptions;
  readonly #onClosed: () => void;
  readonly #listeners: Array<{ close(): Promise<void> }> = [];
  readonly #cleanupErrors: unknown[] = [];
  #closed = false;
  #starting: Promise<LocalWorldBinding> | undefined;
  #closing: Promise<void> | undefined;

  constructor(input: {
    readonly worldInstanceId: WorldInstanceId;
    readonly actorId: ActorId;
    readonly tools: LoadedWorldBuild["tools"];
    readonly toolUis: LoadedWorldBuild["toolUis"];
    readonly getRevision: () => ToolUiRevision;
    readonly client: Pick<BoundWorldClient, "invoke">;
    readonly options: LocalWorldListenOptions;
    readonly onClosed: () => void;
  }) {
    this.#worldInstanceId = input.worldInstanceId;
    this.#actorId = input.actorId;
    this.#tools = input.tools;
    this.#toolUis = input.toolUis;
    this.#getRevision = () => {
      this.#assertOpen();
      return input.getRevision();
    };
    this.#protocols = validateLocalWorldListenOptions(input.options);
    this.#options = { ...input.options };
    this.#onClosed = input.onClosed;
    this.#client = Object.freeze({
      invoke: (...arguments_: Parameters<BoundWorldClient["invoke"]>) => {
        this.#assertOpen();
        return input.client.invoke(...arguments_);
      },
    });
  }

  start(): Promise<LocalWorldBinding> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<LocalWorldBinding> {
    const environment: Record<string, string> = {};
    const endpoints: {
      http?: { url: string; token: string };
      mcp?: { url: string; token: string };
      cli?: { url: string; token: string };
    } = {};
    const apps: LocalWorldApp[] = [];
    let current: LocalWorldProtocol | "tool-ui" | undefined;
    try {
      for (const protocol of this.#protocols) {
        current = protocol;
        this.#assertOpen();
        const port = this.#options[`${protocol}Port`] ?? 0;
        const listener =
          protocol === "mcp"
            ? await startMcpWorldBinding({
                client: this.#client,
                tools: this.#tools.map((tool) => tool.manifest),
                port,
              })
            : protocol === "http"
              ? await startHttpWorldBinding({ client: this.#client, tools: this.#tools, port })
              : await startCliWorldBinding({ client: this.#client, tools: this.#tools, port });
        this.#listeners.push(listener);
        this.#assertOpen();
        endpoints[protocol] = Object.freeze({
          url: "url" in listener ? listener.url : listener.baseUrl,
          token: listener.token,
        });
        Object.assign(environment, listener.environment);
      }
      for (const ui of this.#toolUis) {
        current = "tool-ui";
        this.#assertOpen();
        const tool = this.#tools.find((candidate) => candidate.manifest.id === ui.packageId);
        if (tool === undefined) throw new Error("A Tool UI requires its loaded Tool");
        const listener = await startToolUiBinding({
          client: this.#client,
          tool,
          ui,
          worldInstanceId: this.#worldInstanceId,
          actorId: this.#actorId,
          getRevision: this.#getRevision,
        });
        this.#listeners.push(listener);
        this.#assertOpen();
        apps.push(Object.freeze({ packageId: listener.packageId, title: listener.title, url: listener.url }));
      }
      const connections: LocalWorldConnection[] = [];
      for (const tool of this.#tools) {
        for (const recipe of tool.manifest.connections ?? []) {
          if (!this.#protocols.includes(recipe.protocol)) continue;
          const projected: Record<string, string> = {};
          for (const [destination, source] of Object.entries(recipe.environment)) {
            const value = environment[source];
            if (value === undefined) throw new Error("A connection recipe requires an unavailable protocol");
            projected[destination] = value;
          }
          connections.push(
            Object.freeze({
              packageId: tool.manifest.id,
              id: recipe.id,
              title: recipe.title,
              protocol: recipe.protocol,
              environment: Object.freeze(projected),
              ...(recipe.instructions === undefined ? {} : { instructions: recipe.instructions }),
            }),
          );
        }
      }
      return Object.freeze({
        worldInstanceId: this.#worldInstanceId,
        actorId: this.#actorId,
        environment: Object.freeze(environment),
        apps: Object.freeze(apps),
        ...endpoints,
        ...(connections.length === 0 ? {} : { connections: Object.freeze(connections) }),
        close: () => this.close(),
      });
    } catch (error) {
      this.#closed = true;
      await this.#stopStarted();
      this.#onClosed();
      if (error instanceof FiredrillProjectError) throw error;
      throw new FiredrillProjectError(
        "framework.INTERNAL_ERROR",
        "Could not start the selected local world listener. Check that its loopback port is available.",
        {
          details: {
            protocol: current ?? "unknown",
            code:
              typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN",
            cleanupFailures: this.#cleanupErrors.length,
          },
        },
      );
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    const stopping = this.#stopStarted();
    this.#closing = (async () => {
      await stopping;
      await this.#starting?.catch(() => undefined);
      await this.#stopStarted();
      this.#onClosed();
      if (this.#cleanupErrors.length > 0)
        throw new FiredrillProjectError(
          "framework.INTERNAL_ERROR",
          "One or more local world listeners could not close cleanly.",
          { details: { failures: this.#cleanupErrors.length } },
        );
    })();
    return this.#closing;
  }

  async #stopStarted(): Promise<void> {
    await Promise.all(
      this.#listeners
        .splice(0)
        .reverse()
        .map(async (listener) => {
          try {
            await listener.close();
          } catch (error) {
            this.#cleanupErrors.push(error);
          }
        }),
    );
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new FiredrillProjectError("framework.WORLD_CLOSED", "the local world binding is closed");
  }
}
