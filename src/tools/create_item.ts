import { z } from "zod";
import { nanoid } from "nanoid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db.js";
import { insertItem, insertRubricPoint } from "../repo.js";
import { renderNote } from "../notes.js";
import { writeNote, noteExists, deleteNoteIfExists } from "../vault.js";
import { json, errorResult, logToolCall } from "./util.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Strip trailing slashes and normalise Windows separators to POSIX. */
function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Reject anything that would escape the vault or smuggle a separator into a
 * filename. `join()` silently resolves `..`, so without this a note_folder of
 * `../../etc` writes outside the vault entirely.
 */
function validatePathParts(folder: string, title: string): string | null {
  if (/^([a-zA-Z]:|[/\\])/.test(folder)) {
    return `note_folder must be vault-relative, not absolute: "${folder}"`;
  }
  const segments = folder.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) {
    return `note_folder must not contain "." or ".." segments — that resolves outside the vault: "${folder}"`;
  }
  if (/[/\\]/.test(title)) {
    return `title must not contain a path separator: "${title}" — use note_folder for the location`;
  }
  if (title === "." || title === ".." || title.trim() === "") {
    return `invalid title: "${title}"`;
  }
  return null;
}

export function register(server: McpServer, config: Config): void {
  server.tool(
    "create_item",
    "Create a reviewable item and write its concept note to the vault. The compression (the human-written explanation) is stored verbatim and never parsed. Item starts New and due now (project items due after the configured first interval).",
    {
      type: z.enum(["fact", "explanation", "project"]),
      title: z.string().describe("Note title and filename (within note_folder)."),
      note_folder: z.string().describe("Vault-relative folder for the note, e.g. '30 Resources/Concepts'."),
      domain: z
        .string()
        .optional()
        .describe(
          config.concept_domains.length
            ? `Routes the note to <note_folder>/Concepts/<domain>/. One of: ${config.concept_domains.join("; ")}.`
            : "Routes the note to <note_folder>/Concepts/<domain>/. No domains configured."
        ),
      compression: z.string().describe("The human-written explanation. Stored verbatim, never parsed."),
      prompt: z.string().describe("The question (fact) or explanation prompt (explanation/project)."),
      audience: z.string().optional().describe("Who the explanation is for; baked into the prompt."),
      rubric_points: z.array(z.string()).optional().describe("3-5 gradeable claims (explanation/project)."),
      trap: z.string().optional(),
      followup: z.string().optional(),
      answer: z.string().optional().describe("Fact items only."),
      links: z.array(z.string()).optional().describe("Wikilink targets (without [[ ]])."),
      tags: z.array(z.string()).optional(),
    },
    async (a) => {
      logToolCall("create_item", { type: a.type, domain: a.domain });
      const id = nanoid();
      const folder = normalizeFolder(a.note_folder);

      const pathError = validatePathParts(folder, a.title);
      if (pathError) return errorResult(pathError);

      if (a.domain !== undefined) {
        if (!config.concept_domains.includes(a.domain)) {
          return errorResult(
            `unknown domain "${a.domain}". Valid domains: ${config.concept_domains.join("; ")}`
          );
        }
      }

      const targetFolder = a.domain ? `${folder}/Concepts/${a.domain}` : folder;

      // Track roots are organised into Concepts/<domain>/; a flat write there is
      // the drift this guard exists to stop.
      if (config.protected_note_folders.map(normalizeFolder).includes(targetFolder)) {
        const options = config.concept_domains.length
          ? config.concept_domains.map((d) => `Concepts/${d}`).join("; ")
          : "a subfolder";
        return errorResult(
          `"${targetFolder}" does not take notes directly — pass a \`domain\` so the note is routed to one of: ${options}`
        );
      }

      const relPath = `${targetFolder}/${a.title}.md`;

      if (noteExists(config.vault_path, relPath)) {
        return errorResult(`note already exists: ${relPath}`);
      }

      const prompt = a.audience ? `${a.prompt}\n\n(Audience: ${a.audience})` : a.prompt;
      const due =
        a.type === "project"
          ? new Date(Date.now() + config.project_first_interval_days * 86_400_000)
          : new Date();

      const note = renderNote({
        srs_id: id,
        srs_type: a.type,
        title: a.title,
        date: today(),
        tags: a.tags,
        compression: a.compression,
        prompt,
        rubric_points: a.rubric_points,
        trap: a.trap,
        followup: a.followup,
        answer: a.answer,
        links: a.links,
      });

      try {
        await withTransaction(async (client) => {
          await insertItem(
            {
              id,
              type: a.type,
              note_path: relPath,
              title: a.title,
              prompt,
              answer: a.type === "fact" ? a.answer ?? null : null,
              trap: a.type === "fact" ? null : a.trap ?? null,
              followup: a.type === "fact" ? null : a.followup ?? null,
              due,
            },
            client
          );
          if (a.type !== "fact") {
            const points = a.rubric_points ?? [];
            for (let i = 0; i < points.length; i++) {
              await insertRubricPoint({ id: nanoid(), item_id: id, ord: i, text: points[i] }, client);
            }
          }
          // write the note last so a write failure rolls the transaction back
          writeNote(config.vault_path, relPath, note);
        });
      } catch (err) {
        // commit may have failed after the note was written — clean it up
        deleteNoteIfExists(config.vault_path, relPath);
        return errorResult(`create_item failed: ${(err as Error).message}`);
      }

      return json({ id, note_path: relPath, due: due.toISOString() });
    }
  );
}
