import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import { Rating } from "ts-fsrs";
import type { ItemRow, RubricPointRow } from "./types.js";
import {
  insertItem,
  insertRubricPoint,
  setRubricPointStatus,
  setItemStatus,
  recentRatings,
} from "./repo.js";

/**
 * Split a missed rubric point off the parent into its own fast-clock child item.
 * The point is marked `split` (excluded from the parent's surviving points until
 * the child retires). The child carries a single rubric point — the source point
 * text — so it is graded the same way. Children never spawn further children.
 */
export async function applySplit(
  client: PoolClient,
  parent: ItemRow,
  point: RubricPointRow,
  customPrompt: string | undefined,
  now: Date
): Promise<{ id: string; title: string }> {
  await setRubricPointStatus(point.id, "split", client);

  const childId = nanoid();
  const title = `${parent.title} — ${point.text}`.slice(0, 200);
  const prompt =
    customPrompt ?? `Explain: ${point.text} (in the context of ${parent.title})`;

  await insertItem(
    {
      id: childId,
      type: parent.type,
      parent_item_id: parent.id,
      source_point_id: point.id,
      note_path: null, // auto-spawned children have no concept note
      title,
      prompt,
      due: now, // fresh FSRS state, due immediately
    },
    client
  );
  // one rubric point so the child is graded hit/partial/miss like any explanation
  await insertRubricPoint(
    { id: nanoid(), item_id: childId, ord: 0, text: point.text },
    client
  );

  return { id: childId, title };
}

/**
 * After recording a review on a split child, retire it if it has now logged
 * `streak` consecutive reviews at Good or better. Retiring restores the parent's
 * source rubric point to `active` so it is re-verified in context next time.
 * Returns true if the child was retired.
 */
export async function checkChildRetirement(
  client: PoolClient,
  child: ItemRow,
  streak: number
): Promise<boolean> {
  const ratings = await recentRatings(child.id, streak, client);
  const retire =
    ratings.length >= streak && ratings.every((r) => r >= Rating.Good);
  if (!retire) return false;

  await setItemStatus(child.id, "retired", client);
  if (child.source_point_id) {
    await setRubricPointStatus(child.source_point_id, "active", client);
  }
  return true;
}
