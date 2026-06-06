import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import type { Grade } from "ts-fsrs";
import type { Config } from "./config.js";
import type { Score } from "./types.js";
import { deriveRating, schedule, type FsrsColumns } from "./fsrs.js";
import { applySplit, checkChildRetirement } from "./splits.js";
import {
  getItemForUpdate,
  getRubricPoints,
  updateItemFsrs,
  insertReview,
  insertPointScore,
} from "./repo.js";

export interface RecordReviewInput {
  item_id: string;
  // explanation / project
  point_scores?: { point_id: string; score: Score }[];
  effortless?: boolean;
  splits?: { point_id: string; prompt: string }[];
  // fact (validated 1-4 at the tool boundary)
  rating?: number;
}

export interface RecordReviewResult {
  next_due: Date;
  interval_days: number;
  splits_created: { id: string; title: string }[];
  child_retired: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * Record one review and apply all of its consequences inside the caller's
 * transaction: derive the FSRS rating, reschedule the item, persist the review
 * (+ per-point scores), spawn split children for missed points (parents only),
 * and retire a child that has hit its consecutive-Good streak.
 */
export async function recordReview(
  client: PoolClient,
  config: Config,
  input: RecordReviewInput,
  now: Date
): Promise<RecordReviewResult> {
  const item = await getItemForUpdate(input.item_id, client);
  if (!item) throw new Error(`item not found: ${input.item_id}`);
  if (item.status !== "active") throw new Error(`item is not active: ${input.item_id}`);

  const retention = config.fsrs.request_retention;
  const before: FsrsColumns = {
    due: item.due,
    stability: item.stability,
    difficulty: item.difficulty,
    reps: item.reps,
    lapses: item.lapses,
    fsrs_state: item.fsrs_state,
    last_review: item.last_review,
  };

  let rating: Grade;
  const pointScores = input.point_scores ?? [];

  if (item.type === "fact") {
    if (!input.rating) throw new Error("fact review requires `rating` (1-4)");
    rating = input.rating as Grade;
  } else {
    rating = deriveRating(
      pointScores.map((p) => p.score),
      input.effortless ?? false
    );
  }

  // reschedule
  const next = schedule(before, rating, now, retention);
  await updateItemFsrs(item.id, next, client);

  // persist the review and any per-point scores
  const reviewId = nanoid();
  await insertReview({ id: reviewId, item_id: item.id, rating }, client);
  for (const ps of pointScores) {
    await insertPointScore({ review_id: reviewId, point_id: ps.point_id, score: ps.score }, client);
  }

  // split mechanics — parents only (a child must not spawn grandchildren)
  const splits_created: { id: string; title: string }[] = [];
  if (item.type !== "fact" && item.parent_item_id === null) {
    const missed = pointScores.filter((p) => p.score === "miss");
    if (missed.length) {
      const points = await getRubricPoints(item.id, client);
      const byId = new Map(points.map((p) => [p.id, p]));
      const overrides = new Map((input.splits ?? []).map((s) => [s.point_id, s.prompt]));
      for (const m of missed) {
        const point = byId.get(m.point_id);
        if (!point) continue;
        const child = await applySplit(client, item, point, overrides.get(m.point_id), now);
        splits_created.push(child);
      }
    }
  }

  // retirement — children only
  let child_retired = false;
  if (item.parent_item_id !== null) {
    child_retired = await checkChildRetirement(client, item, config.child_retirement_streak);
  }

  const interval_days = Math.round((next.due.getTime() - now.getTime()) / MS_PER_DAY);
  return { next_due: next.due, interval_days, splits_created, child_retired };
}
