import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "ts-fsrs";
import { computePriority, buildQueue, type QueueCandidate } from "../scheduler.js";

const RETENTION = 0.9;
const COSTS = { fact: 0.5, explanation: 4, project: 8 };
const NOW = new Date("2026-06-06T12:00:00Z");

function candidate(over: Partial<QueueCandidate>): QueueCandidate {
  return {
    id: "x",
    type: "explanation",
    title: "T",
    prompt: "P",
    due: NOW,
    reps: 1,
    lapses: 0,
    stability: 5,
    difficulty: 5,
    fsrs_state: State.Review,
    last_review: new Date("2026-06-01T12:00:00Z"),
    ...over,
  };
}

test("computePriority: New items have fixed priority 0.5", () => {
  const c = candidate({ fsrs_state: State.New, last_review: null, reps: 0, stability: null });
  assert.equal(computePriority(c, NOW, RETENTION), 0.5);
});

test("computePriority: lower retrievability yields higher priority", () => {
  const fresh = candidate({ last_review: new Date("2026-06-06T00:00:00Z"), stability: 50 });
  const stale = candidate({ last_review: new Date("2026-01-01T00:00:00Z"), stability: 2 });
  assert.ok(computePriority(stale, NOW, RETENTION) > computePriority(fresh, NOW, RETENTION));
});

test("computePriority: lapses increase priority via the lapse ratio", () => {
  const base = candidate({ reps: 4, lapses: 0 });
  const lapsey = candidate({ reps: 4, lapses: 3 });
  assert.ok(computePriority(lapsey, NOW, RETENTION) > computePriority(base, NOW, RETENTION));
});

test("buildQueue: never exceeds the time budget", () => {
  const items = Array.from({ length: 20 }, (_, i) =>
    candidate({ id: `e${i}`, type: "explanation", last_review: new Date("2026-01-01") })
  );
  const q = buildQueue(items, NOW, 15, COSTS, RETENTION);
  const total = q.reduce((s, e) => s + e.estimated_minutes, 0);
  assert.ok(total <= 15, `total ${total} must be <= 15`);
  // 15 / 4 = 3 explanations fit
  assert.equal(q.length, 3);
});

test("buildQueue: orders by priority (most-overdue/weakest first)", () => {
  const items = [
    candidate({ id: "fresh", last_review: new Date("2026-06-06T06:00:00Z"), stability: 100 }),
    candidate({ id: "stale", last_review: new Date("2026-01-01"), stability: 2 }),
  ];
  const q = buildQueue(items, NOW, 60, COSTS, RETENTION);
  assert.equal(q[0].id, "stale");
});

test("buildQueue: greedily fits smaller items when the top item doesn't fit", () => {
  // budget 3 min: one explanation (4m, highest priority) doesn't fit, but facts (0.5m) do
  const items = [
    candidate({ id: "exp", type: "explanation", last_review: new Date("2026-01-01"), stability: 1 }),
    candidate({ id: "f1", type: "fact", last_review: new Date("2026-05-01"), stability: 3 }),
    candidate({ id: "f2", type: "fact", last_review: new Date("2026-05-01"), stability: 3 }),
  ];
  const q = buildQueue(items, NOW, 3, COSTS, RETENTION);
  const ids = q.map((e) => e.id);
  assert.ok(!ids.includes("exp"), "the 4-min explanation should not fit a 3-min box");
  assert.ok(ids.includes("f1") && ids.includes("f2"));
});

test("buildQueue: reports estimated_minutes and clamped days_overdue", () => {
  const items = [candidate({ id: "a", type: "project", due: new Date("2026-06-01T12:00:00Z") })];
  const q = buildQueue(items, NOW, 60, COSTS, RETENTION);
  assert.equal(q[0].estimated_minutes, COSTS.project);
  assert.equal(q[0].days_overdue, 5);
});
