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

export function register(server: McpServer, config: Config): void {
  server.tool(
    "create_item",
    "Create a reviewable item and write its concept note to the vault. The compression (the human-written explanation) is stored verbatim and never parsed. Item starts New and due now (project items due after the configured first interval).",
    {
      type: z.enum(["fact", "explanation", "project"]),
      title: z.string().describe("Note title and filename (within note_folder)."),
      note_folder: z.string().describe("Vault-relative folder for the note, e.g. '30 Resources/Concepts'."),
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
      logToolCall("create_item", { type: a.type });
      const id = nanoid();
      const relPath = `${a.note_folder.replace(/\/+$/, "")}/${a.title}.md`;

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
