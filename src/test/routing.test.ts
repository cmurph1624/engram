/**
 * Note routing and moved-note reconciliation.
 *
 * Covers the two things the 2026-08-27 folder reorganisation depends on:
 * a moved note keeping its identity through `scan_vault`, and `create_item`
 * routing new notes into `Concepts/<domain>/` instead of a flat track root.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { initPool, closePool, getPool } from "../db.js";
import { migrate } from "../migrate.js";
import { registerAllTools } from "../tools/index.js";
import { parseNote } from "../notes.js";
import { getItem } from "../repo.js";

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

class FakeServer {
  handlers = new Map<string, Handler>();
  tool(name: string, _desc: string, _shape: unknown, handler: Handler) {
    this.handlers.set(name, handler);
  }
}

const DOMAINS = ["Applications and Integration", "Claude Code", "Security and Safety"];
const TRACK = "10 Projects/Certifications & Courses/02 Anthropic Track";

let vault: string;
let server: FakeServer;

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const h = server.handlers.get(name);
  if (!h) throw new Error(`no handler ${name}`);
  const r = await h(args);
  const parsed = JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(parsed.error ?? "tool error");
  return parsed;
}

/** Move a note inside the vault, creating the destination folder. */
function moveNote(fromRel: string, toRel: string): void {
  const to = join(vault, toRel);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(join(vault, fromRel), to);
}

before(async () => {
  const base = loadConfig();
  initPool(base.test_database_url);
  await migrate();
  await getPool().query(
    "TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE"
  );

  vault = mkdtempSync(join(tmpdir(), "engram-routing-"));
  const config: Config = {
    ...base,
    vault_path: vault,
    concept_domains: DOMAINS,
    protected_note_folders: [TRACK],
  };
  server = new FakeServer();
  registerAllTools(server as never, config);
});

after(async () => {
  await closePool();
});

// --- moved-note reconciliation ------------------------------------------

test("scan_vault reconciles a moved note by srs_id, preserving review history", async () => {
  const created = await call("create_item", {
    type: "fact",
    title: "Moved Card",
    note_folder: "Flat",
    compression: "original wording",
    prompt: "Does a move keep identity?",
    answer: "yes, matched by srs_id",
  });
  assert.equal(created.note_path, "Flat/Moved Card.md");

  await call("record_review", { item_id: created.id, rating: 3 });
  const before = await getItem(created.id);
  assert.ok(before!.reps > 0, "precondition: the item has review history");

  moveNote("Flat/Moved Card.md", "Nested/Concepts/Claude Code/Moved Card.md");

  const res = await call("scan_vault", {});
  const newPath = "Nested/Concepts/Claude Code/Moved Card.md";

  assert.equal(
    res.registered.length,
    0,
    "a moved note must be reconciled, never registered as new"
  );
  assert.ok(
    res.updated.some((u: { id: string; note_path: string }) => u.id === created.id && u.note_path === newPath),
    "scan_vault should report the moved note under its new path"
  );
  assert.deepEqual(res.missing, [], "the old path must not be reported missing");

  const after = await getItem(created.id);
  assert.equal(after!.note_path, newPath, "note_path should be repaired");
  assert.equal(after!.reps, before!.reps, "review history must survive the move");
  assert.equal(after!.id, created.id, "the item keeps its identity");
});

test("delete_item unflags a moved note whose stored path is stale", async () => {
  const created = await call("create_item", {
    type: "fact",
    title: "Stale Path Card",
    note_folder: "Flat",
    compression: "should still be unflagged",
    prompt: "Delete me after a move?",
    answer: "yes",
  });

  // Move WITHOUT scanning: the DB path is now stale, exactly the window the
  // folder reorganisation opens.
  const newRel = "Nested/Concepts/Security and Safety/Stale Path Card.md";
  moveNote("Flat/Stale Path Card.md", newRel);

  const res = await call("delete_item", { item_id: created.id });
  assert.deepEqual(res.deleted, [created.id]);
  assert.equal(res.unflagged_note, newRel, "the note must be found at its real location");

  const note = readFileSync(join(vault, newRel), "utf8");
  assert.equal(parseNote(note).srs, false, "the moved note must be unflagged");
  assert.match(note, /should still be unflagged/, "the writing survives");

  // and it must not come back
  const scan = await call("scan_vault", {});
  assert.equal(
    scan.registered.some((r: { note_path: string }) => r.note_path === newRel),
    false,
    "an unflagged moved note must stay dead"
  );
});

test("delete_item still succeeds when the note is genuinely gone", async () => {
  const created = await call("create_item", {
    type: "fact",
    title: "Vanished Card",
    note_folder: "Flat",
    compression: "gone",
    prompt: "?",
    answer: "!",
  });
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(vault, "Flat/Vanished Card.md"));

  const res = await call("delete_item", { item_id: created.id });
  assert.deepEqual(res.deleted, [created.id]);
  assert.equal(res.unflagged_note, null, "nothing to unflag when the file is truly absent");
});

// --- domain routing ------------------------------------------------------

test("create_item with a domain routes into Concepts/<domain>/", async () => {
  const res = await call("create_item", {
    type: "fact",
    title: "Routed Card",
    note_folder: TRACK,
    domain: "Claude Code",
    compression: "routed",
    prompt: "Where does this land?",
    answer: "Concepts/Claude Code",
  });
  assert.equal(res.note_path, `${TRACK}/Concepts/Claude Code/Routed Card.md`);
  assert.ok(existsSync(join(vault, res.note_path)), "note file should exist at the routed path");
});

test("create_item rejects an unknown domain and names the valid ones", async () => {
  await assert.rejects(
    () =>
      call("create_item", {
        type: "fact",
        title: "Bad Domain",
        note_folder: TRACK,
        domain: "Underwater Basket Weaving",
        compression: "x",
        prompt: "?",
        answer: "!",
      }),
    /Claude Code/,
    "the error should list the configured domains"
  );
});

test("create_item refuses to write directly into a protected track root", async () => {
  await assert.rejects(
    () =>
      call("create_item", {
        type: "fact",
        title: "Flat Card",
        note_folder: TRACK,
        compression: "x",
        prompt: "?",
        answer: "!",
      }),
    /Concepts/,
    "the error should point at the Concepts/<domain> convention"
  );
  assert.equal(
    existsSync(join(vault, `${TRACK}/Flat Card.md`)),
    false,
    "no file should be written on rejection"
  );
});

test("create_item still allows unprotected folders without a domain", async () => {
  const res = await call("create_item", {
    type: "fact",
    title: "Ordinary Card",
    note_folder: "30 Resources/Concepts",
    compression: "x",
    prompt: "?",
    answer: "!",
  });
  assert.equal(res.note_path, "30 Resources/Concepts/Ordinary Card.md");
});

// --- path safety ---------------------------------------------------------

test("create_item rejects path traversal in note_folder", async () => {
  await assert.rejects(
    () =>
      call("create_item", {
        type: "fact",
        title: "Escapee",
        note_folder: "../../etc",
        compression: "x",
        prompt: "?",
        answer: "!",
      }),
    /outside the vault|invalid/i
  );
});

test("create_item rejects a title containing a path separator", async () => {
  for (const title of ["../Escapee", "sub/Escapee", "sub\\Escapee"]) {
    await assert.rejects(
      () =>
        call("create_item", {
          type: "fact",
          title,
          note_folder: "Flat",
          compression: "x",
          prompt: "?",
          answer: "!",
        }),
      /invalid|separator|outside the vault/i,
      `title ${title} should be rejected`
    );
  }
});

test("create_item rejects an absolute note_folder", async () => {
  await assert.rejects(
    () =>
      call("create_item", {
        type: "fact",
        title: "Absolute",
        note_folder: "C:/Windows/Temp",
        compression: "x",
        prompt: "?",
        answer: "!",
      }),
    /absolute|invalid|outside the vault/i
  );
});
