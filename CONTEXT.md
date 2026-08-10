# Engram — Project Context

## What This Is

Engram is a **consolidation & recall system**: a Model Context Protocol (MCP) server that turns project work and study into durably remembered, explainable knowledge. It runs as a long-lived daemon on the Windows dev server (`STIGMERGYLABS`) and is driven by Claude (Claude Desktop / Cowork on the Mac) over Tailscale. Chris uses it daily: a ~15-minute review session where Claude pulls a time-boxed queue, presents prompts cold, grades typed answers against rubrics, and records results — and a session-close checkpoint that captures new concepts as reviewable items.

This repo is the **deterministic core only**: item registry, FSRS scheduling, split/retirement mechanics, and vault note read/write. All intelligence (grading, rubric drafting, follow-up questions, checkpoint validation) lives in the Claude conversation and is intentionally NOT here.

## Why It's Built This Way

- **Zero LLM calls server-side.** No Anthropic API key, no SDK. The server registers items, schedules reviews, records results. Cheaper, simpler, and the conversation layer is already Claude.
- **Server is the single writer of scheduling state.** State lives in PostgreSQL on the server, outside the vault — V1 synced JSON state through Obsidian Sync and risked conflicts for no benefit.
- **Vault is canonical for content.** Concept notes are human-written markdown in the Obsidian vault. The server reads them; its only vault writes are creating a new concept note (`create_item`) and a one-time `srs_id` stamp when registering a hand-authored note (`scan_vault`).
- **No queue debt.** Nothing accumulates. There is no "cards due today" count — only a priority ordering that a fixed time box pulls from. Missing days costs nothing (ADHD-safe by design).
- **FSRS, not SM-2.** FSRS handles late reviews natively, which the floating-queue design depends on.

## Architecture

```
Mac (Claude Desktop / Cowork)
        │  HTTP + bearer auth, over Tailscale
        ▼
http://100.88.70.118:3456/mcp   ← StreamableHTTP transport
        │
   Engram daemon (pm2: "engram")  ── reads/writes ──►  Obsidian vault (concept notes, *.md)
        │                                               C:\Users\rdpuser\Documents\TheBrainOfChris
        ▼
   PostgreSQL  (DB "engram", TCP 127.0.0.1:5432 as "claudedev" — no Unix socket on Windows)
   items · rubric_points · reviews · point_scores
```

Scheduling state never touches the vault; concept-note content never lives only in the DB (DB is reconciled from notes on `scan_vault`).

## MCP Tools (9)

| Tool | Purpose |
|---|---|
| `get_review_queue` | Priority-ordered, time-boxed list of items to review. **Never leaks answers/rubrics/traps/followups.** |
| `reveal_item` | Full item (rubric points, answer, trap, followup) — called only after the user answers cold. |
| `record_review` | One transaction: derive FSRS rating from per-point scores, schedule, record review, run split/retirement. |
| `create_item` | Mint id, render + write concept note to the vault, insert item + rubric points atomically. |
| `update_item` | Edit item fields in the DB (mainly to refine auto-spawned child prompts). |
| `retire_item` | Retire an item (and its children). |
| `list_items` | Filterable summaries with due dates and lapse counts. |
| `get_stats` | Active count, recent reviews, weakest items, upcoming, open splits. |
| `scan_vault` | Register/reconcile `srs: true` notes; stamp `srs_id` on new ones (the only vault mutation outside create). |

## Key Constraints

- **`get_review_queue` must never return answers, rubrics, traps, or follow-ups** — anything it returns may enter the conversation before the user answers cold. Cold retrieval is the whole point.
- **The server never drafts compressions.** Writing the explanation is where learning happens; that is the user's job in conversation. The server only stores what it is given.
- **All multi-statement DB work runs in explicit transactions.** A killed `record_review` must leave the DB consistent.
- **Localhost only.** Postgres is never exposed on Tailscale — it is bound to `127.0.0.1:5432`. Windows Postgres has no Unix socket, so the Ubuntu box's peer auth is not available here: the connection is TCP as role `claudedev` with a real password, held in `config.json` (gitignored). Only the MCP port (3456) is reachable over the tailnet, and it requires the bearer token.

## Project Structure

```
C:\Users\rdpuser\Documents\dev\engram\   ← source AND runtime (pm2 runs dist/ from here)
├── src/
│   ├── server.ts                ← Express + StreamableHTTP transport, auth, /health, boot migrations
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
├── backups/                     ← manual pg_dump output (gitignored)
├── config.json                  ← secrets (gitignored)
└── config.example.json
```

System bindings: pm2 process `engram`, declared in `Documents\dev\server-config\ecosystem.config.js`;
DB `engram` on PostgreSQL 17 at `127.0.0.1:5432`. There is no scheduled backup — the Ubuntu box's
nightly `pg_dump` cron was dropped in the migration, so dumps into `backups/` are manual.

## Configuration (`config.json`, gitignored)

| Key | Description |
|---|---|
| `vault_path` | Obsidian vault root on the server. |
| `port` | HTTP port (3456). |
| `auth_token` | Bearer token required on `/mcp`. 32 random bytes, hex — see README §2 for the PowerShell generator (`openssl` is not on PATH on this host). |
| `database_url` | Host-specific. POSIX: `postgresql:///engram?host=/var/run/postgresql` — Unix socket, peer auth, no password. Windows: `postgresql://<user>:<password>@127.0.0.1:5432/engram` — no Unix socket exists there, so TCP with a real password is required. |
| `test_database_url` | Same for the `engram_test` DB used by integration tests. |
| `default_time_budget_minutes` | Default review time box (15). |
| `cost_estimates_minutes` | Per-type review cost estimates for queue fill. |
| `project_first_interval_days` | First-review interval for project items (skips FSRS learning steps). |
| `child_retirement_streak` | Consecutive ≥Good reviews before a split child retires (2). |
| `fsrs.request_retention` | Target retention for FSRS (0.9). |

## Source Material

- Concept: `Documents\TheBrainOfChris\10 Projects\Engram\2026-06-06 - SRS v2 Concept - Consolidation & Recall System.md`
- Spec: `Documents\TheBrainOfChris\10 Projects\Engram\V2 Build Spec.md`
- Mode A (pm2 daemon) reference: `Documents\dev\Ganglion\`
- MCP tool-registration reference: `Documents\dev\teamreach-mcp\src\tools\`
- Server project pattern: `Documents\TheBrainOfChris\30 Resources\Patterns\Windows Server Project Pattern.md`
  (the older `Ubuntu Server Project Pattern.md` is retained in the vault for history only —
  every mechanism it names is wrong on this host)

> ⚠️ The two source notes above are **not present in this machine's vault copy** as of
> 2026-08-10 — there is no `10 Projects\Engram\` folder here at all. They may still exist on
> the Mac; if so, Syncthing should bring them across. Same gap that lost four SAP concept notes.
