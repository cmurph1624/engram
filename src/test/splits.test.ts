import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { nanoid } from "nanoid";
import { Rating } from "ts-fsrs";
import { migrate } from "../migrate.js";
import { withTransaction } from "../db.js";
import { loadConfig } from "../config.js";
import { recordReview } from "../review.js";
import { composeSplitTitle, TITLE_MAX } from "../splits.js";
import {
  insertItem,
  insertRubricPoint,
  getItem,
  getRubricPoints,
  getChildren,
} from "../repo.js";
import { testPool, resetSchema, truncateAll } from "./helpers.js";

const NOW = new Date("2026-06-06T12:00:00Z");
const config = loadConfig();
let p: pg.Pool;

before(async () => {
  p = testPool();
  await resetSchema(p);
  await migrate(p);
});
beforeEach(async () => {
  await truncateAll(p);
});
after(async () => {
  await p.end();
});

async function makeParent(): Promise<{ id: string; pointIds: string[] }> {
  const id = nanoid();
  const pointIds = [nanoid(), nanoid(), nanoid()];
  await withTransaction(async (c) => {
    await insertItem(
      { id, type: "explanation", title: "Webhook Retries", prompt: "Explain it.", due: NOW },
      c
    );
    await insertRubricPoint({ id: pointIds[0], item_id: id, ord: 0, text: "failure mode" }, c);
    await insertRubricPoint({ id: pointIds[1], item_id: id, ord: 1, text: "backoff + jitter" }, c);
    await insertRubricPoint({ id: pointIds[2], item_id: id, ord: 2, text: "idempotency" }, c);
  }, p);
  return { id, pointIds };
}

test("a miss splits the point, spawns a child, and rates the parent Again", async () => {
  const { id, pointIds } = await makeParent();

  const result = await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        {
          item_id: id,
          point_scores: [
            { point_id: pointIds[0], score: "hit" },
            { point_id: pointIds[1], score: "miss" },
            { point_id: pointIds[2], score: "hit" },
          ],
        },
        NOW
      ),
    p
  );

  assert.equal(result.splits_created.length, 1);
  assert.equal(result.child_retired, false);

  // the missed point is now split
  const points = await getRubricPoints(id, p);
  const missed = points.find((pt) => pt.id === pointIds[1])!;
  assert.equal(missed.status, "split");

  // a child exists, linked to parent + source point, with one rubric point
  const children = await getChildren(id, p);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.parent_item_id, id);
  assert.equal(child.source_point_id, pointIds[1]);
  assert.equal(child.note_path, null);
  const childPoints = await getRubricPoints(child.id, p);
  assert.equal(childPoints.length, 1);
  assert.equal(childPoints[0].text, "backoff + jitter");

  // parent was rated Again and rescheduled
  const parent = await getItem(id, p);
  assert.equal(parent!.reps, 1);
  assert.ok(parent!.last_review !== null);
});

test("a child retires after the configured consecutive-Good streak; its point reactivates", async () => {
  const { id, pointIds } = await makeParent();
  await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: id, point_scores: [{ point_id: pointIds[1], score: "miss" }] },
        NOW
      ),
    p
  );
  const child = (await getChildren(id, p))[0];
  const cPoint = (await getRubricPoints(child.id, p))[0];

  // first Good — not yet retired (streak is 2)
  const r1 = await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: child.id, point_scores: [{ point_id: cPoint.id, score: "hit" }] },
        new Date("2026-06-07T12:00:00Z")
      ),
    p
  );
  assert.equal(r1.child_retired, false);

  // second consecutive Good — retires
  const r2 = await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: child.id, point_scores: [{ point_id: cPoint.id, score: "hit" }] },
        new Date("2026-06-10T12:00:00Z")
      ),
    p
  );
  assert.equal(r2.child_retired, true);

  const retiredChild = await getItem(child.id, p);
  assert.equal(retiredChild!.status, "retired");

  // the parent's source point is active again
  const points = await getRubricPoints(id, p);
  assert.equal(points.find((pt) => pt.id === pointIds[1])!.status, "active");
});

test("a child does not spawn grandchildren on a miss", async () => {
  const { id, pointIds } = await makeParent();
  await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: id, point_scores: [{ point_id: pointIds[0], score: "miss" }] },
        NOW
      ),
    p
  );
  const child = (await getChildren(id, p))[0];
  const cPoint = (await getRubricPoints(child.id, p))[0];

  const r = await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: child.id, point_scores: [{ point_id: cPoint.id, score: "miss" }] },
        new Date("2026-06-07T12:00:00Z")
      ),
    p
  );
  assert.equal(r.splits_created.length, 0, "children must not split further");
});

test("a streak broken by a miss does not retire", async () => {
  const { id, pointIds } = await makeParent();
  await withTransaction(
    (c) =>
      recordReview(
        c,
        config,
        { item_id: id, point_scores: [{ point_id: pointIds[1], score: "miss" }] },
        NOW
      ),
    p
  );
  const child = (await getChildren(id, p))[0];
  const cPoint = (await getRubricPoints(child.id, p))[0];
  const dates = ["2026-06-07", "2026-06-08", "2026-06-09"];
  const scores: ("hit" | "miss")[] = ["hit", "miss", "hit"];
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(
      await withTransaction(
        (c) =>
          recordReview(
            c,
            config,
            { item_id: child.id, point_scores: [{ point_id: cPoint.id, score: scores[i] }] },
            new Date(`${dates[i]}T12:00:00Z`)
          ),
        p
      )
    );
  }
  // hit, miss, hit -> last two are miss,hit -> not two consecutive Good
  assert.equal(results[2].child_retired, false);
  assert.equal((await getItem(child.id, p))!.status, "active");
});

test("fact items schedule directly from the passed rating", async () => {
  const id = nanoid();
  await withTransaction(
    (c) =>
      insertItem(
        { id, type: "fact", title: "Q", prompt: "What?", answer: "That.", due: NOW },
        c
      ),
    p
  );
  const r = await withTransaction(
    (c) => recordReview(c, config, { item_id: id, rating: Rating.Good }, NOW),
    p
  );
  assert.ok(r.interval_days >= 0);
  assert.equal(r.splits_created.length, 0);
  const item = await getItem(id, p);
  assert.equal(item!.reps, 1);
});

// --- composeSplitTitle ------------------------------------------------------
// A split child's title is `parent — point`, which can overrun the 200-char cap.
// The old `.slice(0, 200)` cut mid-word ("...Claude actually pro"), which reads
// as data loss rather than elision. Cut on a word boundary and mark it elided.

test("composeSplitTitle leaves a short title untouched", () => {
  const title = composeSplitTitle("Webhook Retries", "backoff + jitter");
  assert.equal(title, "Webhook Retries — backoff + jitter");
  assert.ok(!title.includes("…"));
});

test("composeSplitTitle leaves a title of exactly the cap untouched", () => {
  // 3 chars of separator (" — ") + parent + point == exactly TITLE_MAX
  const parent = "p".repeat(100);
  const point = "q".repeat(TITLE_MAX - 100 - 3);
  const title = composeSplitTitle(parent, point);
  assert.equal(title.length, TITLE_MAX);
  assert.ok(!title.endsWith("…"));
});

test("composeSplitTitle cuts on a word boundary and marks the elision", () => {
  // The real card that surfaced this: composes to 205 chars, so the old slice
  // truncated "produces" to "pro".
  const parent = "Goal vs Loop - Completion Condition vs Recurring Check";
  const point =
    "States that the evaluator reads only the transcript, and draws the " +
    "consequence: the condition must be checkable from output Claude actually produces";
  const title = composeSplitTitle(parent, point);

  assert.ok(title.length <= TITLE_MAX, `got ${title.length}`);
  assert.ok(title.endsWith("…"));
  assert.ok(!title.endsWith("pro…"), "must not cut mid-word");
  assert.ok(title.endsWith("actually…"), title);
});

test("composeSplitTitle does not leave a space before the ellipsis", () => {
  const title = composeSplitTitle("A".repeat(190), "bb cc dd ee ff gg hh");
  assert.ok(title.endsWith("…"));
  assert.ok(!title.endsWith(" …"), title);
});

test("composeSplitTitle still caps an unbroken run with no space to cut at", () => {
  const title = composeSplitTitle("Parent", "z".repeat(400));
  assert.ok(title.length <= TITLE_MAX, `got ${title.length}`);
  assert.ok(title.endsWith("…"));
});
