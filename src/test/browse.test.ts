import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNote } from "../notes.js";
import {
  extractCompression,
  buildCard,
  parseCookies,
  isBrowseAuthorized,
  BROWSE_COOKIE,
} from "../browse.js";
import type { ItemRow, RubricPointRow } from "../types.js";

const ITEM: ItemRow = {
  id: "item1",
  type: "explanation",
  status: "active",
  parent_item_id: null,
  source_point_id: null,
  note_path: "Concepts/Webhook Retries.md",
  title: "Webhook Retries",
  prompt: "Explain our webhook retry design to a backend engineer.",
  answer: null,
  trap: "conflating delivery with processing guarantees",
  followup: "What if the receiver is down six hours?",
  created_at: new Date("2026-06-06T12:00:00Z"),
  due: new Date("2026-08-24T09:00:00Z"),
  stability: 12.5,
  difficulty: 5.1,
  reps: 5,
  lapses: 1,
  fsrs_state: 2,
  last_review: new Date("2026-08-10T09:00:00Z"),
};

const POINTS: RubricPointRow[] = [
  { id: "p1", item_id: "item1", ord: 1, text: "states the failure mode", status: "active" },
  { id: "p2", item_id: "item1", ord: 2, text: "backoff + jitter", status: "split" },
];

// --- extractCompression ---------------------------------------------------

test("extractCompression: pulls the Compression section out of a rendered note", () => {
  const md = renderNote({
    srs_id: "abc123",
    srs_type: "explanation",
    title: "Webhook Retries",
    date: "2026-06-06",
    compression: "We retry with backoff and jitter; receivers are idempotent.",
    prompt: "Explain our webhook retry design.",
    rubric_points: ["failure mode", "backoff + jitter"],
    trap: "a trap",
    followup: "a follow-up",
    links: ["Project Context"],
  });
  assert.equal(
    extractCompression(md),
    "We retry with backoff and jitter; receivers are idempotent."
  );
});

test("extractCompression: stops at the next section heading", () => {
  const md = `---
srs: true
---

# T

## Compression

line one

line two

## Prompt

not part of the compression
`;
  assert.equal(extractCompression(md), "line one\n\nline two");
});

test("extractCompression: returns null when the note has no Compression section", () => {
  const md = `---
srs: true
---

# T

## Prompt

just a prompt
`;
  assert.equal(extractCompression(md), null);
});

test("extractCompression: returns null for an empty Compression section", () => {
  const md = `# T\n\n## Compression\n\n\n## Prompt\n\nq\n`;
  assert.equal(extractCompression(md), null);
});

// --- buildCard ------------------------------------------------------------

test("buildCard: exposes the full item, rubric points in order, and the compression", () => {
  const card = buildCard(ITEM, POINTS, "the compression text");
  assert.equal(card.id, "item1");
  assert.equal(card.title, "Webhook Retries");
  assert.equal(card.prompt, ITEM.prompt);
  assert.equal(card.trap, ITEM.trap);
  assert.equal(card.followup, ITEM.followup);
  assert.equal(card.compression, "the compression text");
  assert.deepEqual(
    card.rubric_points.map((p) => [p.ord, p.text, p.status]),
    [
      [1, "states the failure mode", "active"],
      [2, "backoff + jitter", "split"],
    ]
  );
});

test("buildCard: sorts rubric points by ord regardless of input order", () => {
  const card = buildCard(ITEM, [POINTS[1], POINTS[0]], null);
  assert.deepEqual(card.rubric_points.map((p) => p.ord), [1, 2]);
});

test("buildCard: serializes timestamps as ISO strings and labels the FSRS state", () => {
  const card = buildCard(ITEM, POINTS, null);
  assert.equal(card.due, "2026-08-24T09:00:00.000Z");
  assert.equal(card.created_at, "2026-06-06T12:00:00.000Z");
  assert.equal(card.last_review, "2026-08-10T09:00:00.000Z");
  assert.equal(card.state_label, "Review");
});

test("buildCard: a never-reviewed item has a null last_review and reads as New", () => {
  const card = buildCard({ ...ITEM, fsrs_state: 0, last_review: null }, POINTS, null);
  assert.equal(card.last_review, null);
  assert.equal(card.state_label, "New");
});

test("buildCard: a split child carries no note, no compression, and its parent link", () => {
  const child: ItemRow = {
    ...ITEM,
    id: "child1",
    note_path: null,
    parent_item_id: "item1",
    source_point_id: "p2",
    trap: null,
    followup: null,
  };
  const card = buildCard(child, [], null);
  assert.equal(card.note_path, null);
  assert.equal(card.compression, null);
  assert.equal(card.parent_item_id, "item1");
  assert.equal(card.source_point_id, "p2");
  assert.deepEqual(card.rubric_points, []);
});

test("buildCard: a fact item carries its answer", () => {
  const fact: ItemRow = { ...ITEM, type: "fact", answer: "Again, Hard, Good, Easy", trap: null };
  const card = buildCard(fact, [], null);
  assert.equal(card.type, "fact");
  assert.equal(card.answer, "Again, Hard, Good, Easy");
});

// --- auth -----------------------------------------------------------------

test("parseCookies: parses a multi-cookie header", () => {
  const c = parseCookies(`a=1; ${BROWSE_COOKIE}=secret; b=2`);
  assert.equal(c.a, "1");
  assert.equal(c[BROWSE_COOKIE], "secret");
  assert.equal(c.b, "2");
});

test("parseCookies: keeps '=' inside a value and tolerates a missing header", () => {
  assert.equal(parseCookies("t=abc=def").t, "abc=def");
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("isBrowseAuthorized: accepts a bearer header, a cookie, or a query token", () => {
  const t = "s3cret";
  assert.equal(isBrowseAuthorized({ authorization: `Bearer ${t}` }, t), true);
  assert.equal(isBrowseAuthorized({ cookie: `${BROWSE_COOKIE}=${t}` }, t), true);
  assert.equal(isBrowseAuthorized({ queryToken: t }, t), true);
});

test("isBrowseAuthorized: rejects a wrong or absent token", () => {
  const t = "s3cret";
  assert.equal(isBrowseAuthorized({}, t), false);
  assert.equal(isBrowseAuthorized({ queryToken: "" }, t), false);
  assert.equal(isBrowseAuthorized({ queryToken: "nope" }, t), false);
  assert.equal(isBrowseAuthorized({ cookie: `${BROWSE_COOKIE}=nope` }, t), false);
  assert.equal(isBrowseAuthorized({ authorization: `Bearer nope` }, t), false);
  assert.equal(isBrowseAuthorized({ authorization: t }, t), false, "raw header is not a bearer");
});
