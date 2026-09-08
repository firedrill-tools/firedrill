import type { ActorId, WorldInstanceId } from "@firedrill/contracts";
import { startCliWorldBinding } from "@firedrill/protocol-cli";
import { startHttpWorldBinding } from "@firedrill/protocol-http";
import { startMcpWorldBinding } from "@firedrill/protocol-mcp";
import type { LoadedWorldBuild } from "@firedrill/world-build";
import type { BoundWorldClient } from "@firedrill/world-kernel";
import { FiredrillProjectError } from "./project-error.js";

export type LocalWorldProtocol = "http" | "mcp" | "cli";
export interface LocalWorldListenOptions {
  /** Omit only when the selected world has exactly one actor. */
  readonly actorId?: string;
  /** Defaults to HTTP, MCP, and CLI. All listeners bind only to loopback. */
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
  /** Revokes this listener immediately, then waits for all its sockets to close. */
  close(): Promise<void>;
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
    readonly client: Pick<BoundWorldClient, "invoke">;
    readonly options: LocalWorldListenOptions;
    readonly onClosed: () => void;
  }) {
    this.#worldInstanceId = input.worldInstanceId;
    this.#actorId = input.actorId;
    this.#tools = input.tools;
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
    let current: LocalWorldProtocol | undefined;
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
      return Object.freeze({
        worldInstanceId: this.#worldInstanceId,
        actorId: this.#actorId,
        environment: Object.freeze(environment),
        ...endpoints,
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
