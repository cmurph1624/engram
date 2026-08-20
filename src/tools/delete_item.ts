import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { deleteItemCascade } from "../deletion.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, config: Config): void {
  server.tool(
    "delete_item",
    "Permanently delete an item and everything hanging off it — rubric points, review history, and any split children. IRREVERSIBLE and there is no scheduled backup; prefer retire_item, which takes a card out of circulation but keeps the row and its history. Refuses while the item's concept note still exists in the vault (scan_vault would just re-register it): delete the note in Obsidian first. Deleting a split child on its own restores the parent's rubric point.",
    {
      item_id: z.string(),
    },
    async ({ item_id }) => {
      logToolCall("delete_item", { item_id });
      const res = await deleteItemCascade(item_id, config.vault_path);
      if (!res.ok) {
        if (res.reason === "not_found") return errorResult(`item not found: ${item_id}`);
        return errorResult(
          `item ${item_id} still has a concept note at "${res.note_path}" — delete the note (or remove its \`srs: true\`) in the vault first, then delete the item`
        );
      }
      return json({ deleted: res.deleted, restored_point_id: res.restored_point_id });
    }
  );
}
