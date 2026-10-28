# Engram Review Playbook

This is the conversation layer — how Claude (Desktop/Cowork) drives Engram. The
server is deterministic plumbing; the intelligence (grading, rubric drafting,
follow-ups, checkpoint validation) lives here, in the chat. Two flows: the
**daily review** and the **session checkpoint**.

---

## Daily review (~15 min, time-boxed)

The contract is a *time box*, not a queue to clear. Missing days costs nothing —
overdue items just rank higher next time. Never present this as "you're behind."

1. **Pull the queue.** `get_review_queue({ time_budget_minutes: 15 })`. It returns
   prompts only — **no answers, rubrics, traps, or follow-ups**. That is deliberate:
   the user must answer cold.
2. **Present prompt #1 verbatim.** Ask the user to explain it from memory. Do not
   hint. Wait for their full typed answer.
3. **Reveal and grade.** Only after they answer: `reveal_item({ item_id })`. Grade
   each rubric point **hit / partial / miss** against what they wrote (not against
   what you know — grade the answer). A point is hit only if the answer actually
   makes the gradeable claim.
4. **Spring the trap and the follow-up.** If their answer contains the item's
   `trap` misconception, name it. Then ask the `followup` question — the
   sharp-colleague pressure test — and factor their response into the grade.
5. **Record.** `record_review({ item_id, point_scores: [{point_id, score}], effortless? })`.
   - The FSRS rating is derived from the **worst surviving point** (any miss → Again,
     any partial → Hard, all hit → Good, all hit + effortless → Easy).
   - A **miss splits that point** into a fast-clock child item. If the default child
     prompt (`Explain: <point> (in the context of <title>)`) isn't ideal, pass a
     custom one via `splits: [{ point_id, prompt }]`.
6. **Report the schedule briefly** (next due / interval, any split spawned), then move
   to the next prompt until the box is spent. Stop when `get_review_queue` is empty
   for the budget — don't keep going.

**Fact items** are simpler: present the question, reveal, then
`record_review({ item_id, rating })` with 1–4 directly.

**Split children** drill one fumbled point in isolation. They resurface like any
item; grade the single point. Two consecutive Good-or-better reviews retire the
child automatically and return the point to the parent's rubric — the server does
this inside `record_review`; just report `child_retired: true` when it happens.

**On a fumble, offer the refresh path.** The concept note's `## Compression` (and
its linked session note) is the relearning path. Point the user there; relearning
from their own artifact is fast and resets the clock.

---

## Session checkpoint (~5 min, at the close of a working session)

Runs **before** reading the session note — extraction must be cold, from memory.
This is where building becomes learning.

1. **Extract from memory.** Ask: *What 2–4 concepts did this session touch? What do
   you understand now that you didn't before?* And the load-bearing question:
   **"What did the AI do that you couldn't explain yourself?"** — that finds the gap
   between *shipped it* and *learned it*.
2. **Diff against reality.** Now look at the session note / diff. A concept the user
   forgot to name at checkpoint is the earliest signal of weak encoding — flag it.
3. **Compress — the user writes, never you.** Have the user write each concept in
   their own words. Challenge them ("what's the load-bearing idea?", "could a
   stranger act on that sentence?") but **never draft the compression**. The writing
   is the encoding.
4. **Author the rubric — you draft, they cut.** Draft ~5 candidate rubric points from
   the session context; the user cuts to 3–4. Each point must be a *gradeable claim*,
   not a topic ("explains why we invalidate on write instead of TTL", not "mentions
   caching"). Stress-test: could a grader who wasn't in the session score an answer
   using only this line? Add **one trap** (the confident-wrong misconception) and
   **one follow-up** (what a sharp colleague asks).
5. **Write it.** `create_item({ type, title, note_folder, compression, prompt,
   audience?, rubric_points, trap, followup, links })`. The audience is part of the
   test — "explain to a non-technical PM" and "explain to an engineer" are different
   skills. Use `type: "fact"` (with `answer`) for atomic recall, `"explanation"` for
   meeting fluency, `"project"` for whole-project resurfacing (slower first interval).

---

## Maintenance

- After editing concept notes by hand in Obsidian, run `scan_vault` to reconcile the
  DB (and to register any new `srs: true` notes you wrote directly).
- `get_stats` gives a quick pulse: active items, reviews in the last 7 days, weakest
  items by lapse ratio, what's coming in 7 days, open splits.
- `list_items({ search, type, status })` to find or audit items; `retire_item` when a
  concept is no longer worth carrying (retires its children too).
- `delete_item` is the sharper tool: it destroys the item, its rubric, its review history and
  its children, permanently. Reach for it only for junk — a test item, a card created by
  mistake. Anything the user actually studied should be retired, not deleted, so the history
  survives. The concept note is not deleted — its frontmatter is flipped to `srs: false`, so
  the writing stays in the vault as an ordinary note and `scan_vault` will not bring the card
  back.
- To *read* cards rather than be tested on them, open `/browse` (see README) — it shows every
  item at full text, including the compression. It records nothing, so it is not a review; if
  you have read a card there, its next cold recall is no longer cold.
