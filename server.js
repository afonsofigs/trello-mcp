import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// --- Configuration ---

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;
const TRELLO_WORKSPACE_ID = process.env.TRELLO_WORKSPACE_ID;
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const UPSTREAM_ENTRY = process.env.UPSTREAM_ENTRY
  || "node_modules/@delorenj/mcp-server-trello/build/index.js";

if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
  console.error("Error: TRELLO_API_KEY and TRELLO_TOKEN are required");
  process.exit(1);
}
if (!MCP_SECRET) {
  console.error("Error: MCP_SECRET environment variable is required");
  process.exit(1);
}

// --- Spawn upstream Trello MCP over stdio ---

const upstreamEnv = {
  ...process.env,
  TRELLO_API_KEY,
  TRELLO_TOKEN,
};
if (TRELLO_BOARD_ID) upstreamEnv.TRELLO_BOARD_ID = TRELLO_BOARD_ID;
if (TRELLO_WORKSPACE_ID) upstreamEnv.TRELLO_WORKSPACE_ID = TRELLO_WORKSPACE_ID;

const upstreamTransport = new StdioClientTransport({
  command: process.execPath,
  args: [UPSTREAM_ENTRY],
  env: upstreamEnv,
  stderr: "pipe",
});

const upstreamClient = new Client(
  { name: "trello-mcp-oauth-proxy", version: "1.0.0" },
  { capabilities: {} },
);

upstreamTransport.onerror = (err) => {
  console.error(`[upstream] transport error: ${err.message}`);
};

await upstreamClient.connect(upstreamTransport);

if (upstreamTransport.stderr) {
  upstreamTransport.stderr.on("data", (d) =>
    process.stderr.write(`[upstream] ${d}`),
  );
}

const { tools: upstreamTools } = await upstreamClient.listTools();
console.log(
  `Upstream ready, ${upstreamTools.length} tools: ${upstreamTools.map((t) => t.name).join(", ")}`,
);

// --- OAuth 2.1 Provider (file-persisted, survives pod restarts) ---

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "/data/oauth-tokens.json";

const FIXED_CLIENT_ID = createHash("sha256")
  .update(`${MCP_SECRET}:client_id`)
  .digest("hex")
  .slice(0, 36);
const FIXED_CLIENT_SECRET = createHash("sha256")
  .update(`${MCP_SECRET}:client_secret`)
  .digest("hex");

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { tokens: {}, codes: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      }
    } catch (err) {
      console.warn(`[tokenstore] Failed to load ${this.filePath}: ${err.message}, starting fresh`);
      this.data = { tokens: {}, codes: {} };
    }
  }

  _save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data));
    } catch (err) {
      console.error(`[tokenstore] Failed to save ${this.filePath}: ${err.message}`);
    }
  }

  getToken(key) { return this.data.tokens[key]; }
  setToken(key, value) { this.data.tokens[key] = value; this._save(); }
  deleteToken(key) { delete this.data.tokens[key]; this._save(); }

  getCode(key) { return this.data.codes[key]; }
  setCode(key, value) { this.data.codes[key] = value; this._save(); }
  deleteCode(key) { delete this.data.codes[key]; this._save(); }
}

class ClientsStore {
  constructor() {
    this.client = {
      client_id: FIXED_CLIENT_ID,
      client_secret: FIXED_CLIENT_SECRET,
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
      client_name: "Claude",
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  async getClient(clientId) {
    return clientId === FIXED_CLIENT_ID ? this.client : undefined;
  }
  async registerClient(_metadata) {
    return this.client;
  }
}

class OAuthProvider {
  constructor(store) {
    this.clientsStore = new ClientsStore();
    this.store = store;
  }

  async authorize(client, params, res) {
    console.log(`[oauth] authorize: client=${client.client_id} redirect=${params.redirectUri}`);
    const code = randomUUID();
    this.store.setCode(code, { client, params, createdAt: Date.now() });
    const searchParams = new URLSearchParams({ code });
    if (params.state) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    const data = this.store.getCode(code);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier) {
    console.log(`[oauth] exchangeCode: client=${client.client_id} code=${code.slice(0, 8)}...`);
    const data = this.store.getCode(code);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) throw new Error("Client mismatch");
    this.store.deleteCode(code);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(accessToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      expiresAt: Date.now() + expiresIn * 1000,
      resource: data.params.resource,
    });
    this.store.setToken(refreshToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      type: "refresh",
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (data.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
    const data = this.store.getToken(refreshToken);
    if (!data || data.type !== "refresh") throw new Error("Invalid refresh token");
    if (data.clientId !== client.client_id) throw new Error("Client mismatch");
    this.store.deleteToken(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(newAccessToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.store.setToken(newRefreshToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      type: "refresh",
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: (scopes || data.scopes).join(" "),
    };
  }

  async verifyAccessToken(token) {
    const data = this.store.getToken(token);
    if (!data || data.type === "refresh") throw new Error("Invalid token");
    if (data.expiresAt && data.expiresAt < Date.now()) {
      this.store.deleteToken(token);
      throw new Error("Token expired");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ? Math.floor(data.expiresAt / 1000) : undefined,
      resource: data.resource,
    };
  }

  async revokeToken(token) {
    this.store.deleteToken(token);
  }
}

// --- MCP Server (proxies tools to upstream Trello MCP via stdio) ---

function createMcpServer() {
  const server = new Server(
    { name: "trello-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: upstreamTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await upstreamClient.callTool({
        name: request.params.name,
        arguments: request.params.arguments || {},
      });
      return result;
    } catch (err) {
      return {
        content: [{ type: "text", text: `Upstream error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --- Express App ---

const tokenStore = new TokenStore(TOKEN_STORE_PATH);
const provider = new OAuthProvider(tokenStore);
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, version: "1.0.0", tools: upstreamTools.length }));

const issuerUrl = new URL(SERVER_URL);
app.use(mcpAuthRouter({
  provider,
  issuerUrl,
  scopesSupported: ["mcp:tools"],
}));

const transports = new Map();

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "Missing token" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const authInfo = await provider.verifyAccessToken(token);
    req.auth = authInfo;
    next();
  } catch (err) {
    res.status(401).set("WWW-Authenticate", `Bearer error="invalid_token"`).json({ error: err.message });
  }
};

app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
    } else {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
    }
  } catch (err) {
    console.error(`[mcp] POST error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: "Missing or invalid session ID" });
  }
  await transports.get(sessionId).handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId).handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

const shutdown = async () => {
  console.log("Shutting down...");
  try { await upstreamClient.close(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`trello-mcp v1.0.0 listening on :${PORT}`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
  console.log(`Upstream: @delorenj/mcp-server-trello (${upstreamTools.length} tools)`);
});
