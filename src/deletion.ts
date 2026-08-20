/**
 * Hard deletion of an item and everything hanging off it. This is the only
 * destructive path in Engram, and it is irreversible — `retire_item` is the
 * reversible way to take a card out of circulation.
 *
 * It never touches the vault. A card whose concept note still exists is
 * refused, because `scan_vault` re-registers any `srs: true` note whose
 * `srs_id` is not in the DB: deleting the row while the note remains would be
 * silently undone by the next scan, with the review history gone. Remove the
 * note (or its `srs: true`) in Obsidian first — the vault stays canonical.
 */
import { withTransaction } from "./db.js";
import {
  getItemForUpdate,
  getChildren,
  getRubricPoints,
  setRubricPointStatus,
  deletePointScoresForItems,
  deleteReviewsForItems,
  deleteRubricPointsForItems,
  deleteItemsById,
} from "./repo.js";
import { noteExists } from "./vault.js";

export type DeleteResult =
  | { ok: true; deleted: string[]; restored_point_id: string | null }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "note_present"; note_path: string };

export async function deleteItemCascade(
  itemId: string,
  vaultPath: string
): Promise<DeleteResult> {
  return withTransaction(async (client) => {
    const item = await getItemForUpdate(itemId, client);
    if (!item) return { ok: false, reason: "not_found" };
    if (item.note_path && noteExists(vaultPath, item.note_path)) {
      return { ok: false, reason: "note_present", note_path: item.note_path };
    }

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

    return { ok: true, deleted: ids, restored_point_id: restored };
  });
}
