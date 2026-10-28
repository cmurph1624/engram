/**
 * Read-only card browser: the data layer behind GET /browse and GET /api/cards.
 *
 * This is the one place in the codebase that deliberately surfaces a note's
 * `## Compression` — the human's own written encoding. `parseNote()` keeps it
 * hidden on purpose (it must never reach a review prompt or an MCP tool
 * result); here the user is reading their own cards on purpose, and the compression
 * is the relearning path the playbook points at on a fumble.
 *
 * Nothing in this module writes: no DB mutation, no vault I/O beyond reads,
 * no FSRS state touched.
 */
import matter from "gray-matter";
import type pg from "pg";
import { getPool } from "./db.js";
import { readNote } from "./vault.js";
import type { ItemRow, ItemStatus, PointStatus, RubricPointRow } from "./types.js";
import { sections, type SrsType } from "./notes.js";

export const BROWSE_COOKIE = "engram_browse";

export interface CardRubricPoint {
  id: string;
  ord: number;
  text: string;
  status: PointStatus;
}

export interface Card {
  id: string;
  type: SrsType;
  status: ItemStatus;
  title: string;
  prompt: string;
  answer: string | null;
  trap: string | null;
  followup: string | null;
  rubric_points: CardRubricPoint[];
  compression: string | null;
  note_path: string | null;
  parent_item_id: string | null;
  source_point_id: string | null;
  created_at: string;
  due: string;
  last_review: string | null;
  reps: number;
  lapses: number;
  stability: number | null;
  difficulty: number | null;
  fsrs_state: number;
  state_label: string;
}

// Mirrors ts-fsrs State (New/Learning/Review/Relearning) without importing it
// for a label lookup.
const STATE_LABELS = ["New", "Learning", "Review", "Relearning"];

/**
 * Pull the `## Compression` section out of a concept note. Returns null when
 * the section is absent or empty (split children have no note at all).
 */
export function extractCompression(noteContent: string): string | null {
  const { content: body } = matter(noteContent);
  const text = (sections(body).get("Compression") ?? "").trim();
  return text.length ? text : null;
}

/** Shape one item + its rubric points into the browser's card payload. */
export function buildCard(
  item: ItemRow,
  points: RubricPointRow[],
  compression: string | null
): Card {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    prompt: item.prompt,
    answer: item.answer,
    trap: item.trap,
    followup: item.followup,
    rubric_points: [...points]
      .sort((a, b) => a.ord - b.ord)
      .map((p) => ({ id: p.id, ord: p.ord, text: p.text, status: p.status })),
    compression,
    note_path: item.note_path,
    parent_item_id: item.parent_item_id,
    source_point_id: item.source_point_id,
    created_at: item.created_at.toISOString(),
    due: item.due.toISOString(),
    last_review: item.last_review ? item.last_review.toISOString() : null,
    reps: item.reps,
    lapses: item.lapses,
    stability: item.stability,
    difficulty: item.difficulty,
    fsrs_state: item.fsrs_state,
    state_label: STATE_LABELS[item.fsrs_state] ?? `state ${item.fsrs_state}`,
  };
}

const CARD_COLS = `id, type, status, parent_item_id, source_point_id, note_path, title,
  prompt, answer, trap, followup, created_at, due, stability, difficulty, reps, lapses,
  fsrs_state, last_review`;

/**
 * Every item (active and retired), due soonest first, with rubric points and
 * — where the note exists on this machine — the compression. The set is small
 * enough (tens of items) that the browser loads it whole and filters client-side.
 */
export async function loadCards(vaultPath: string, client?: pg.Pool): Promise<Card[]> {
  const db = client ?? getPool();
  const { rows: items } = await db.query<ItemRow>(
    `SELECT ${CARD_COLS} FROM items ORDER BY due ASC`
  );
  const { rows: points } = await db.query<RubricPointRow>(
    `SELECT id, item_id, ord, text, status FROM rubric_points ORDER BY ord`
  );

  const byItem = new Map<string, RubricPointRow[]>();
  for (const p of points) {
    const list = byItem.get(p.item_id);
    if (list) list.push(p);
    else byItem.set(p.item_id, [p]);
  }

  // The vault copy on this host is known to be incomplete — a note named in the
  // DB may simply not be here. That is a null compression, not an error.
  const compressionCache = new Map<string, string | null>();
  const compressionFor = (relPath: string | null): string | null => {
    if (!relPath) return null;
    if (compressionCache.has(relPath)) return compressionCache.get(relPath)!;
    let value: string | null = null;
    try {
      value = extractCompression(readNote(vaultPath, relPath));
    } catch {
      value = null;
    }
    compressionCache.set(relPath, value);
    return value;
  };

  return items.map((i) => buildCard(i, byItem.get(i.id) ?? [], compressionFor(i.note_path)));
}

/** Parse a Cookie header into a plain map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export interface BrowseAuthInput {
  authorization?: string;
  cookie?: string;
  queryToken?: string;
}

/**
 * The browser cannot set an Authorization header on a plain navigation, so the
 * page also accepts `?token=` once (server then sets a cookie) — same secret as
 * /mcp, no second credential to manage.
 */
export function isBrowseAuthorized(input: BrowseAuthInput, token: string): boolean {
  if (!token) return false;
  if (input.authorization === `Bearer ${token}`) return true;
  if (input.queryToken && input.queryToken === token) return true;
  return parseCookies(input.cookie)[BROWSE_COOKIE] === token;
}
