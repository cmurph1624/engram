import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { getPool } from "./db.js";
import { registerAllTools } from "./tools/index.js";
import { loadCards, isBrowseAuthorized, BROWSE_COOKIE } from "./browse.js";
import { deleteItemCascade } from "./deletion.js";
import { BROWSE_HTML } from "./browse-page.js";

function buildMcpServer(config: Config): McpServer {
  const server = new McpServer({ name: "engram", version: "2.0.0" });
  registerAllTools(server, config);
  return server;
}

/**
 * Build the HTTP app. Kept separate from server.ts so tests can mount it on an
 * ephemeral port without booting the daemon (server.ts calls main() on import).
 * Assumes the pg pool is already initialised.
 */
export function createApp(config: Config): express.Express {
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

  // --- Read-only card browser ----------------------------------------------
  // Same secret as /mcp, but a browser cannot set an Authorization header on a
  // plain navigation: `?token=` is accepted once and remembered in a cookie.
  // These routes never write to the DB or the vault.
  const browseAuth = (req: Request, res: Response, next: NextFunction) => {
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const ok = isBrowseAuthorized(
      { authorization: req.headers.authorization, cookie: req.headers.cookie, queryToken },
      config.auth_token
    );
    if (!ok) {
      res
        .status(401)
        .type("text/plain")
        .send("unauthorized — open /browse?token=<auth_token> once, then the cookie carries it");
      return;
    }
    if (queryToken) {
      res.cookie(BROWSE_COOKIE, queryToken, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }
    next();
  };

  app.get("/browse", browseAuth, (req: Request, res: Response) => {
    // Bounce once to drop the token out of the URL bar and history.
    if (req.query.token) {
      res.redirect("/browse");
      return;
    }
    res.type("html").send(BROWSE_HTML);
  });

  app.get("/api/cards", browseAuth, async (_req: Request, res: Response) => {
    try {
      const cards = await loadCards(config.vault_path);
      res.json({ count: cards.length, cards });
    } catch (err) {
      console.error(`[engram] /api/cards error: ${(err as Error).message}`);
      res.status(500).json({ error: "could not load cards" });
    }
  });

  // Destructive, and reachable with the browse cookie — the cookie is
  // SameSite=Lax and no CORS headers are set, so another origin cannot fire it.
  app.delete("/api/cards/:id", browseAuth, async (req: Request, res: Response) => {
    try {
      const result = await deleteItemCascade(req.params.id, config.vault_path);
      if (result.ok) {
        console.log(`[engram] deleted ${result.deleted.join(", ")}`);
        res.json({ deleted: result.deleted, restored_point_id: result.restored_point_id });
        return;
      }
      if (result.reason === "not_found") {
        res.status(404).json({ error: "item not found" });
        return;
      }
      res.status(409).json({ error: "note_present", note_path: result.note_path });
    } catch (err) {
      console.error(`[engram] delete error: ${(err as Error).message}`);
      res.status(500).json({ error: "could not delete item" });
    }
  });

  return app;
}
