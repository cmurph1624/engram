import pg from "pg";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";

/** Pool pointed at engram_test. Caller is responsible for ending it. */
export function testPool(): pg.Pool {
  const cfg = loadConfig();
  const url = cfg.test_database_url;
  if (!url) throw new Error("config.test_database_url is not set");
  return createPool(url);
}

/** Drop every Engram table for a clean slate. */
export async function resetSchema(p: pg.Pool): Promise<void> {
  await p.query(`
    DROP TABLE IF EXISTS point_scores CASCADE;
    DROP TABLE IF EXISTS reviews CASCADE;
    DROP TABLE IF EXISTS rubric_points CASCADE;
    DROP TABLE IF EXISTS items CASCADE;
    DROP TABLE IF EXISTS meta CASCADE;
  `);
}

/** Truncate data tables but keep schema (faster between tests). */
export async function truncateAll(p: pg.Pool): Promise<void> {
  await p.query(`TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE`);
}
