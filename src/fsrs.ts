import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";

export type PointScore = "hit" | "partial" | "miss";

/** The subset of FSRS state Engram persists in the `items` table. */
export interface FsrsColumns {
  due: Date;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  fsrs_state: number;
  last_review: Date | null;
}

function scheduler(requestRetention: number) {
  // enable_short_term: false — Engram reviews are spaced days apart in a daily
  // time box, never the 1m/10m intra-day learning steps FSRS uses by default.
  // Disabling them sends cards straight to Review state, which also keeps our
  // persisted FSRS columns a lossless representation (no learning_steps to store).
  return fsrs(
    generatorParameters({ request_retention: requestRetention, enable_short_term: false })
  );
}

/**
 * Derive the FSRS rating from the per-point scores of an explanation/project
 * review. Scores passed here are the *surviving* points only (split points are
 * carried by their child and excluded by the caller). Interval is driven by the
 * worst point:
 *   any miss      -> Again (1)
 *   any partial   -> Hard  (2)
 *   all hit       -> Good  (3)
 *   all hit + effortless -> Easy (4)
 * Empty (no surviving points) is treated as a clean pass -> Good.
 */
export function deriveRating(scores: PointScore[], effortless = false): Grade {
  if (scores.some((s) => s === "miss")) return Rating.Again;
  if (scores.some((s) => s === "partial")) return Rating.Hard;
  return effortless ? Rating.Easy : Rating.Good;
}

/** Rebuild a ts-fsrs Card from our stored columns. */
function toCard(state: FsrsColumns, now: Date): Card {
  // New / never-reviewed cards: start from a fresh card at `now`.
  if (state.fsrs_state === State.New || state.last_review === null) {
    return createEmptyCard(now);
  }
  const card = createEmptyCard(state.last_review);
  card.state = state.fsrs_state as State;
  card.stability = state.stability ?? card.stability;
  card.difficulty = state.difficulty ?? card.difficulty;
  card.reps = state.reps;
  card.lapses = state.lapses;
  card.due = state.due;
  card.last_review = state.last_review;
  // elapsed_days/scheduled_days are recomputed by the algorithm from last_review;
  // learning_steps is not persisted (irrelevant once an item reaches Review state).
  return card;
}

function fromCard(card: Card): FsrsColumns {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    fsrs_state: card.state,
    last_review: card.last_review ?? null,
  };
}

/** Apply a rating at time `now`, returning the new persisted FSRS columns. */
export function schedule(
  state: FsrsColumns,
  rating: Grade,
  now: Date,
  requestRetention: number
): FsrsColumns {
  const card = toCard(state, now);
  const { card: next } = scheduler(requestRetention).next(card, now, rating);
  return fromCard(next);
}

/** Current retrievability in [0,1]. New/never-reviewed items return 0. */
export function retrievability(
  state: FsrsColumns,
  now: Date,
  requestRetention: number
): number {
  if (state.fsrs_state === State.New || state.last_review === null) return 0;
  const card = toCard(state, now);
  return scheduler(requestRetention).get_retrievability(card, now, false) as number;
}
