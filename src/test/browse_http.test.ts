import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { initPool, getPool, closePool } from "../db.js";
import { migrate } from "../migrate.js";
import { insertItem, insertRubricPoint } from "../repo.js";
import { createApp } from "../app.js";
import { BROWSE_COOKIE } from "../browse.js";

const TOKEN = "test-token-not-a-secret";

let server: Server;
let base: string;

function url(path: string): string {
  return `${base}${path}`;
}

before(async () => {
  const cfg = loadConfig();
  initPool(cfg.test_database_url);
  await migrate();
  await getPool().query(
    "TRUNCATE point_scores, reviews, rubric_points, items RESTART IDENTITY CASCADE"
  );
  await insertItem(
    {
      id: "http1",
      type: "explanation",
      title: "HTTP Card",
      prompt: "Explain the route.",
      trap: "the trap",
      followup: "the follow-up",
      due: new Date("2026-08-05T00:00:00Z"),
    },
    getPool()
  );
  await insertRubricPoint({ id: "hp1", item_id: "http1", ord: 1, text: "a point" }, getPool());

  const config: Config = {
    ...cfg,
    auth_token: TOKEN,
    vault_path: mkdtempSync(join(tmpdir(), "engram-http-")),
  };
  server = createApp(config).listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

test("GET /browse without credentials is rejected", async () => {
  const res = await fetch(url("/browse"), { redirect: "manual" });
  assert.equal(res.status, 401);
});

test("GET /browse?token= sets the cookie and bounces the token out of the URL", async () => {
  const res = await fetch(url(`/browse?token=${TOKEN}`), { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/browse");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`${BROWSE_COOKIE}=${TOKEN}`));
  assert.match(cookie, /HttpOnly/i);
});

test("GET /browse?token=wrong is rejected", async () => {
  const res = await fetch(url("/browse?token=wrong"), { redirect: "manual" });
  assert.equal(res.status, 401);
});

test("GET /browse with the cookie serves the page", async () => {
  const res = await fetch(url("/browse"), { headers: { cookie: `${BROWSE_COOKIE}=${TOKEN}` } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Engram — cards<\/title>/);
  assert.match(html, /\/api\/cards/);
});

test("GET /api/cards without credentials is rejected", async () => {
  const res = await fetch(url("/api/cards"));
  assert.equal(res.status, 401);
});

test("GET /api/cards returns full cards to an authorised caller", async () => {
  const res = await fetch(url("/api/cards"), { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  const card = body.cards[0];
  assert.equal(card.id, "http1");
  assert.equal(card.prompt, "Explain the route.");
  assert.equal(card.trap, "the trap");
  assert.deepEqual(card.rubric_points.map((p: { text: string }) => p.text), ["a point"]);
});

test("/health still answers without auth", async () => {
  const res = await fetch(url("/health"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("/mcp still requires the bearer token", async () => {
  const res = await fetch(url("/mcp"), { method: "POST" });
  assert.equal(res.status, 401);
  const withCookie = await fetch(url("/mcp"), {
    method: "POST",
    headers: { cookie: `${BROWSE_COOKIE}=${TOKEN}` },
  });
  assert.equal(withCookie.status, 401, "the browse cookie must not unlock /mcp");
});
