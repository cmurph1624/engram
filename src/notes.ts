import matter from "gray-matter";

export type SrsType = "fact" | "explanation" | "project";

export interface RenderOptions {
  srs_id: string;
  srs_type: SrsType;
  title: string;
  date: string;
  tags?: string[];
  compression: string;
  prompt: string;
  rubric_points?: string[];
  trap?: string;
  followup?: string;
  answer?: string;
  links?: string[];
}

export interface ParsedNote {
  srs: boolean;
  srs_id: string | undefined;
  srs_type: SrsType | undefined;
  title: string;
  prompt: string;
  rubric_points: string[];
  trap?: string;
  followup?: string;
  answer?: string;
}

/** Render a concept note in the canonical Engram format (see V2 Build Spec). */
export function renderNote(o: RenderOptions): string {
  const tags = o.tags && o.tags.length ? o.tags : ["concept"];
  const fm = [
    "---",
    `date: ${o.date}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "srs: true",
    `srs_id: "${o.srs_id}"`,
    `srs_type: ${o.srs_type}`,
    "---",
  ].join("\n");

  const body: string[] = [`# ${o.title}`, "", "## Compression", "", o.compression.trim(), ""];

  if (o.srs_type === "fact") {
    body.push("## Question", "", o.prompt.trim(), "");
    body.push("## Answer", "", (o.answer ?? "").trim(), "");
  } else {
    body.push("## Prompt", "", o.prompt.trim(), "");
    body.push("## Rubric", "");
    for (const p of o.rubric_points ?? []) body.push(`- ${p}`);
    body.push("");
    if (o.trap) body.push(`**Trap:** ${o.trap}`);
    if (o.followup) body.push(`**Follow-up:** ${o.followup}`);
    if (o.trap || o.followup) body.push("");
  }

  if (o.links && o.links.length) {
    body.push("## Links", "");
    for (const l of o.links) body.push(`- [[${l}]]`);
    body.push("");
  }

  return `${fm}\n\n${body.join("\n").trimEnd()}\n`;
}

/**
 * Set one scalar key in a note's YAML frontmatter, rewriting only that line.
 *
 * Deliberately NOT a gray-matter round-trip. Re-serialising the block turns
 * `date: 2026-06-06` into `date: 2026-06-06T00:00:00.000Z`, drops quoting and
 * can reflow lists — i.e. it silently rewrites hand-authored vault notes, and
 * Syncthing carries the damage to the Mac. `value` is raw YAML scalar text.
 */
export function setFrontmatterValue(content: string, key: string, value: string): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) throw new Error("note has no frontmatter block");

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (at === -1) lines.push(`${key}: ${value}`);
  else lines[at] = `${key}: ${value}`;

  const block = `---${eol}${lines.join(eol)}${eol}---${m[2] ? eol : ""}`;
  return block + content.slice(m[0].length);
}

/** Split a markdown body into `## Heading` -> text sections. */
export function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const text = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    out.set(heading, text);
  }
  return out;
}

/**
 * Parse a concept note. Note text is canonical for prompt / rubric / trap /
 * followup / answer; the DB is reconciled from this. The `## Compression`
 * section is intentionally never surfaced — it is the human's private encoding.
 */
export function parseNote(content: string): ParsedNote {
  const { data, content: body } = matter(content);

  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const sec = sections(body);
  const srs_type = (data.srs_type as SrsType | undefined) ?? undefined;

  let prompt = "";
  let answer: string | undefined;
  const rubric_points: string[] = [];

  if (srs_type === "fact") {
    prompt = (sec.get("Question") ?? "").trim();
    answer = (sec.get("Answer") ?? "").trim();
  } else {
    prompt = (sec.get("Prompt") ?? "").trim();
    const rubric = sec.get("Rubric") ?? "";
    for (const line of rubric.split("\n")) {
      const t = line.trim();
      if (t.startsWith("- ") && !t.includes("[[")) rubric_points.push(t.slice(2).trim());
    }
  }

  // Trap / Follow-up may appear anywhere in the body; scan all lines.
  let trap: string | undefined;
  let followup: string | undefined;
  for (const line of body.split("\n")) {
    const trapM = line.match(/^\*\*Trap:\*\*\s*(.+)$/);
    if (trapM) trap = trapM[1].trim();
    const fuM = line.match(/^\*\*Follow-?up:\*\*\s*(.+)$/);
    if (fuM) followup = fuM[1].trim();
  }

  return {
    srs: data.srs === true,
    srs_id: data.srs_id ? String(data.srs_id) : undefined,
    srs_type,
    title,
    prompt,
    rubric_points,
    trap,
    followup,
    answer,
  };
}
