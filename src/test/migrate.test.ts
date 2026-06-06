import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { migrate } from "../migrate.js";
import { testPool, resetSchema } from "./helpers.js";

let p: pg.Pool;

before(async () => {
  p = testPool();
  await resetSchema(p);
});

after(async () => {
  await p.end();
});

test("migrate applies 001 on a clean database", async () => {
  const applied = await migrate(p);
  assert.deepEqual(applied, [1]);

  // schema version recorded
  const { rows } = await p.query<{ version: number }>("SELECT version FROM meta WHERE id = 1");
  assert.equal(rows[0].version, 1);

  // core tables exist
  for (const tbl of ["items", "rubric_points", "reviews", "point_scores"]) {
    const r = await p.query("SELECT to_regclass($1) AS reg", [tbl]);
    assert.equal(r.rows[0].reg, tbl, `table ${tbl} should exist`);
  }
});

test("migrate is a no-op when already at latest version", async () => {
  const applied = await migrate(p);
  assert.deepEqual(applied, []);
});
