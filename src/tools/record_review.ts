import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db.js";
import { recordReview } from "../review.js";
import { json, errorResult, logToolCall } from "./util.js";

export function register(server: McpServer, config: Config): void {
  server.tool(
    "record_review",
    "Record the result of one review and apply scheduling. For explanation/project items pass per-point scores (hit/partial/miss); the FSRS rating is derived from the worst surviving point. For fact items pass the rating (1-4) directly. A missed point spawns a fast-clock child; a child that hits its consecutive-Good streak retires.",
    {
      item_id: z.string(),
      point_scores: z
        .array(
          z.object({
            point_id: z.string(),
            score: z.enum(["hit", "partial", "miss"]),
          })
        )
        .optional()
        .describe("Explanation/project items: one entry per active rubric point."),
      effortless: z
        .boolean()
        .optional()
        .describe("Explanation/project: true if all points were hit with no effort (-> Easy)."),
      splits: z
        .array(z.object({ point_id: z.string(), prompt: z.string() }))
        .optional()
        .describe("Optional custom child prompts for missed points."),
      rating: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Fact items only: FSRS rating 1=Again 2=Hard 3=Good 4=Easy."),
    },
    async (input) => {
      logToolCall("record_review", { item_id: input.item_id });
      try {
        const result = await withTransaction((client) =>
          recordReview(client, config, input, new Date())
        );
        return json({
          next_due: result.next_due.toISOString(),
          interval_days: result.interval_days,
          splits_created: result.splits_created,
          child_retired: result.child_retired,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );
}
