# @valkvlabs/edgekv-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent memory that
lasts between conversations: a ValkvEdgeKV database it can read, list and write. With an
encryption key, values are encrypted on your machine before they are sent, and the
service only ever stores ciphertext.

It works with any MCP client that starts servers over stdio: Claude Desktop, Claude
Code, Cursor and others. Node 18 or later.

**Not published to npm yet.** Build it from this folder: `make mcp-test` in the
repository root type-checks, tests and builds it into `dist/`; then use
`node /path/to/mcp/dist/main.js` where the examples say `npx -y @valkvlabs/edgekv-mcp`.

## Set up

1. In the portal, create a database for the agent's memory and an API key for it
   (**Only one database** is the safest choice).
2. Optionally, make an encryption key and keep it somewhere safe. A lost key cannot be
   recovered, by you or by us:

   ```sh
   openssl rand -hex 32
   ```

3. Add the server to your client.

**Claude Code:**

```sh
claude mcp add edgekv \
  -e EDGEKV_API_KEY=ekv_... \
  -e EDGEKV_URL=https://api.example.com \
  -e EDGEKV_DATABASE=agent-memory \
  -e EDGEKV_ENCRYPTION_KEY=<64 hex characters> \
  -- npx -y @valkvlabs/edgekv-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and
most other clients:

```json
{
  "mcpServers": {
    "edgekv": {
      "command": "npx",
      "args": ["-y", "@valkvlabs/edgekv-mcp"],
      "env": {
        "EDGEKV_API_KEY": "ekv_...",
        "EDGEKV_URL": "https://api.example.com",
        "EDGEKV_DATABASE": "agent-memory",
        "EDGEKV_ENCRYPTION_KEY": "<64 hex characters>"
      }
    }
  }
}
```

Use the addresses shown in your portal.

## Settings

| Variable | |
|---|---|
| `EDGEKV_API_KEY` | Required. An API key from the portal, `ekv_...` |
| `EDGEKV_URL` | Required. Where the data API is |
| `EDGEKV_DATABASE` | Use only this database; the tools then take no database name. Recommended |
| `EDGEKV_ENCRYPTION_KEY` | 64 hexadecimal characters. Values are encrypted before they are sent. Without it, values are sent as they are |
| `EDGEKV_CONTROL_URL` | Where databases are managed. With it, and without `EDGEKV_DATABASE`, the agent can list and create databases (the key must be allowed to manage databases) |
| `EDGEKV_REGION` | Where `create_database` puts a database. Default: the first region offered |
| `EDGEKV_READ_ONLY` | `1`: only the tools that read |
| `EDGEKV_ALLOW_DELETE` | `1`: also the tool that deletes a key. Off by default, so an agent cannot wipe its memory by mistake |

Settings are checked when the server starts; a wrong one stops it with a message
naming every problem.

## Tools

| Tool | Does | When |
|---|---|---|
| `get` | Reads a key's value and version | Always |
| `scan` | Lists keys in order, optionally by prefix, with values, a page at a time | Always |
| `put` | Writes a key. With `if_version`, only if nobody changed it since it was read; with `if_absent`, only if it is new | Not read-only |
| `put_many` | Writes several keys as one write: all or none | Not read-only |
| `delete` | Removes a key | `EDGEKV_ALLOW_DELETE=1` |
| `list_databases`, `create_database` | Manage databases, for example one per user | `EDGEKV_CONTROL_URL`, no `EDGEKV_DATABASE` |

Values are text; the agent is told to use JSON for anything structured. A value that is
not valid UTF-8 comes back as `value_base64`. Failures come back as tool errors with
the service's code and what to do about it.

## Encryption

With `EDGEKV_ENCRYPTION_KEY`, each value is encrypted in this process with
ChaCha20-Poly1305, bound to its database and key name. The service never sees the
encryption key or the values. It is the same format the SDKs and local replicas use, so
your own code reads what the agent wrote with the same key:

```ts
const memory = new EdgeKV({ apiKey, url }).database('agent-memory', { encryptionKey: process.env.EDGEKV_ENCRYPTION_KEY })
```

Key names are not encrypted: keep secrets out of them. Use one choice per database:
always the same key, or never one. Reading a value written without the key, or with
another key, fails with `INVALID_ENCRYPTION_KEY`.

## Cost

Each `put` is one write against your plan's writes per month; `put_many` is one write
however many keys it holds. Reads count towards data served.

## Developing

```sh
make mcp-test    # in the repository root: type-check, tests and build, in Docker
```

The tests drive the tools through a real MCP client against a stand-in for the service.
The server uses the TypeScript SDK from `../typescript`.
