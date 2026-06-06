import { State } from "ts-fsrs";
import { retrievability, type FsrsColumns } from "./fsrs.js";

export type ItemType = "fact" | "explanation" | "project";
export type CostEstimates = Record<ItemType, number>;

export interface QueueCandidate extends FsrsColumns {
  id: string;
  type: ItemType;
  title: string;
  prompt: string;
}

export interface QueueEntry {
  id: string;
  type: ItemType;
  title: string;
  prompt: string;
  estimated_minutes: number;
  due: Date;
  days_overdue: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Priority for queue ordering:
 *   priority = (1 - retrievability) * (1 + lapses / max(reps, 1))
 * New / never-reviewed items get a fixed 0.5 (their retrievability is undefined).
 */
export function computePriority(
  c: QueueCandidate,
  now: Date,
  requestRetention: number
): number {
  if (c.fsrs_state === State.New || c.last_review === null) return 0.5;
  const r = retrievability(c, now, requestRetention);
  return (1 - r) * (1 + c.lapses / Math.max(c.reps, 1));
}

function daysOverdue(due: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY));
}

/**
 * Greedily fill a time box by priority. Items are considered highest-priority
 * first; each is included if its cost estimate fits the remaining budget, else
 * skipped (smaller lower-priority items can still fit afterwards). The total
 * estimated time never exceeds the budget.
 */
export function buildQueue(
  candidates: QueueCandidate[],
  now: Date,
  budgetMinutes: number,
  costs: CostEstimates,
  requestRetention: number
): QueueEntry[] {
  const ranked = candidates
    .map((c) => ({ c, priority: computePriority(c, now, requestRetention) }))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // tie-break: most overdue first
      return a.c.due.getTime() - b.c.due.getTime();
    });

  const queue: QueueEntry[] = [];
  let remaining = budgetMinutes;
  for (const { c } of ranked) {
    const cost = costs[c.type];
    if (cost > remaining) continue;
    remaining -= cost;
    queue.push({
      id: c.id,
      type: c.type,
      title: c.title,
      prompt: c.prompt,
      estimated_minutes: cost,
      due: c.due,
      days_overdue: daysOverdue(c.due, now),
    });
  }
  return queue;
}
