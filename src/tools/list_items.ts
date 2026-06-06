import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getPool } from "../db.js";
import type { ItemRow } from "../types.js";
import { json, logToolCall } from "./util.js";

export function register(server: McpServer, _config: Config): void {
  server.tool(
    "list_items",
    "List item summaries (id, type, status, title, due, reps, lapses, parent) with optional filters.",
    {
      status: z.enum(["active", "retired"]).optional(),
      type: z.enum(["fact", "explanation", "project"]).optional(),
      parent_item_id: z.string().optional(),
      search: z.string().optional().describe("Case-insensitive substring match on title/prompt."),
    },
    async (a) => {
      logToolCall("list_items", {});
      const where: string[] = [];
      const vals: unknown[] = [];
      const add = (column: string, op: string, v: unknown) => {
        vals.push(v);
        where.push(`${column} ${op} $${vals.length}`);
      };
      if (a.status) add("status", "=", a.status);
      if (a.type) add("type", "=", a.type);
      if (a.parent_item_id) add("parent_item_id", "=", a.parent_item_id);
      if (a.search) {
        vals.push(`%${a.search}%`);
        where.push(`(title ILIKE $${vals.length} OR prompt ILIKE $${vals.length})`);
      }

      const sql =
        `SELECT id, type, status, title, due, reps, lapses, parent_item_id FROM items` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY due ASC LIMIT 200`;
      const { rows } = await getPool().query<ItemRow>(sql, vals);
      return json({
        count: rows.length,
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          status: r.status,
          title: r.title,
          due: r.due,
          reps: r.reps,
          lapses: r.lapses,
          parent_item_id: r.parent_item_id,
        })),
      });
    }
  );
}
