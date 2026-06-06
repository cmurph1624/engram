import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getItem, getRubricPoints } from "../repo.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, _config: Config): void {
  server.tool(
    "reveal_item",
    "Reveal the full item — rubric points (with ids and statuses), answer, trap, and follow-up. Call this ONLY after the user has typed their answer cold, so grading can begin.",
    {
      item_id: z.string().describe("The item id from the review queue."),
    },
    async ({ item_id }) => {
      logToolCall("reveal_item", { item_id });
      const item = await getItem(item_id);
      if (!item) return errorResult(`item not found: ${item_id}`);
      const points = await getRubricPoints(item_id);
      return json({
        id: item.id,
        type: item.type,
        title: item.title,
        prompt: item.prompt,
        answer: item.answer,
        trap: item.trap,
        followup: item.followup,
        rubric_points: points.map((p) => ({ id: p.id, ord: p.ord, text: p.text, status: p.status })),
      });
    }
  );
}
