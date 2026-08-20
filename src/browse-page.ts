/**
 * The /browse page: a single self-contained HTML document (no bundler, no CDN —
 * the daemon has no static-asset pipeline and the build only copies migrations).
 * It fetches /api/cards once and does all filtering client-side.
 *
 * All card text is written with textContent, never innerHTML, so note content
 * can never execute as markup.
 */
export const BROWSE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Engram — cards</title>
<style>
  :root {
    --bg: #f7f6f3; --panel: #ffffff; --line: #e2ded6; --ink: #1e1c1a;
    --muted: #726c65; --accent: #7a5cff; --warn: #b4521a; --ok: #2f7a4f;
    --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17161a; --panel: #1f1e23; --line: #33313a; --ink: #eceaf0;
      --muted: #9a949f; --accent: #a996ff; --warn: #e9945e; --ok: #6fcf97;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: grid; grid-template-columns: 320px 1fr; height: 100vh; overflow: hidden;
  }
  /* ---- left: index ---- */
  aside { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .controls { padding: 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
  .controls input, .controls select {
    width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--panel); color: var(--ink); font-size: 14px;
  }
  .filters { display: flex; gap: 8px; }
  .count { font: 12px/1 var(--mono); color: var(--muted); padding-top: 2px; }
  ul#list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  ul#list li {
    padding: 9px 12px; border-bottom: 1px solid var(--line); cursor: pointer;
    display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: baseline;
  }
  ul#list li:hover { background: var(--panel); }
  ul#list li[aria-selected="true"] { background: var(--panel); box-shadow: inset 3px 0 0 var(--accent); }
  .li-title { font-size: 14px; }
  .li-meta { font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
  .retired .li-title { color: var(--muted); text-decoration: line-through; }
  /* ---- right: card ---- */
  main { overflow-y: auto; min-height: 0; padding: 28px 32px 96px; }
  .card { max-width: 760px; margin: 0 auto; }
  .crumb { font: 12px/1 var(--mono); color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  h1 { font-size: 26px; line-height: 1.25; margin: 10px 0 20px; }
  .badge {
    font: 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em;
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted);
  }
  .badge.type { color: var(--accent); border-color: var(--accent); }
  .badge.retired { color: var(--warn); border-color: var(--warn); }
  section.block { border-top: 1px solid var(--line); padding: 16px 0; }
  h2 {
    font: 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .1em;
    color: var(--muted); margin: 0 0 10px;
  }
  .text { white-space: pre-wrap; }
  .prompt { font-size: 18px; }
  ol.rubric { margin: 0; padding-left: 22px; }
  ol.rubric li { margin-bottom: 6px; }
  ol.rubric li[data-status="split"] { color: var(--warn); }
  ol.rubric li[data-status="retired"] { color: var(--muted); text-decoration: line-through; }
  .pstatus { font: 11px/1 var(--mono); color: var(--muted); margin-left: 6px; }
  .compression { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  dl.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px 18px; margin: 0; }
  dl.meta dt { font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  dl.meta dd { margin: 3px 0 0; font: 13px/1.4 var(--mono); }
  .empty { color: var(--muted); padding: 48px 0; text-align: center; }
  .hint { position: fixed; bottom: 0; right: 0; padding: 8px 14px; font: 11px/1 var(--mono);
          color: var(--muted); background: var(--bg); border-top: 1px solid var(--line);
          border-left: 1px solid var(--line); border-top-left-radius: 8px; }
  @media (max-width: 800px) {
    body { grid-template-columns: 1fr; grid-template-rows: 42vh 1fr; }
    aside { border-right: none; border-bottom: 1px solid var(--line); }
    main { padding: 20px 18px 80px; }
  }
</style>
</head>
<body>
<aside>
  <div class="controls">
    <input id="search" type="search" placeholder="Search title, prompt, rubric…  ( / )" autocomplete="off">
    <div class="filters">
      <select id="type"><option value="">all types</option><option>fact</option><option>explanation</option><option>project</option></select>
      <select id="status"><option value="active">active</option><option value="retired">retired</option><option value="">all</option></select>
    </div>
    <div class="count" id="count"></div>
  </div>
  <ul id="list" role="listbox" aria-label="Cards"></ul>
</aside>
<main><div class="card" id="card"></div></main>
<div class="hint">← → or j / k to flip · / to search</div>

<script>
(function () {
  var all = [], view = [], idx = 0;
  var listEl = document.getElementById("list");
  var cardEl = document.getElementById("card");
  var countEl = document.getElementById("count");
  var searchEl = document.getElementById("search");
  var typeEl = document.getElementById("type");
  var statusEl = document.getElementById("status");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toISOString().slice(0, 10);
  }
  function dueLabel(iso) {
    var days = Math.round((new Date(iso) - Date.now()) / 86400000);
    if (days < 0) return fmtDate(iso) + " (" + -days + "d overdue)";
    if (days === 0) return fmtDate(iso) + " (today)";
    return fmtDate(iso) + " (in " + days + "d)";
  }
  function num(v, digits) {
    return v === null || v === undefined ? "—" : Number(v).toFixed(digits);
  }

  function matches(c, q) {
    if (!q) return true;
    var hay = [c.title, c.prompt, c.answer, c.trap, c.followup, c.compression, c.id]
      .concat(c.rubric_points.map(function (p) { return p.text; }))
      .join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function applyFilters(keepId) {
    var q = searchEl.value.trim().toLowerCase();
    var t = typeEl.value, s = statusEl.value;
    view = all.filter(function (c) {
      return (!t || c.type === t) && (!s || c.status === s) && matches(c, q);
    });
    var at = keepId ? view.findIndex(function (c) { return c.id === keepId; }) : -1;
    idx = at >= 0 ? at : 0;
    renderList();
    renderCard();
  }

  function renderList() {
    listEl.textContent = "";
    view.forEach(function (c, i) {
      var li = el("li", c.status === "retired" ? "retired" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === idx ? "true" : "false");
      li.appendChild(el("span", "li-title", c.title));
      li.appendChild(el("span", "li-meta", c.type.slice(0, 4) + " · " + fmtDate(c.due)));
      li.addEventListener("click", function () { idx = i; renderList(); renderCard(); });
      listEl.appendChild(li);
    });
    countEl.textContent = view.length
      ? (idx + 1) + " / " + view.length + " shown · " + all.length + " total"
      : "0 of " + all.length + " match";
    var sel = listEl.children[idx];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function block(title, node) {
    var s = el("section", "block");
    s.appendChild(el("h2", null, title));
    s.appendChild(node);
    return s;
  }

  function renderCard() {
    cardEl.textContent = "";
    var c = view[idx];
    if (!c) {
      cardEl.appendChild(el("p", "empty", all.length ? "No card matches those filters." : "No cards yet."));
      return;
    }

    var crumb = el("div", "crumb");
    crumb.appendChild(el("span", null, (idx + 1) + " / " + view.length));
    crumb.appendChild(el("span", "badge type", c.type));
    if (c.status === "retired") crumb.appendChild(el("span", "badge retired", "retired"));
    crumb.appendChild(el("span", "badge", c.state_label));
    if (c.parent_item_id) crumb.appendChild(el("span", "badge", "split child"));
    crumb.appendChild(el("span", null, c.id));
    cardEl.appendChild(crumb);
    cardEl.appendChild(el("h1", null, c.title));

    cardEl.appendChild(block("Prompt", el("div", "text prompt", c.prompt)));
    if (c.answer) cardEl.appendChild(block("Answer", el("div", "text", c.answer)));

    if (c.rubric_points.length) {
      var ol = el("ol", "rubric");
      c.rubric_points.forEach(function (p) {
        var li = el("li", null, p.text);
        li.setAttribute("data-status", p.status);
        if (p.status !== "active") li.appendChild(el("span", "pstatus", "(" + p.status + ")"));
        ol.appendChild(li);
      });
      cardEl.appendChild(block("Rubric", ol));
    }

    if (c.trap) cardEl.appendChild(block("Trap", el("div", "text", c.trap)));
    if (c.followup) cardEl.appendChild(block("Follow-up", el("div", "text", c.followup)));
    if (c.compression) cardEl.appendChild(block("Compression", el("div", "text compression", c.compression)));

    var dl = el("dl", "meta");
    [
      ["due", dueLabel(c.due)],
      ["last review", fmtDate(c.last_review)],
      ["reps / lapses", c.reps + " / " + c.lapses],
      ["stability", num(c.stability, 1)],
      ["difficulty", num(c.difficulty, 1)],
      ["created", fmtDate(c.created_at)],
      ["note", c.note_path || "—"],
      ["parent", c.parent_item_id || "—"]
    ].forEach(function (row) {
      dl.appendChild(el("dt", null, row[0]));
      dl.appendChild(el("dd", null, row[1]));
    });
    cardEl.appendChild(block("Scheduling", dl));
    document.querySelector("main").scrollTop = 0;
  }

  function move(delta) {
    if (!view.length) return;
    idx = Math.min(view.length - 1, Math.max(0, idx + delta));
    renderList();
    renderCard();
  }

  document.addEventListener("keydown", function (e) {
    if (e.target === searchEl) {
      if (e.key === "Escape") { searchEl.blur(); }
      return;
    }
    if (e.key === "/") { e.preventDefault(); searchEl.focus(); return; }
    if (e.key === "ArrowRight" || e.key === "j" || e.key === " ") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { idx = 0; renderList(); renderCard(); }
    else if (e.key === "End") { idx = view.length - 1; renderList(); renderCard(); }
  });

  [searchEl, typeEl, statusEl].forEach(function (n) {
    n.addEventListener("input", function () {
      var cur = view[idx];
      applyFilters(cur && cur.id);
    });
  });

  fetch("/api/cards", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) { all = data.cards; applyFilters(); })
    .catch(function (err) {
      cardEl.appendChild(el("p", "empty", "Could not load cards: " + err.message));
    });
})();
</script>
</body>
</html>
`;
