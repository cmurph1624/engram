import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { initPool, closePool } from "../db.js";
import { migrate } from "../migrate.js";
import { registerAllTools } from "../tools/index.js";
import { parseNote } from "../notes.js";

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

// Minimal stand-in for McpServer.tool() that just captures handlers.
class FakeServer {
  handlers = new Map<string, Handler>();
  tool(name: string, _desc: string, _shape: unknown, handler: Handler) {
    this.handlers.set(name, handler);
  }
}

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

before(async () => {
  const base = loadConfig();
  initPool(base.test_database_url);
  await migrate();
  await import("../db.js").then(({ getPool }) =>
    getPool().query("TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE")
  );

  vault = mkdtempSync(join(tmpdir(), "engram-vault-"));
  const config: Config = { ...base, vault_path: vault };
  server = new FakeServer();
  registerAllTools(server as never, config);
});

after(async () => {
  await closePool();
});

test("create_item writes a concept note and registers the item", async () => {
  const res = await call("create_item", {
    type: "explanation",
    title: "Webhook Retries",
    note_folder: "Concepts",
    compression: "We retry with backoff + jitter; idempotent receivers.",
    prompt: "Explain our webhook retry design.",
    rubric_points: ["failure mode", "backoff + jitter", "idempotency"],
    trap: "delivery vs processing guarantees",
    followup: "What if the receiver is down six hours?",
    links: ["Project Context"],
  });
  assert.ok(res.id);
  assert.equal(res.note_path, "Concepts/Webhook Retries.md");
  assert.ok(existsSync(join(vault, res.note_path)), "note file should exist");
  const parsed = parseNote(readFileSync(join(vault, res.note_path), "utf8"));
  assert.equal(parsed.srs_id, res.id);
  assert.deepEqual(parsed.rubric_points, ["failure mode", "backoff + jitter", "idempotency"]);
});

test("get_review_queue lists the item and leaks no answers/rubrics/traps/followups", async () => {
  const res = await call("get_review_queue", { time_budget_minutes: 15 });
  assert.ok(res.queue.length >= 1);
  for (const entry of res.queue) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["days_overdue", "due", "estimated_minutes", "id", "prompt", "title", "type"].sort(),
      "queue entry must expose only safe fields"
    );
  }
});

test("reveal_item returns rubric points only after the queue", async () => {
  const queue = (await call("get_review_queue", {})).queue;
  const id = queue[0].id;
  const item = await call("reveal_item", { item_id: id });
  assert.equal(item.rubric_points.length, 3);
  assert.ok(item.trap);
  assert.ok(item.followup);
});

test("record_review on a clean answer schedules forward with no splits", async () => {
  const queue = (await call("get_review_queue", {})).queue;
  const id = queue[0].id;
  const item = await call("reveal_item", { item_id: id });
  const point_scores = item.rubric_points.map((p: { id: string }) => ({
    point_id: p.id,
    score: "hit",
  }));
  const res = await call("record_review", { item_id: id, point_scores });
  assert.equal(res.splits_created.length, 0);
  assert.ok(res.interval_days >= 0);
  assert.ok(new Date(res.next_due).getTime() > Date.now());
});

test("scan_vault registers a hand-written note and stamps its srs_id", async () => {
  const { writeNote } = await import("../vault.js");
  const rel = "Concepts/Hand Written.md";
  writeNote(
    vault,
    rel,
    `---
date: 2026-06-06
tags:
  - concept
srs: true
srs_type: fact
---

# Hand Written

## Compression

mine

## Question

What is an engram?

## Answer

The physical trace a memory leaves.
`
  );
  const res = await call("scan_vault", {});
  assert.ok(res.registered.some((r: { note_path: string }) => r.note_path === rel));
  const after = parseNote(readFileSync(join(vault, rel), "utf8"));
  assert.ok(after.srs_id, "srs_id should be stamped into the note");
});

test("delete_item unflags the concept note and removes the item", async () => {
  const created = await call("create_item", {
    type: "fact",
    title: "Junk Card",
    note_folder: "Concepts",
    compression: "throwaway",
    prompt: "Delete me?",
    answer: "yes",
  });

  const res = await call("delete_item", { item_id: created.id });
  assert.deepEqual(res.deleted, [created.id]);
  assert.equal(res.unflagged_note, "Concepts/Junk Card.md");
  assert.equal((await call("list_items", { search: "Junk Card" })).count, 0);

  // the note is still on disk, no longer an SRS note, writing intact
  const note = readFileSync(join(vault, "Concepts/Junk Card.md"), "utf8");
  assert.equal(parseNote(note).srs, false);
  assert.match(note, /throwaway/);
});

test("a deleted item's note is not re-registered by scan_vault", async () => {
  const res = await call("scan_vault", {});
  assert.equal(
    res.registered.some((r: { note_path: string }) => r.note_path === "Concepts/Junk Card.md"),
    false,
    "an unflagged note must stay dead"
  );
  assert.equal((await call("list_items", { search: "Junk Card" })).count, 0);
});

test("delete_item reports an unknown id", async () => {
  await assert.rejects(() => call("delete_item", { item_id: "nope" }), /not found/);
});
