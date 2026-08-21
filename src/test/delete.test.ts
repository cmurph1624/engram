import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { initPool, getPool, closePool } from "../db.js";
import { migrate } from "../migrate.js";
import {
  insertItem,
  insertRubricPoint,
  insertReview,
  insertPointScore,
  setRubricPointStatus,
  getItem,
  getRubricPoints,
} from "../repo.js";
import { writeNote, readNote, walkSrsNotes } from "../vault.js";
import { renderNote, parseNote } from "../notes.js";
import { deleteItemCascade } from "../deletion.js";

let vault: string;

/**
 * parent (with a note) — two rubric points, one review with scores, and a
 * split child spawned off point two. A second untouched item guards against
 * over-deletion.
 */
async function seed(notePath: string | null): Promise<void> {
  const pool = getPool();
  await insertItem(
    {
      id: "d_parent",
      type: "explanation",
      note_path: notePath,
      title: "Parent",
      prompt: "Explain the parent.",
      due: new Date("2026-08-01T00:00:00Z"),
    },
    pool
  );
  await insertRubricPoint({ id: "d_p1", item_id: "d_parent", ord: 0, text: "one" }, pool);
  await insertRubricPoint({ id: "d_p2", item_id: "d_parent", ord: 1, text: "two" }, pool);
  await insertReview({ id: "d_r1", item_id: "d_parent", rating: 1 }, pool);
  await insertPointScore({ review_id: "d_r1", point_id: "d_p1", score: "hit" }, pool);
  await insertPointScore({ review_id: "d_r1", point_id: "d_p2", score: "miss" }, pool);

  // the miss split point two off into a child
  await setRubricPointStatus("d_p2", "split", pool);
  await insertItem(
    {
      id: "d_child",
      type: "explanation",
      parent_item_id: "d_parent",
      source_point_id: "d_p2",
      title: "Parent — two",
      prompt: "Explain: two (in the context of Parent)",
      due: new Date("2026-08-02T00:00:00Z"),
    },
    pool
  );
  await insertRubricPoint({ id: "d_c1", item_id: "d_child", ord: 0, text: "two" }, pool);
  await insertReview({ id: "d_r2", item_id: "d_child", rating: 3 }, pool);
  await insertPointScore({ review_id: "d_r2", point_id: "d_c1", score: "hit" }, pool);

  await insertItem(
    {
      id: "d_other",
      type: "fact",
      title: "Untouched",
      prompt: "Still here?",
      answer: "yes",
      due: new Date("2026-08-03T00:00:00Z"),
    },
    pool
  );
  await insertRubricPoint({ id: "d_o1", item_id: "d_other", ord: 0, text: "other" }, pool);
  await insertReview({ id: "d_r3", item_id: "d_other", rating: 4 }, pool);
  await insertPointScore({ review_id: "d_r3", point_id: "d_o1", score: "hit" }, pool);
}

async function count(table: string, where: string, vals: unknown[]): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) n FROM ${table} WHERE ${where}`,
    vals
  );
  return Number(rows[0].n);
}

before(async () => {
  const cfg = loadConfig();
  initPool(cfg.test_database_url);
  await migrate();
  vault = mkdtempSync(join(tmpdir(), "engram-delete-"));
});

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE"
  );
});

after(async () => {
  await closePool();
});

test("deletes the item with its rubric points, reviews and point scores", async () => {
  await seed(null);
  const res = await deleteItemCascade("d_parent", vault);
  assert.equal(res.ok, true);

  assert.equal(await getItem("d_parent"), null);
  assert.equal(await count("rubric_points", "item_id = $1", ["d_parent"]), 0);
  assert.equal(await count("reviews", "item_id = $1", ["d_parent"]), 0);
  assert.equal(await count("point_scores", "review_id = $1", ["d_r1"]), 0);
});

test("leaves unrelated items completely alone", async () => {
  await seed(null);
  await deleteItemCascade("d_parent", vault);

  assert.ok(await getItem("d_other"));
  assert.equal(await count("rubric_points", "item_id = $1", ["d_other"]), 1);
  assert.equal(await count("reviews", "item_id = $1", ["d_other"]), 1);
  assert.equal(await count("point_scores", "review_id = $1", ["d_r3"]), 1);
});

test("deleting a parent takes its split children with it", async () => {
  await seed(null);
  const res = await deleteItemCascade("d_parent", vault);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual([...res.deleted].sort(), ["d_child", "d_parent"]);

  assert.equal(await getItem("d_child"), null);
  assert.equal(await count("rubric_points", "item_id = $1", ["d_child"]), 0);
  assert.equal(await count("reviews", "item_id = $1", ["d_child"]), 0);
  assert.equal(await count("point_scores", "review_id = $1", ["d_r2"]), 0);
});

test("deleting a split child restores the parent's rubric point to active", async () => {
  await seed(null);
  const res = await deleteItemCascade("d_child", vault);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.deleted, ["d_child"]);
  assert.equal(res.restored_point_id, "d_p2");

  const points = await getRubricPoints("d_parent");
  assert.equal(points.find((p) => p.id === "d_p2")!.status, "active");
  assert.ok(await getItem("d_parent"), "the parent survives");
});

test("deleting a parent reports no restored point (its points are gone anyway)", async () => {
  await seed(null);
  const res = await deleteItemCascade("d_parent", vault);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.restored_point_id, null);
});

test("unflags the concept note instead of refusing, and deletes the row", async () => {
  const rel = "Concepts/Unflag Me.md";
  writeNote(
    vault,
    rel,
    renderNote({
      srs_id: "d_parent",
      srs_type: "explanation",
      title: "Unflag Me",
      date: "2026-06-06",
      compression: "my own words, which must survive",
      prompt: "Explain the parent.",
      rubric_points: ["one", "two"],
    })
  );
  await seed(rel);

  const res = await deleteItemCascade("d_parent", vault);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.unflagged_note, rel);
  assert.equal(await getItem("d_parent"), null);

  // the file survives, no longer advertises itself to scan_vault, and keeps the writing
  const after = readNote(vault, rel);
  assert.equal(parseNote(after).srs, false);
  assert.match(after, /my own words, which must survive/);
  assert.match(after, /# Unflag Me/);
});

test("an unflagged note is invisible to a vault walk, so it cannot resurrect", async () => {
  const rel = "Concepts/Gone For Good.md";
  writeNote(
    vault,
    rel,
    renderNote({
      srs_id: "d_parent",
      srs_type: "fact",
      title: "Gone For Good",
      date: "2026-06-06",
      compression: "c",
      prompt: "q",
      answer: "a",
    })
  );
  await seed(rel);
  await deleteItemCascade("d_parent", vault);

  const walked = walkSrsNotes(vault).map((n) => n.relPath);
  assert.equal(walked.includes(rel), false, "scan_vault must not see it again");
});

test("deletes when note_path is set but the file is gone", async () => {
  await seed("Concepts/Never Synced.md");
  const res = await deleteItemCascade("d_parent", vault);
  assert.equal(res.ok, true);
  assert.equal(await getItem("d_parent"), null);
});

test("an unknown id reports not_found", async () => {
  await seed(null);
  const res = await deleteItemCascade("nope", vault);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, "not_found");
});
