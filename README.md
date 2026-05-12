# trello-mcp

OAuth 2.1 + Streamable HTTP wrapper around [`@delorenj/mcp-server-trello`](https://github.com/delorenj/mcp-server-trello), so Trello can be added as a remote connector in [Claude.ai](https://claude.ai).

## Why?

`@delorenj/mcp-server-trello` is excellent but stdio-only. Claude.ai needs remote MCPs over Streamable HTTP with OAuth. This package spawns the upstream as a child process and proxies all its tools (≈30) through an OAuth 2.1 layer, with file-persisted tokens so reconnection survives pod restarts.

## Features

- **All upstream Trello tools, zero drift** — tools are discovered at boot via `tools/list` and proxied 1:1
- **OAuth 2.1** — fixed client credentials derived deterministically from `MCP_SECRET`
- **Persistent tokens** — written to `TOKEN_STORE_PATH` (default `/data/oauth-tokens.json`)
- **Docker / K8s ready**

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRELLO_API_KEY` | Yes | From https://trello.com/app-key |
| `TRELLO_TOKEN` | Yes | Generated via the same page |
| `MCP_SECRET` | Yes | Random secret; OAuth `client_id`/`client_secret` are derived from it |
| `SERVER_URL` | Yes | Public HTTPS URL (OAuth issuer) |
| `TRELLO_BOARD_ID` | No | Default active board |
| `TRELLO_WORKSPACE_ID` | No | Default active workspace |
| `TOKEN_STORE_PATH` | No | Default `/data/oauth-tokens.json` |
| `PORT` | No | Default `3000` |
| `UPSTREAM_ENTRY` | No | Path to upstream entry; default `node_modules/@delorenj/mcp-server-trello/build/index.js` |

## Quick start

```bash
docker run -d \
  -e TRELLO_API_KEY=... \
  -e TRELLO_TOKEN=... \
  -e MCP_SECRET=$(openssl rand -hex 32) \
  -e SERVER_URL=https://trello-mcp.example.com \
  -v $(pwd)/data:/data \
  -p 3000:3000 \
  ghcr.io/afonsofigs/trello-mcp:latest
```

Logs print the OAuth `client_id` and `client_secret` on startup — use them when adding the connector in Claude.ai.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check |
| `GET /.well-known/oauth-authorization-server` | No | OAuth metadata |
| `POST /register` | No | Client registration (returns fixed client) |
| `GET /authorize` | No | Authorization (auto-approve) |
| `POST /token` | No | Token exchange |
| `POST /mcp` | Bearer | Streamable HTTP — MCP requests |
| `GET /mcp` | Bearer | Streamable HTTP — server notifications |
| `DELETE /mcp` | Bearer | Session termination |

## Architecture

```
Claude.ai
   │
   │  HTTPS + OAuth 2.1 + Streamable HTTP
   ▼
trello-mcp (this package)
   │
   │  MCP over stdio (child process)
   ▼
@delorenj/mcp-server-trello
   │
   │  HTTPS
   ▼
Trello REST API
```

## License

MIT
