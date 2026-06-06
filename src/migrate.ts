import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { getPool, withTransaction } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** Parse leading integer version from a filename like "001_init.sql". */
function versionOf(filename: string): number {
  const m = filename.match(/^(\d+)/);
  if (!m) throw new Error(`Migration file has no numeric prefix: ${filename}`);
  return parseInt(m[1], 10);
}

/**
 * Apply any migration files whose version exceeds the current schema version.
 * Idempotent: re-running with no new files is a no-op. Each migration + its
 * version bump run together in one transaction.
 */
export async function migrate(p: pg.Pool = getPool()): Promise<number[]> {
  await p.query(
    `CREATE TABLE IF NOT EXISTS meta (
       id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       version INTEGER NOT NULL DEFAULT 0
     )`
  );
  await p.query(`INSERT INTO meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);

  const { rows } = await p.query<{ version: number }>(`SELECT version FROM meta WHERE id = 1`);
  const current = rows[0]?.version ?? 0;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => versionOf(a) - versionOf(b));

  const applied: number[] = [];
  for (const file of files) {
    const version = versionOf(file);
    if (version <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(`UPDATE meta SET version = $1 WHERE id = 1`, [version]);
    }, p);
    applied.push(version);
  }
  return applied;
}
