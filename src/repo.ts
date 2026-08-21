import type { PoolClient } from "pg";
import pg from "pg";
import { getPool } from "./db.js";
import type { ItemRow, RubricPointRow, Score } from "./types.js";
import type { SrsType } from "./notes.js";

type Q = PoolClient | pg.Pool;
function q(client?: Q): Q {
  return client ?? getPool();
}

const ITEM_COLS = `id, type, status, parent_item_id, source_point_id, note_path, title,
  prompt, answer, trap, followup, created_at, due, stability, difficulty, reps, lapses,
  fsrs_state, last_review`;

export async function getItem(id: string, client?: Q): Promise<ItemRow | null> {
  const { rows } = await q(client).query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM items WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Lock a single item row inside a transaction. */
export async function getItemForUpdate(id: string, client: PoolClient): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM items WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getItemByNotePath(notePath: string, client?: Q): Promise<ItemRow | null> {
  const { rows } = await q(client).query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM items WHERE note_path = $1`,
    [notePath]
  );
  return rows[0] ?? null;
}

export async function getActiveItems(client?: Q): Promise<ItemRow[]> {
  const { rows } = await q(client).query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM items WHERE status = 'active'`
  );
  return rows;
}

export async function getRubricPoints(itemId: string, client?: Q): Promise<RubricPointRow[]> {
  const { rows } = await q(client).query<RubricPointRow>(
    `SELECT id, item_id, ord, text, status FROM rubric_points WHERE item_id = $1 ORDER BY ord`,
    [itemId]
  );
  return rows;
}

export interface InsertItemInput {
  id: string;
  type: SrsType;
  parent_item_id?: string | null;
  source_point_id?: string | null;
  note_path?: string | null;
  title: string;
  prompt: string;
  answer?: string | null;
  trap?: string | null;
  followup?: string | null;
  due: Date;
}

export async function insertItem(i: InsertItemInput, client: Q): Promise<void> {
  await client.query(
    `INSERT INTO items (id, type, parent_item_id, source_point_id, note_path, title,
       prompt, answer, trap, followup, due, fsrs_state, reps, lapses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0)`,
    [
      i.id,
      i.type,
      i.parent_item_id ?? null,
      i.source_point_id ?? null,
      i.note_path ?? null,
      i.title,
      i.prompt,
      i.answer ?? null,
      i.trap ?? null,
      i.followup ?? null,
      i.due,
    ]
  );
}

export async function insertRubricPoint(
  p: { id: string; item_id: string; ord: number; text: string },
  client: Q
): Promise<void> {
  await client.query(
    `INSERT INTO rubric_points (id, item_id, ord, text) VALUES ($1,$2,$3,$4)`,
    [p.id, p.item_id, p.ord, p.text]
  );
}

export async function setRubricPointStatus(
  pointId: string,
  status: "active" | "split" | "retired",
  client: Q
): Promise<void> {
  await client.query(`UPDATE rubric_points SET status = $2 WHERE id = $1`, [pointId, status]);
}

export interface FsrsUpdate {
  due: Date;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  fsrs_state: number;
  last_review: Date | null;
}

export async function updateItemFsrs(id: string, s: FsrsUpdate, client: Q): Promise<void> {
  await client.query(
    `UPDATE items SET due=$2, stability=$3, difficulty=$4, reps=$5, lapses=$6,
       fsrs_state=$7, last_review=$8 WHERE id = $1`,
    [id, s.due, s.stability, s.difficulty, s.reps, s.lapses, s.fsrs_state, s.last_review]
  );
}

export async function setItemStatus(
  id: string,
  status: "active" | "retired",
  client: Q
): Promise<void> {
  await client.query(`UPDATE items SET status = $2 WHERE id = $1`, [id, status]);
}

export async function insertReview(
  r: { id: string; item_id: string; rating: number },
  client: Q
): Promise<void> {
  await client.query(`INSERT INTO reviews (id, item_id, rating) VALUES ($1,$2,$3)`, [
    r.id,
    r.item_id,
    r.rating,
  ]);
}

export async function insertPointScore(
  s: { review_id: string; point_id: string; score: Score },
  client: Q
): Promise<void> {
  await client.query(
    `INSERT INTO point_scores (review_id, point_id, score) VALUES ($1,$2,$3)`,
    [s.review_id, s.point_id, s.score]
  );
}

/** Most recent N review ratings for an item, newest first. */
export async function recentRatings(itemId: string, n: number, client?: Q): Promise<number[]> {
  const { rows } = await q(client).query<{ rating: number }>(
    `SELECT rating FROM reviews WHERE item_id = $1 ORDER BY reviewed_at DESC LIMIT $2`,
    [itemId, n]
  );
  return rows.map((r) => r.rating);
}

export async function getChildren(parentId: string, client?: Q): Promise<ItemRow[]> {
  const { rows } = await q(client).query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM items WHERE parent_item_id = $1`,
    [parentId]
  );
  return rows;
}

// --- deletion (see deletion.ts for the ordering these must be called in) ---

/** Point scores belonging to the given items' reviews or rubric points. */
export async function deletePointScoresForItems(itemIds: string[], client: Q): Promise<void> {
  await client.query(
    `DELETE FROM point_scores
      WHERE review_id IN (SELECT id FROM reviews WHERE item_id = ANY($1))
         OR point_id IN (SELECT id FROM rubric_points WHERE item_id = ANY($1))`,
    [itemIds]
  );
}

export async function deleteReviewsForItems(itemIds: string[], client: Q): Promise<void> {
  await client.query(`DELETE FROM reviews WHERE item_id = ANY($1)`, [itemIds]);
}

export async function deleteRubricPointsForItems(itemIds: string[], client: Q): Promise<void> {
  await client.query(`DELETE FROM rubric_points WHERE item_id = ANY($1)`, [itemIds]);
}

export async function deleteItemsById(itemIds: string[], client: Q): Promise<void> {
  if (!itemIds.length) return;
  await client.query(`DELETE FROM items WHERE id = ANY($1)`, [itemIds]);
}
