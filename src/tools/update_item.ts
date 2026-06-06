import { z } from "zod";
import { nanoid } from "nanoid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db.js";
import { getItem, getRubricPoints, setRubricPointStatus, insertRubricPoint } from "../repo.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, _config: Config): void {
  server.tool(
    "update_item",
    "Edit an item's fields in the DB (mainly to refine an auto-spawned child's prompt). Does NOT edit the concept note — if the item has a note, edit it to match (or run scan_vault). Replacing rubric_points retires the current active points and adds the new ones.",
    {
      item_id: z.string(),
      prompt: z.string().optional(),
      trap: z.string().optional(),
      followup: z.string().optional(),
      answer: z.string().optional(),
      status: z.enum(["active", "retired"]).optional(),
      rubric_points: z.array(z.string()).optional(),
    },
    async (a) => {
      logToolCall("update_item", { item_id: a.item_id });
      const item = await getItem(a.item_id);
      if (!item) return errorResult(`item not found: ${a.item_id}`);

      const sets: string[] = [];
      const vals: unknown[] = [a.item_id];
      const add = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (a.prompt !== undefined) add("prompt", a.prompt);
      if (a.trap !== undefined) add("trap", a.trap);
      if (a.followup !== undefined) add("followup", a.followup);
      if (a.answer !== undefined) add("answer", a.answer);
      if (a.status !== undefined) add("status", a.status);

      await withTransaction(async (client) => {
        if (sets.length) {
          await client.query(`UPDATE items SET ${sets.join(", ")} WHERE id = $1`, vals);
        }
        if (a.rubric_points !== undefined) {
          const existing = await getRubricPoints(a.item_id, client);
          for (const p of existing) {
            if (p.status === "active") await setRubricPointStatus(p.id, "retired", client);
          }
          for (let i = 0; i < a.rubric_points.length; i++) {
            await insertRubricPoint(
              { id: nanoid(), item_id: a.item_id, ord: i, text: a.rubric_points[i] },
              client
            );
          }
        }
      });

      return json({
        id: a.item_id,
        updated: true,
        warning: item.note_path
          ? `This item has a concept note (${item.note_path}). Edit the note to match, or run scan_vault.`
          : null,
      });
    }
  );
}
