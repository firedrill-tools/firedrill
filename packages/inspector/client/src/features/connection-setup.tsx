import { useState } from "react";
import { CodeDocument } from "../components/code-document";
import { Button } from "../components/primitives";
import type { EnvironmentConnection, EnvironmentConnections } from "../environment-types";
import { json } from "../format";

type RevealedConnection = EnvironmentConnections["connections"][number];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The public adapter variables, scoped to one actual listener; no inspector control credentials. */
export function connectionShell(connection: RevealedConnection): string {
  const prefix = `FIREDRILL_${connection.protocol.toUpperCase()}`;
  return `export ${prefix}_URL=${shellQuote(connection.url)}\nexport ${prefix}_TOKEN=${shellQuote(connection.token)}`;
}

/** Claude Agent SDK's HTTP MCP server options, not a universal client configuration format. */
export function connectionMcpOptions(connection: RevealedConnection): string {
  if (connection.protocol !== "mcp") throw new Error("MCP options require an MCP connection.");
  return json({
    mcpServers: {
      firedrill: {
        type: "http",
        url: connection.url,
        headers: { Authorization: `Bearer ${connection.token}` },
      },
    },
  });
}

export function ConnectionEndpoint({ connection }: { readonly connection: EnvironmentConnection }) {
  return (
    <dl className="fd-connection-endpoint">
      <div>
        <dt>Local endpoint</dt>
        <dd>
          <section
            className="fd-connection-endpoint__scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of an unbroken endpoint.
            tabIndex={0}
            aria-label={`${connection.protocol.toUpperCase()} endpoint`}
          >
            <code>{connection.url}</code>
          </section>
        </dd>
      </div>
      <div>
        <dt>Actor scope</dt>
        <dd>
          <code>{connection.actorId}</code>
        </dd>
      </div>
    </dl>
  );
}

export function ConnectionSetup({ connection }: { readonly connection: RevealedConnection }) {
  const [format, setFormat] = useState<"shell" | "mcp">("shell");
  const sdkOptions = connection.protocol === "mcp" && format === "mcp";
  return (
    <div className="fd-connection-setup">
      {connection.protocol === "mcp" ? (
        <nav className="fd-local-connection-actions" aria-label="MCP configuration format">
          <Button size="compact" aria-pressed={!sdkOptions} onClick={() => setFormat("shell")}>
            Shell exports
          </Button>
          <Button size="compact" aria-pressed={sdkOptions} onClick={() => setFormat("mcp")}>
            Claude Agent SDK
          </Button>
        </nav>
      ) : null}
      <p>
        {sdkOptions
          ? "Merge this into your existing Claude Agent SDK options to add the local MCP server."
          : "Copy into the terminal where you launch your agent (sh, bash, or zsh). Map these values to its existing tool configuration."}
      </p>
      <CodeDocument
        content={sdkOptions ? connectionMcpOptions(connection) : connectionShell(connection)}
        language={sdkOptions ? "json" : "bash"}
        context={
          sdkOptions
            ? "Claude Agent SDK options · keep private"
            : `${connection.protocol.toUpperCase()} shell exports · keep private`
        }
      />
      <p className="fd-connection-setup__hint">
        {connection.protocol === "mcp"
          ? "Use Streamable HTTP with the endpoint and bearer token. Other MCP clients may use a different configuration format."
          : connection.protocol === "cli"
            ? "After exporting, firedrill world tools --json lists exposed operations. Actor permissions are checked on each call. Start your agent in this terminal."
            : "Use the URL as the HTTP base and the token for bearer authentication on Firedrill’s generic routes. A Tool’s custom HTTP routes may declare different authentication."}
      </p>
    </div>
  );
}
