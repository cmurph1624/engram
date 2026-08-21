/**
 * Hard deletion of an item and everything hanging off it. This is the only
 * destructive path in Engram, and it is irreversible — `retire_item` is the
 * reversible way to take a card out of circulation.
 *
 * `scan_vault` re-registers any `srs: true` note whose `srs_id` is not in the
 * DB, so deleting the row alone would be silently undone by the next scan.
 * Deletion therefore flips the note's frontmatter to `srs: false` first: the
 * card can never come back, and the writing survives as an ordinary Obsidian
 * note. Engram still never deletes a vault file.
 *
 * Order matters. The note is unflagged before the rows are deleted, so a
 * crash in between leaves a live item with a dormant note (harmless, visible)
 * rather than a deleted item with a note that resurrects it. If the
 * transaction fails, the flag is put back.
 */
import { withTransaction } from "./db.js";
import {
  getItem,
  getItemForUpdate,
  getChildren,
  getRubricPoints,
  setRubricPointStatus,
  deletePointScoresForItems,
  deleteReviewsForItems,
  deleteRubricPointsForItems,
  deleteItemsById,
} from "./repo.js";
import { noteExists, setSrsFlag } from "./vault.js";

export type DeleteResult =
  | {
      ok: true;
      deleted: string[];
      restored_point_id: string | null;
      /** Vault path whose `srs: true` was flipped off, if there was one. */
      unflagged_note: string | null;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "note_write_failed"; note_path: string; message: string };

export async function deleteItemCascade(
  itemId: string,
  vaultPath: string
): Promise<DeleteResult> {
  const existing = await getItem(itemId);
  if (!existing) return { ok: false, reason: "not_found" };

  let unflagged: string | null = null;
  if (existing.note_path && noteExists(vaultPath, existing.note_path)) {
    try {
      setSrsFlag(vaultPath, existing.note_path, false);
      unflagged = existing.note_path;
    } catch (err) {
      // Leave the row alone: a card whose note still says `srs: true` must not
      // be deleted, or the next scan_vault brings it back.
      return {
        ok: false,
        reason: "note_write_failed",
        note_path: existing.note_path,
        message: (err as Error).message,
      };
    }
  }

  try {
    return await runCascade(itemId, unflagged);
  } catch (err) {
    if (unflagged) {
      try {
        setSrsFlag(vaultPath, unflagged, true);
      } catch {
        /* best effort — the thrown DB error is what matters */
      }
    }
    throw err;
  }
}

async function runCascade(itemId: string, unflagged: string | null): Promise<DeleteResult> {
  return withTransaction(async (client) => {
    const item = await getItemForUpdate(itemId, client);
    if (!item) return { ok: false, reason: "not_found" };

    // Split children are auto-spawned and never have notes of their own.
    const childIds = (await getChildren(itemId, client)).map((c) => c.id);
    const ids = [itemId, ...childIds];

    // Deleting a split child on its own hands its rubric point back to the
    // parent — the same restoration checkChildRetirement performs. Deleting a
    // parent needs none of this: its points go with it.
    let restored: string | null = null;
    if (item.parent_item_id && item.source_point_id) {
      const point = (await getRubricPoints(item.parent_item_id, client)).find(
        (p) => p.id === item.source_point_id
      );
      if (point && point.status === "split") {
        await setRubricPointStatus(point.id, "active", client);
        restored = point.id;
      }
    }

    await deletePointScoresForItems(ids, client);
    await deleteReviewsForItems(ids, client);
    await deleteRubricPointsForItems(ids, client);
    // children first: items.parent_item_id is a self-referencing FK
    await deleteItemsById(childIds, client);
    await deleteItemsById([itemId], client);

    return { ok: true, deleted: ids, restored_point_id: restored, unflagged_note: unflagged };
  });
}
