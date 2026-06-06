import { test } from "node:test";
import assert from "node:assert/strict";
import { Rating, State, createEmptyCard } from "ts-fsrs";
import { deriveRating, schedule, retrievability, type FsrsColumns } from "../fsrs.js";

const RETENTION = 0.9;

function freshState(now: Date): FsrsColumns {
  const c = createEmptyCard(now);
  return {
    due: c.due,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    fsrs_state: State.New,
    last_review: null,
  };
}

test("deriveRating: any miss -> Again", () => {
  assert.equal(deriveRating(["hit", "miss", "hit"]), Rating.Again);
  assert.equal(deriveRating(["miss"]), Rating.Again);
  assert.equal(deriveRating(["partial", "miss"]), Rating.Again);
});

test("deriveRating: any partial (no miss) -> Hard", () => {
  assert.equal(deriveRating(["hit", "partial"]), Rating.Hard);
  assert.equal(deriveRating(["partial"]), Rating.Hard);
});

test("deriveRating: all hit -> Good", () => {
  assert.equal(deriveRating(["hit", "hit", "hit"]), Rating.Good);
});

test("deriveRating: all hit + effortless -> Easy", () => {
  assert.equal(deriveRating(["hit", "hit"], true), Rating.Easy);
});

test("deriveRating: effortless only upgrades a clean answer", () => {
  assert.equal(deriveRating(["hit", "partial"], true), Rating.Hard);
  assert.equal(deriveRating(["miss"], true), Rating.Again);
});

test("deriveRating: empty (no surviving points) defaults to Good", () => {
  assert.equal(deriveRating([]), Rating.Good);
});

test("schedule: a Good review advances due into the future and increments reps", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  const next = schedule(freshState(now), Rating.Good, now, RETENTION);
  assert.equal(next.reps, 1);
  assert.ok(next.due.getTime() > now.getTime(), "due should be in the future");
  assert.ok(typeof next.stability === "number" && next.stability! > 0);
  assert.ok(typeof next.difficulty === "number");
  assert.equal(next.last_review!.getTime(), now.getTime());
});

test("schedule: an Again review on a learned card records a lapse", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  // bring the card into Review state with two Good reviews a few days apart
  let s = schedule(freshState(now), Rating.Good, now, RETENTION);
  s = schedule(s, Rating.Good, new Date("2026-06-07T12:00:00Z"), RETENTION);
  const before = s.lapses;
  const lapsed = schedule(s, Rating.Again, new Date("2026-06-20T12:00:00Z"), RETENTION);
  assert.ok(lapsed.lapses >= before + 1, "lapses should increase on a forgotten review");
});

test("schedule: a review recorded 10 days late schedules sensibly (no crash, future due)", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  let s = schedule(freshState(now), Rating.Good, now, RETENTION);
  s = schedule(s, Rating.Good, new Date("2026-06-08T12:00:00Z"), RETENTION);
  const late = new Date("2026-06-25T12:00:00Z"); // well past due
  const next = schedule(s, Rating.Good, late, RETENTION);
  assert.ok(next.due.getTime() > late.getTime(), "next due is after the late review time");
  assert.ok(next.stability! >= s.stability!, "stability should not collapse on a passed late review");
});

test("retrievability: decays over time and stays within [0,1]", () => {
  const now = new Date("2026-06-06T12:00:00Z");
  const s = schedule(freshState(now), Rating.Good, now, RETENTION);
  const rSoon = retrievability(s, new Date("2026-06-07T12:00:00Z"), RETENTION);
  const rLater = retrievability(s, new Date("2026-07-06T12:00:00Z"), RETENTION);
  assert.ok(rSoon >= 0 && rSoon <= 1);
  assert.ok(rLater >= 0 && rLater <= 1);
  assert.ok(rLater < rSoon, "retrievability should decay as time passes");
});
