# Engram — Project Context

## What This Is

Engram is a **consolidation & recall system**: a Model Context Protocol (MCP) server that turns project work and study into durably remembered, explainable knowledge. It runs as a long-lived HTTP daemon and is driven by Claude (Claude Desktop or Cowork) over a private network. The intended use is daily: a ~15-minute review session where Claude pulls a time-boxed queue, presents prompts cold, grades typed answers against rubrics, and records results — and a session-close checkpoint that captures new concepts as reviewable items.

This repo is the **deterministic core only**: item registry, FSRS scheduling, split/retirement mechanics, and vault note read/write. All intelligence (grading, rubric drafting, follow-up questions, checkpoint validation) lives in the Claude conversation and is intentionally NOT here.

## Why It's Built This Way

- **Zero LLM calls server-side.** No Anthropic API key, no SDK. The server registers items, schedules reviews, records results. Cheaper, simpler, and the conversation layer is already Claude.
- **Server is the single writer of scheduling state.** State lives in PostgreSQL on the server, outside the vault — V1 synced JSON state through Obsidian Sync and risked conflicts for no benefit.
- **Vault is canonical for content.** Concept notes are human-written markdown in the Obsidian vault. The server reads them; its only vault writes are creating a new concept note (`create_item`) and a one-time `srs_id` stamp when registering a hand-authored note (`scan_vault`).
- **No queue debt.** Nothing accumulates. There is no "cards due today" count — only a priority ordering that a fixed time box pulls from. Missing days costs nothing.
- **FSRS, not SM-2.** FSRS handles late reviews natively, which the floating-queue design depends on.

## Architecture

```
Claude Desktop / Cowork
        │  HTTP + bearer auth, over a private network (e.g. Tailscale)
        ▼
http://<host>:3456/mcp   ← StreamableHTTP transport
        │
   Engram daemon  ── reads/writes ──►  Obsidian vault (concept notes, *.md)
        │
        ▼
   PostgreSQL  (DB "engram", reachable only from the server)
   items · rubric_points · reviews · point_scores
```

Scheduling state never touches the vault; concept-note content never lives only in the DB (DB is reconciled from notes on `scan_vault`).

## MCP Tools (10)

| Tool | Purpose |
|---|---|
| `get_review_queue` | Priority-ordered, time-boxed list of items to review. **Never leaks answers/rubrics/traps/followups.** |
| `reveal_item` | Full item (rubric points, answer, trap, followup) — called only after the user answers cold. |
| `record_review` | One transaction: derive FSRS rating from per-point scores, schedule, record review, run split/retirement. |
| `create_item` | Mint id, render + write concept note to the vault, insert item + rubric points atomically. |
| `update_item` | Edit item fields in the DB (mainly to refine auto-spawned child prompts). |
| `retire_item` | Retire an item (and its children) — reversible; the row and its history survive. |
| `delete_item` | **Permanently** delete an item, its rubric points, its reviews and its split children. Flips the concept note to `srs: false`; the file is kept. |
| `list_items` | Filterable summaries with due dates and lapse counts. |
| `get_stats` | Active count, recent reviews, weakest items, upcoming, open splits. |
| `scan_vault` | Register/reconcile `srs: true` notes; stamp `srs_id` on new ones (the only vault mutation outside create). |

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer` | The MCP transport. |
| `GET /health` | none | Liveness + item count. |
| `GET /browse` | bearer, `?token=`, or cookie | Read-only card browser (see below). |
| `GET /api/cards` | same as `/browse` | JSON behind the browser: every item at full text. |
| `DELETE /api/cards/:id` | same as `/browse` | Hard-delete one card, unflagging its note. |

**The card browser** is a reading surface, not a review surface. It shows everything at once —
prompt, answer, rubric points with their split/retired status, trap, follow-up, the note's
`## Compression`, and the FSRS numbers — and writes nothing. It exists because the review flow
deliberately hides all of that until you have answered cold; sometimes you just want to flip
through what you have.

It is the **one place that surfaces `## Compression`**. `parseNote()` still hides it on purpose
(§ Key Constraints: nothing that could leak into a prompt before the user answers), and no MCP
tool returns it. Here you are reading your own cards on purpose, and the compression is the
relearning path.

Because a browser cannot set an `Authorization` header on a plain navigation, `/browse` also
accepts `?token=<auth_token>` once, stores it in an HttpOnly cookie, and redirects to a clean
URL. That cookie unlocks the three `/browse` + `/api/cards` routes — never `/mcp`. One of those
three is destructive, so note that the cookie can delete: it is `SameSite=Lax` and no CORS
headers are set, so another origin cannot fire the DELETE, but anyone holding the cookie can.

## Deleting items

`retire_item` is the reversible exit — the card leaves the queue, the row and its review
history stay. `delete_item` (and `DELETE /api/cards/:id`, the same code path in `deletion.ts`)
is the irreversible one, for junk: test items, mis-created cards. It takes the item, its rubric
points, its reviews, its point scores and its split children in a single transaction. There is
no built-in backup, so the UI makes you confirm twice.

**Deleting flips the item's concept note to `srs: false` before it touches a row.** That is not
optional bookkeeping — `scan_vault` re-registers any `srs: true` note whose `srs_id` is absent
from the DB, so a DB-only delete is silently undone by the next scan, with the review history
gone and the FSRS state reset. Unflagging makes the note invisible to `walkSrsNotes` while the
writing survives as an ordinary Obsidian note. Engram still never deletes a vault file, so
nothing it does propagates a *deletion* through Syncthing — only the frontmatter edit.

Order matters, and `deletion.ts` fixes it: unflag first, then delete the rows. A crash in
between leaves a live item with a dormant note (harmless and visible) rather than a deleted
item with a note that resurrects it. If the transaction fails, the flag is put back; if the
note cannot be written at all, nothing is deleted and the caller is told why.

Deleting a **split child** on its own restores the parent's rubric point to `active`, the same
restoration `checkChildRetirement` performs — otherwise the parent would quietly lose a
gradeable claim for good.

## Key Constraints

- **`get_review_queue` must never return answers, rubrics, traps, or follow-ups** — anything it returns may enter the conversation before the user answers cold. Cold retrieval is the whole point.
- **The server never drafts compressions.** Writing the explanation is where learning happens; that is the user's job in conversation. The server only stores what it is given.
- **All multi-statement DB work runs in explicit transactions.** A killed `record_review` must leave the DB consistent.
- **Postgres stays private.** Only the MCP port (3456) needs to be reachable by clients, and `/mcp` requires the bearer token. The database is never exposed on the network; credentials live in `config.json` (gitignored).

## Project Structure

```
engram/
├── src/
│   ├── server.ts                ← boot: config, pool, migrations, listen
│   ├── app.ts                   ← Express wiring: MCP transport, auth, /health, /browse, /api/cards
│   ├── browse.ts                ← card payload for the browser (DB + compression), browse auth
│   ├── deletion.ts              ← hard delete: cascade, note guard, rubric-point restoration
│   ├── browse-page.ts           ← the /browse page as a single self-contained HTML string
│   ├── config.ts                ← load + validate config.json
│   ├── db.ts                    ← pg Pool + withTransaction()
│   ├── migrate.ts               ← numbered migrations, meta(version), applied on boot
│   ├── migrations/001_init.sql  ← items, rubric_points, reviews, point_scores
│   ├── types.ts                 ← shared row/domain types
│   ├── repo.ts                  ← all SQL against items / rubric_points / reviews
│   ├── fsrs.ts                  ← ts-fsrs wrapper: deriveRating(), schedule(), retrievability()
│   ├── scheduler.ts             ← priority calc + greedy time-box fill
│   ├── review.ts                ← record_review orchestration (schedule + persist + splits)
│   ├── notes.ts                 ← gray-matter render (create) + parse (scan)
│   ├── vault.ts                 ← vault file I/O: walk, read, write, srs_id stamping
│   ├── splits.ts                ← split-on-miss + child-retirement mechanics
│   ├── tools/                   ← one file per MCP tool, each exports register(server)
│   └── test/                    ← node:test (run via tsx)
├── docs/                        ← claude_desktop_config.md, review_playbook.md
├── config.json                  ← secrets (gitignored)
└── config.example.json
```

Runtime: `npm run build && npm start` (Node 20+), against PostgreSQL (tested on 17). Migrations apply automatically on boot. Engram has no built-in backup; schedule a `pg_dump` if the review history matters to you.

## Configuration (`config.json`, gitignored)

| Key | Description |
|---|---|
| `vault_path` | Obsidian vault root on the server. |
| `port` | HTTP port (3456). |
| `auth_token` | Bearer token required on `/mcp`. 32 random bytes, hex (`openssl rand -hex 32`). |
| `database_url` | Any libpq URL: TCP `postgresql://engram:<password>@localhost:5432/engram`, or a Unix socket with peer auth, `postgresql:///engram?host=/var/run/postgresql`. |
| `test_database_url` | Same for the `engram_test` DB used by integration tests. |
| `default_time_budget_minutes` | Default review time box (15). |
| `cost_estimates_minutes` | Per-type review cost estimates for queue fill. |
| `project_first_interval_days` | First-review interval for project items (skips FSRS learning steps). |
| `child_retirement_streak` | Consecutive ≥Good reviews before a split child retires (2). |
| `fsrs.request_retention` | Target retention for FSRS (0.9). |
| `concept_domains` | Optional list of domains; `create_item` routes a note with a `domain` to `<folder>/Concepts/<domain>/`. |
| `protected_note_folders` | Optional folders that only accept notes routed into a `Concepts/<domain>/` subfolder. |
