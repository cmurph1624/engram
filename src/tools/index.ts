import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { register as getReviewQueue } from "./get_review_queue.js";
import { register as revealItem } from "./reveal_item.js";
import { register as recordReviewTool } from "./record_review.js";
import { register as createItem } from "./create_item.js";
import { register as updateItem } from "./update_item.js";
import { register as retireItem } from "./retire_item.js";
import { register as listItems } from "./list_items.js";
import { register as getStats } from "./get_stats.js";
import { register as scanVault } from "./scan_vault.js";

export function registerAllTools(server: McpServer, config: Config): void {
  getReviewQueue(server, config);
  revealItem(server, config);
  recordReviewTool(server, config);
  createItem(server, config);
  updateItem(server, config);
  retireItem(server, config);
  listItems(server, config);
  getStats(server, config);
  scanVault(server, config);
}
