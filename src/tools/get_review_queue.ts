import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getActiveItems } from "../repo.js";
import { buildQueue, type QueueCandidate } from "../scheduler.js";
import { json, logToolCall } from "./util.js";

export function register(server: McpServer, config: Config): void {
  server.tool(
    "get_review_queue",
    "Get the priority-ordered, time-boxed list of items to review now. Returns ONLY id/type/title/prompt/estimated_minutes/due/days_overdue — never answers, rubrics, traps, or follow-ups. The user must answer each prompt cold before reveal_item is called.",
    {
      time_budget_minutes: z
        .number()
        .positive()
        .optional()
        .describe("Minutes available for this session. Defaults to the configured time box."),
    },
    async ({ time_budget_minutes }) => {
      const budget = time_budget_minutes ?? config.default_time_budget_minutes;
      const items = await getActiveItems();
      const candidates: QueueCandidate[] = items.map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        prompt: i.prompt,
        due: i.due,
        stability: i.stability,
        difficulty: i.difficulty,
        reps: i.reps,
        lapses: i.lapses,
        fsrs_state: i.fsrs_state,
        last_review: i.last_review,
      }));
      const queue = buildQueue(
        candidates,
        new Date(),
        budget,
        config.cost_estimates_minutes,
        config.fsrs.request_retention
      );
      logToolCall("get_review_queue", { budget, returned: queue });
      return json({ time_budget_minutes: budget, queue });
    }
  );
}
