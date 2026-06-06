import type { SrsType } from "./notes.js";

export type ItemStatus = "active" | "retired";
export type PointStatus = "active" | "split" | "retired";
export type Score = "hit" | "partial" | "miss";

/** A row of the `items` table. */
export interface ItemRow {
  id: string;
  type: SrsType;
  status: ItemStatus;
  parent_item_id: string | null;
  source_point_id: string | null;
  note_path: string | null;
  title: string;
  prompt: string;
  answer: string | null;
  trap: string | null;
  followup: string | null;
  created_at: Date;
  due: Date;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  fsrs_state: number;
  last_review: Date | null;
}

export interface RubricPointRow {
  id: string;
  item_id: string;
  ord: number;
  text: string;
  status: PointStatus;
}
