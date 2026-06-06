import pg from "pg";
const { Pool } = pg;
import type { PoolClient } from "pg";

let pool: pg.Pool | null = null;

/** Initialize the shared pool. Call once at server boot. */
export function initPool(connectionString: string): pg.Pool {
  if (pool) return pool;
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

/** Create an independent pool (used by tests against engram_test). Caller closes it. */
export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString, max: 5 });
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("DB pool not initialized — call initPool() first");
  return pool;
}

/**
 * Run `fn` inside a transaction on the given pool (defaults to the shared pool).
 * Commits on success, rolls back on any throw, always releases the client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  p: pg.Pool = getPool()
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure; original error is what matters */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
