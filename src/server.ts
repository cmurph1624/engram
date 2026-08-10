import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { initPool, getPool, closePool } from "./db.js";
import { migrate } from "./migrate.js";
import { registerAllTools } from "./tools/index.js";

function buildMcpServer(config: Config): McpServer {
  const server = new McpServer({ name: "engram", version: "2.0.0" });
  registerAllTools(server, config);
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  initPool(config.database_url);

  // Fail loudly if Postgres is unreachable — pm2 will restart with backoff.
  try {
    await migrate();
  } catch (err) {
    console.error(`[engram] FATAL: cannot reach/migrate database: ${(err as Error).message}`);
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health check — no auth.
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const r = await getPool().query<{ n: string }>("SELECT count(*) n FROM items");
      res.json({ ok: true, items: Number(r.rows[0].n), db: "connected" });
    } catch (err) {
      res.status(503).json({ ok: false, db: "error", error: (err as Error).message });
    }
  });

  // Bearer auth for the MCP endpoint.
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== `Bearer ${config.auth_token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  // Stateless Streamable HTTP: a fresh server+transport per request. The pg pool
  // is a module-level singleton, so this is cheap and avoids session bookkeeping.
  const handleMcp = async (req: Request, res: Response) => {
    const server = buildMcpServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[engram] MCP request error: ${(err as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  };

  app.post("/mcp", auth, handleMcp);
  // Stateless mode does not use long-lived GET streams or session teardown.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ error: "method not allowed" });
  };
  app.get("/mcp", auth, methodNotAllowed);
  app.delete("/mcp", auth, methodNotAllowed);

  const httpServer = app.listen(config.port, () => {
    console.log(`[engram] listening on :${config.port} (MCP at /mcp, health at /health)`);
  });

  const shutdown = async () => {
    console.log("[engram] shutting down");
    httpServer.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(`[engram] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
