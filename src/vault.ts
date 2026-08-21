import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import matter from "gray-matter";
import { setFrontmatterValue } from "./notes.js";

/** Absolute path for a vault-relative note path. */
export function abs(vaultPath: string, relPath: string): string {
  return join(vaultPath, relPath);
}

export function noteExists(vaultPath: string, relPath: string): boolean {
  return existsSync(abs(vaultPath, relPath));
}

/** Write a note, creating parent dirs. Throws if the file already exists. */
export function writeNote(vaultPath: string, relPath: string, content: string): void {
  const full = abs(vaultPath, relPath);
  if (existsSync(full)) throw new Error(`note already exists: ${relPath}`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

export function readNote(vaultPath: string, relPath: string): string {
  return readFileSync(abs(vaultPath, relPath), "utf8");
}

export function deleteNoteIfExists(vaultPath: string, relPath: string): void {
  const full = abs(vaultPath, relPath);
  try {
    if (existsSync(full)) unlinkSync(full);
  } catch {
    /* best effort */
  }
}

const SKIP_DIRS = new Set([".obsidian", ".git", "node_modules", ".trash"]);

/** Recursively find all markdown files with `srs: true` frontmatter. */
export function walkSrsNotes(
  vaultPath: string
): { relPath: string; content: string; data: Record<string, unknown> }[] {
  const out: { relPath: string; content: string; data: Record<string, unknown> }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const full = join(dir, entry.name);
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (!/^---[\s\S]*?\bsrs:\s*true\b/m.test(content)) continue;
        const { data } = matter(content);
        if (data.srs !== true) continue;
        out.push({ relPath: relative(vaultPath, full).split(sep).join("/"), content, data });
      }
    }
  }
  walk(vaultPath);
  return out;
}

/**
 * Flip a note's `srs` frontmatter flag, preserving the rest of the file byte
 * for byte. Setting it false is how a deleted item's note stops advertising
 * itself to `scan_vault` while the writing survives as an ordinary note.
 */
export function setSrsFlag(vaultPath: string, relPath: string, value: boolean): void {
  const full = abs(vaultPath, relPath);
  const raw = readFileSync(full, "utf8");
  writeFileSync(full, setFrontmatterValue(raw, "srs", value ? "true" : "false"), "utf8");
}

/** Stamp an `srs_id` into an existing note's frontmatter, preserving body. */
export function stampSrsId(vaultPath: string, relPath: string, srsId: string): void {
  const full = abs(vaultPath, relPath);
  const raw = readFileSync(full, "utf8");
  writeFileSync(full, setFrontmatterValue(raw, "srs_id", `"${srsId}"`), "utf8");
}

export { statSync };
