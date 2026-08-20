import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { initPool, getPool, closePool } from "../db.js";
import { migrate } from "../migrate.js";
import { insertItem, insertRubricPoint, setItemStatus } from "../repo.js";
import { writeNote } from "../vault.js";
import { renderNote } from "../notes.js";
import { loadCards } from "../browse.js";

let vault: string;

before(async () => {
  const base = loadConfig();
  initPool(base.test_database_url);
  await migrate();
  await getPool().query(
    "TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE"
  );

  vault = mkdtempSync(join(tmpdir(), "engram-browse-"));
  const pool = getPool();

  writeNote(
    vault,
    "Concepts/Has Note.md",
    renderNote({
      srs_id: "b_noted",
      srs_type: "explanation",
      title: "Has Note",
      date: "2026-06-06",
      compression: "my own words about the thing",
      prompt: "Explain the thing.",
      rubric_points: ["point one", "point two"],
      trap: "the trap",
      followup: "the follow-up",
    })
  );

  await insertItem(
    {
      id: "b_noted",
      type: "explanation",
      note_path: "Concepts/Has Note.md",
      title: "Has Note",
      prompt: "Explain the thing.",
      trap: "the trap",
      followup: "the follow-up",
      due: new Date("2026-08-01T00:00:00Z"),
    },
    pool
  );
  await insertRubricPoint({ id: "b_p1", item_id: "b_noted", ord: 1, text: "point one" }, pool);
  await insertRubricPoint({ id: "b_p2", item_id: "b_noted", ord: 2, text: "point two" }, pool);

  // Note recorded in the DB but absent from this machine's vault copy.
  await insertItem(
    {
      id: "b_missing",
      type: "fact",
      note_path: "Concepts/Not Synced.md",
      title: "Missing Note",
      prompt: "What is an engram?",
      answer: "The physical trace a memory leaves.",
      due: new Date("2026-08-02T00:00:00Z"),
    },
    pool
  );

  // A retired split child: no note at all.
  await insertItem(
    {
      id: "b_child",
      type: "explanation",
      parent_item_id: "b_noted",
      source_point_id: "b_p2",
      title: "point two",
      prompt: "Explain: point two (in the context of Has Note)",
      due: new Date("2026-08-03T00:00:00Z"),
    },
    pool
  );
  await setItemStatus("b_child", "retired", pool);
});

after(async () => {
  await closePool();
});

test("loadCards: returns every item, due soonest first", async () => {
  const cards = await loadCards(vault);
  assert.deepEqual(
    cards.map((c) => c.id),
    ["b_noted", "b_missing", "b_child"]
  );
  assert.equal(cards.find((c) => c.id === "b_child")!.status, "retired");
});

test("loadCards: attaches the compression from the vault note", async () => {
  const card = (await loadCards(vault)).find((c) => c.id === "b_noted")!;
  assert.equal(card.compression, "my own words about the thing");
  assert.deepEqual(card.rubric_points.map((p) => p.text), ["point one", "point two"]);
});

test("loadCards: a note missing from the vault yields a null compression, not an error", async () => {
  const card = (await loadCards(vault)).find((c) => c.id === "b_missing")!;
  assert.equal(card.compression, null);
  assert.equal(card.note_path, "Concepts/Not Synced.md");
  assert.equal(card.answer, "The physical trace a memory leaves.");
});

test("loadCards: rubric points do not bleed between items", async () => {
  const cards = await loadCards(vault);
  assert.deepEqual(cards.find((c) => c.id === "b_child")!.rubric_points, []);
  assert.deepEqual(cards.find((c) => c.id === "b_missing")!.rubric_points, []);
});
