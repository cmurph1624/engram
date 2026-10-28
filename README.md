# Engram

A consolidation and recall system, built as a Model Context Protocol (MCP) server. It turns
project work and study into knowledge you can still explain months later: Claude runs a short
daily review where you answer prompts cold, grades your answer against a rubric, and Engram
schedules the next review with FSRS.

This repo is the **deterministic core**: item registry, FSRS scheduling, split and retirement
mechanics, and Obsidian vault note read/write. All the judgment (grading, drafting rubrics,
follow-up questions) happens in the Claude conversation. The server makes **zero LLM calls** and
needs no API key.

## Why it's built this way

- **Cold retrieval is the point.** `get_review_queue` never returns answers, rubrics, traps or
  follow-ups, so nothing can leak into the conversation before you have answered.
  `reveal_item` is called only afterwards.
- **No queue debt.** There is no "cards due today" count, only a priority order that a fixed
  time box (15 minutes by default) pulls from. Missing a day costs nothing; overdue items just
  rank higher.
- **FSRS, not SM-2.** FSRS handles late reviews natively, which the floating queue depends on.
- **Misses split.** The FSRS rating comes from the worst rubric point, and a missed point
  spawns a fast-clock child item that retires itself after two consecutive good reviews.
- **The vault owns content; Postgres owns scheduling.** Concept notes are human-written
  markdown in Obsidian. Scheduling state lives only in the database, so syncing the vault can
  never corrupt it.
- **The server never writes your explanations.** Writing the compression is where the learning
  happens, so that stays with you.

## Architecture

```
Claude Desktop / Cowork
        │  Streamable HTTP + bearer token (private network, e.g. Tailscale)
        ▼
  Engram (Express + MCP SDK, :3456)  ── reads/writes ──►  Obsidian vault (concept notes)
        │
        ▼
  PostgreSQL: items · rubric_points · reviews · point_scores
```

TypeScript on Node 20+, `@modelcontextprotocol/sdk`, `ts-fsrs`, `pg`, `gray-matter`. Every
multi-statement write runs in a transaction, so a killed `record_review` leaves the database
consistent.

## MCP tools

| Tool | Purpose |
|---|---|
| `get_review_queue` | Priority-ordered, time-boxed queue of prompts. Never includes answers. |
| `reveal_item` | The full item (rubric points, answer, trap, follow-up), after you've answered. |
| `record_review` | Derive the FSRS rating from per-point scores, schedule, record, and run splits/retirement in one transaction. |
| `create_item` | Write a new concept note to the vault and register the item and its rubric. |
| `update_item` | Edit item fields (mainly to refine auto-generated child prompts). |
| `retire_item` | Take an item out of circulation, reversibly; history is kept. |
| `delete_item` | Permanently delete an item and its history. Its note is kept, flagged `srs: false`. |
| `list_items` | Filterable summaries with due dates and lapse counts. |
| `get_stats` | Active count, recent reviews, weakest items, upcoming, open splits. |
| `scan_vault` | Register hand-written `srs: true` notes and reconcile existing ones. |

The conversation side is documented in [docs/review_playbook.md](docs/review_playbook.md): the
daily review flow and the end-of-session checkpoint that captures new concepts as items.

## HTTP routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer <token>` | MCP transport |
| `GET /health` | none | Liveness, item count, DB status |
| `GET /browse` | bearer, `?token=`, or cookie | Read-only card browser |
| `GET /api/cards` | same as `/browse` | Every item at full text, as JSON |
| `DELETE /api/cards/:id` | same as `/browse` | Hard-delete one card |

`/browse` is for flipping through your cards at full text, including each note's
`## Compression`. A browser can't set an `Authorization` header on a plain navigation, so
`?token=` is accepted once, swapped for an HttpOnly cookie, and redirected to a clean URL. That
cookie never unlocks `/mcp`.

## Setup

Requirements: Node 20+, PostgreSQL (tested on 17), an Obsidian vault (or any folder of markdown notes).

```bash
createdb engram
createdb engram_test             # only needed for the integration tests

cp config.example.json config.json
chmod 600 config.json
openssl rand -hex 32             # paste as auth_token
# then set vault_path, database_url and test_database_url

npm install
npm run build                    # tsc -> dist/
npm start                        # migrations apply on boot
curl http://localhost:3456/health
```

Configuration keys are described in [CONTEXT.md](CONTEXT.md#configuration-configjson-gitignored).
To connect Claude Desktop, see [docs/claude_desktop_config.md](docs/claude_desktop_config.md).

Engram has no built-in backup. If your review history matters, schedule a `pg_dump`.

## Tests

```bash
npm test             # unit + integration (node:test via tsx); needs engram_test
npm run test:unit    # pure logic only, no database
```

## More

[CONTEXT.md](CONTEXT.md) covers the design in depth: deletion ordering and why a delete flips
the note before touching rows, the split/retirement rules, and the full configuration table.
