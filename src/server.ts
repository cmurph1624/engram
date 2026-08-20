import { loadConfig } from "./config.js";
import { initPool, closePool } from "./db.js";
import { migrate } from "./migrate.js";
import { createApp } from "./app.js";

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

  const app = createApp(config);

  const httpServer = app.listen(config.port, () => {
    console.log(
      `[engram] listening on :${config.port} (MCP at /mcp, cards at /browse, health at /health)`
    );
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
