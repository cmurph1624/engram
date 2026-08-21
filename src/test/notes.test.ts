import { test } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { renderNote, parseNote, setFrontmatterValue, type RenderOptions } from "../notes.js";

const EXPLANATION: RenderOptions = {
  srs_id: "abc123",
  srs_type: "explanation",
  title: "Webhook Retry Design",
  date: "2026-06-06",
  tags: ["concept"],
  compression: "We retry failed webhook deliveries with exponential backoff and jitter.",
  prompt: "Explain our webhook retry design to a backend engineer joining the project.",
  rubric_points: [
    "States the core failure mode retries handle",
    "Explains why exponential backoff with jitter, not fixed intervals",
    "Covers idempotency — why retries are safe to receive twice",
  ],
  trap: "conflating delivery guarantees with processing guarantees",
  followup: "What happens if the receiver is down for six hours?",
  links: ["Project Context", "2026-06-06 - Session"],
};

const FACT: RenderOptions = {
  srs_id: "fact99",
  srs_type: "fact",
  title: "FSRS rating scale",
  date: "2026-06-06",
  tags: ["concept"],
  compression: "FSRS ratings are 1-4.",
  prompt: "What are the four FSRS ratings in order?",
  answer: "Again (1), Hard (2), Good (3), Easy (4)",
  links: [],
};

test("renderNote: produces parseable frontmatter with srs markers", () => {
  const md = renderNote(EXPLANATION);
  const { data } = matter(md);
  assert.equal(data.srs, true);
  assert.equal(data.srs_id, "abc123");
  assert.equal(data.srs_type, "explanation");
  assert.ok(Array.isArray(data.tags) && data.tags.includes("concept"));
});

test("renderNote: includes the human compression section verbatim", () => {
  const md = renderNote(EXPLANATION);
  assert.ok(md.includes("## Compression"));
  assert.ok(md.includes(EXPLANATION.compression));
  assert.ok(md.includes("# Webhook Retry Design"));
});

test("explanation round-trips through render -> parse", () => {
  const parsed = parseNote(renderNote(EXPLANATION));
  assert.equal(parsed.srs, true);
  assert.equal(parsed.srs_id, "abc123");
  assert.equal(parsed.srs_type, "explanation");
  assert.equal(parsed.title, "Webhook Retry Design");
  assert.equal(parsed.prompt, EXPLANATION.prompt);
  assert.deepEqual(parsed.rubric_points, EXPLANATION.rubric_points);
  assert.equal(parsed.trap, EXPLANATION.trap);
  assert.equal(parsed.followup, EXPLANATION.followup);
});

test("fact round-trips with Question/Answer (no rubric)", () => {
  const parsed = parseNote(renderNote(FACT));
  assert.equal(parsed.srs_type, "fact");
  assert.equal(parsed.prompt, FACT.prompt);
  assert.equal(parsed.answer, FACT.answer);
  assert.deepEqual(parsed.rubric_points, []);
});

test("parseNote: the Compression section is never surfaced", () => {
  const parsed = parseNote(renderNote(EXPLANATION)) as Record<string, unknown>;
  assert.ok(!("compression" in parsed), "parsed note must not expose compression");
  // and the rubric/prompt must not have swallowed compression text
  assert.ok(!parsed.prompt!.toString().includes("exponential backoff and jitter"));
});

test("parseNote: rubric list does not capture Links bullets", () => {
  const parsed = parseNote(renderNote(EXPLANATION));
  assert.ok(!parsed.rubric_points.some((p) => p.includes("[[")));
});

test("parseNote: a hand-written note without srs_id is reported as such", () => {
  const md = `---
date: 2026-06-06
tags:
  - concept
srs: true
srs_type: explanation
---

# Hand Written

## Compression

mine

## Prompt

Explain the thing.

## Rubric

- point one
- point two

**Trap:** a trap
**Follow-up:** a question
`;
  const parsed = parseNote(md);
  assert.equal(parsed.srs, true);
  assert.equal(parsed.srs_id, undefined);
  assert.deepEqual(parsed.rubric_points, ["point one", "point two"]);
});

// --- setFrontmatterValue --------------------------------------------------
// These exist because a gray-matter round-trip is NOT safe here: re-serialising
// the block turns `date: 2026-06-06` into `date: 2026-06-06T00:00:00.000Z` and
// strips quoting, rewriting hand-authored notes (and syncing that to the Mac).

const VAULT_NOTE = `---
date: 2026-06-06
tags:
  - concept
  - AIEngineering
srs: true
srs_id: "abc123"
srs_type: explanation
---

# A Note

## Compression

my words
`;

test("setFrontmatterValue: flips a flag without touching anything else", () => {
  const out = setFrontmatterValue(VAULT_NOTE, "srs", "false");
  assert.match(out, /^srs: false$/m);
  assert.match(out, /^date: 2026-06-06$/m, "the date must not be re-serialised");
  assert.match(out, /^srs_id: "abc123"$/m, "quoting must survive");
  assert.match(out, /^ {2}- AIEngineering$/m, "the tag list must survive");
  assert.match(out, /## Compression\n\nmy words/);
});

test("setFrontmatterValue: appends the key when it is absent", () => {
  const out = setFrontmatterValue(VAULT_NOTE.replace('srs_id: "abc123"\n', ""), "srs_id", '"new1"');
  assert.match(out, /^srs_id: "new1"$/m);
  assert.match(out, /^date: 2026-06-06$/m);
});

test("setFrontmatterValue: only the frontmatter block is considered", () => {
  const body = `---
srs: true
---

# T

srs: true in the body must be left alone
`;
  const out = setFrontmatterValue(body, "srs", "false");
  assert.match(out, /^srs: false$/m);
  assert.match(out, /srs: true in the body must be left alone/);
});

test("setFrontmatterValue: preserves CRLF line endings", () => {
  const crlf = "---\r\ndate: 2026-06-06\r\nsrs: true\r\n---\r\n\r\n# T\r\n";
  const out = setFrontmatterValue(crlf, "srs", "false");
  assert.match(out, /srs: false\r\n/);
  assert.ok(!/[^\r]\n/.test(out), "no bare LF may be introduced");
});

test("setFrontmatterValue: refuses a note with no frontmatter", () => {
  assert.throws(() => setFrontmatterValue("# Just a body\n", "srs", "false"), /frontmatter/);
});
