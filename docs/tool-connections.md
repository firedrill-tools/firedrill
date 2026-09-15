# Keep the connection your agent already uses

A fake Tool can expose the same MCP operation name your agent already calls and describe the environment variables its existing client expects. Both belong to the Tool package, so every user of that package can reuse the setup. They are optional: existing Tools keep their current names and connection behavior.

## Exact MCP names

An operation can declare a portable, case-sensitive MCP alias:

```json
{
  "id": "update",
  "description": "Update a record",
  "inputSchema": {
    "type": "object",
    "properties": { "value": { "type": "integer" } },
    "required": ["value"]
  },
  "outputSchema": { "type": "object" },
  "idempotency": "none",
  "fidelity": "stateful",
  "mcp": {
    "name": "RECORDS_UPDATE_v2",
    "description": "Update a record through the existing client contract"
  }
}
```

With a package id of `records`, the running MCP endpoint lists both `RECORDS_UPDATE_v2` and the existing canonical name `records.update`. Both invoke the same behavior, actor permissions, state, error policy, and idempotency handling. Reports record the canonical operation identity, so assertions do not need separate copies for each name.

Names follow the [MCP portable naming recommendations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names): 1–128 characters, ASCII letters, digits, underscores, hyphens, or dots. Case is preserved. A duplicate alias, or an alias that takes another operation's canonical name, is rejected during validation and again before the listener starts.

An alias changes the exposed name and optional description, **not the input or response shape**. Write the operation's schema and behavior to match the client you want to support. This is not an automatic compatibility claim for every operation of an external service. Test the actual client, including its error paths, before claiming compatibility.

## Connection recipes

Add `connections` to a Tool's manifest:

```json
{
  "connections": [
    {
      "id": "existing-client",
      "title": "Existing MCP client",
      "protocol": "mcp",
      "environment": {
        "CLIENT_MCP_URL": "FIREDRILL_MCP_URL",
        "CLIENT_MCP_TOKEN": "FIREDRILL_MCP_TOKEN"
      },
      "instructions": "Pass these variables only to your test process."
    }
  ]
}
```

The file stores variable **names**, never real tokens or API keys. Each recipe can map 1–32 client variable names to the URL/token of its declared `http`, `mcp`, or `cli` protocol. It cannot read unrelated host variables, replace reserved `FIREDRILL_*` names, run a command, or evaluate a template.

`world.describe().tools` exposes the authored recipes without credentials. After `world.listen()`, `binding.connections` contains the resolved recipes for the protocols actually started. Each entry includes its Tool package id, recipe id, title, protocol, and environment values. `binding.environment` remains the unchanged canonical environment; recipes are kept separate so two Tools expecting a similarly named variable cannot silently overwrite each other.

Select the recipe matching your client and pass its values to a **test-only process** or fixture. Firedrill does not rewrite `.env`, production configuration, agent code, or the current process environment. Treat resolved recipes as credentials and keep them out of Git. Their values survive a world reset and expire when the local listener closes.

Recipe instructions are package-authored display text, not authority to execute commands. Tool authors should use them for brief setup notes and clearly state any unsupported client behavior.
