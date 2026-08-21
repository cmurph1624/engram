import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { deleteItemCascade } from "../deletion.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, config: Config): void {
  server.tool(
    "delete_item",
    "Permanently delete an item and everything hanging off it — rubric points, review history, and any split children. IRREVERSIBLE and there is no scheduled backup; prefer retire_item, which takes a card out of circulation but keeps the row and its history. If the item has a concept note, its frontmatter is flipped to `srs: false` so scan_vault cannot re-register it — the note file itself is kept, and its writing is untouched. Deleting a split child on its own restores the parent's rubric point.",
    {
      item_id: z.string(),
    },
    async ({ item_id }) => {
      logToolCall("delete_item", { item_id });
      const res = await deleteItemCascade(item_id, config.vault_path);
      if (!res.ok) {
        if (res.reason === "not_found") return errorResult(`item not found: ${item_id}`);
        return errorResult(
          `could not unflag the concept note at "${res.note_path}" (${res.message}) — nothing was deleted, since a note still marked \`srs: true\` would be re-registered by scan_vault`
        );
      }
      return json({
        deleted: res.deleted,
        restored_point_id: res.restored_point_id,
        unflagged_note: res.unflagged_note,
      });
    }
  );
}
