# CLAUDE.md

## What is this?

OAuth 2.1 + Streamable HTTP proxy that wraps the upstream stdio MCP `@delorenj/mcp-server-trello` so it can be used as a remote connector from Claude.ai.

## Stack

- Node.js (ESM), single file: `server.js`
- `@modelcontextprotocol/sdk` — both server (Streamable HTTP) and client (stdio) sides
- `@delorenj/mcp-server-trello` — upstream Trello MCP, spawned as child process
- `express` — HTTP server

## Project structure

```
server.js          — OAuth proxy + upstream subprocess management + MCP request forwarding
package.json       — Dependencies (pin upstream version)
Dockerfile         — node:24-alpine
.github/workflows/ — CI/CD to ghcr.io/afonsofigs/trello-mcp
```

## Key design decisions

- **Stdio proxy, not reimplementation** — All ~30 Trello tools come from upstream via `tools/list`. Our server just forwards `tools/call` to the upstream `Client` instance. Adding new tools upstream propagates automatically on next image rebuild.
- **Single upstream child process** — Spawned once at startup, shared across all MCP sessions. Closing on SIGTERM/SIGINT.
- **OAuth client credentials derived from `MCP_SECRET`** — Same pattern as `telegram-bot-mcp` / `obsidian-couchdb-mcp`. Deterministic across restarts.
- **File-persisted token store** — `TOKEN_STORE_PATH` (default `/data/oauth-tokens.json`). Mount a PVC there so connectors don't re-auth after pod restarts.
- **Redirect URI validation** — Only `claude.ai` and `claude.com` callback URLs accepted.

## Common tasks

### Bump upstream tools
```bash
npm update @delorenj/mcp-server-trello
git commit -am "chore: bump upstream"
git push  # triggers image rebuild
```

### Test locally
```bash
npm install
TRELLO_API_KEY=... TRELLO_TOKEN=... MCP_SECRET=$(openssl rand -hex 32) \
  SERVER_URL=http://localhost:3000 node server.js

curl http://localhost:3000/health
```

### Add a custom tool on top of upstream
In `createMcpServer()`, after the `setRequestHandler(CallToolRequestSchema, ...)` block, intercept specific tool names *before* calling `upstreamClient.callTool()`. The `ListToolsRequestSchema` handler should also append any custom tool definitions to `upstreamTools`.

## CI/CD

Push to `main` triggers GitHub Actions → builds and pushes `ghcr.io/afonsofigs/trello-mcp:latest` and a SHA tag.
