import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getPool } from "../db.js";
import { json, logToolCall } from "./util.js";

export function register(server: McpServer, _config: Config): void {
  server.tool(
    "get_stats",
    "Summary statistics for conversation summaries: active items, reviews in the last 7 days, weakest items (highest lapse ratio), items due in the next 7 days, and open splits.",
    {},
    async () => {
      logToolCall("get_stats", {});
      const pool = getPool();

      const [active, reviews7d, weakest, upcoming, splits] = await Promise.all([
        pool.query<{ n: string }>(`SELECT count(*) n FROM items WHERE status = 'active'`),
        pool.query<{ n: string }>(
          `SELECT count(*) n FROM reviews WHERE reviewed_at >= now() - interval '7 days'`
        ),
        pool.query<{ id: string; title: string; lapses: number; reps: number }>(
          `SELECT id, title, lapses, reps FROM items
           WHERE status = 'active' AND reps > 0
           ORDER BY (lapses::float / reps) DESC, lapses DESC LIMIT 5`
        ),
        pool.query<{ n: string }>(
          `SELECT count(*) n FROM items
           WHERE status = 'active' AND due <= now() + interval '7 days'`
        ),
        pool.query<{ n: string }>(`SELECT count(*) n FROM rubric_points WHERE status = 'split'`),
      ]);

      return json({
        active_items: Number(active.rows[0].n),
        reviews_last_7d: Number(reviews7d.rows[0].n),
        weakest: weakest.rows.map((r) => ({
          id: r.id,
          title: r.title,
          lapses: r.lapses,
          reps: r.reps,
          lapse_ratio: r.reps ? Number((r.lapses / r.reps).toFixed(2)) : 0,
        })),
        upcoming_7d: Number(upcoming.rows[0].n),
        splits_open: Number(splits.rows[0].n),
      });
    }
  );
}
