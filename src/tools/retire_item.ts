import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db.js";
import { getItem, setItemStatus, getChildren } from "../repo.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, _config: Config): void {
  server.tool(
    "retire_item",
    "Retire an item so it no longer appears in the review queue. Retiring a parent also retires its split children.",
    {
      item_id: z.string(),
    },
    async ({ item_id }) => {
      logToolCall("retire_item", { item_id });
      const item = await getItem(item_id);
      if (!item) return errorResult(`item not found: ${item_id}`);

      const retired: string[] = [item_id];
      await withTransaction(async (client) => {
        await setItemStatus(item_id, "retired", client);
        for (const child of await getChildren(item_id, client)) {
          if (child.status !== "retired") {
            await setItemStatus(child.id, "retired", client);
            retired.push(child.id);
          }
        }
      });
      return json({ retired });
    }
  );
}
