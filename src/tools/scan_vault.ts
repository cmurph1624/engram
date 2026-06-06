import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getPool, withTransaction } from "../db.js";
import { getItem, getRubricPoints, insertItem, insertRubricPoint, setRubricPointStatus } from "../repo.js";
import { parseNote, type ParsedNote } from "../notes.js";
import { walkSrsNotes, noteExists, stampSrsId } from "../vault.js";
import { json, logToolCall } from "./util.js";

async function reconcileRubric(client: PoolClient, itemId: string, parsed: ParsedNote): Promise<void> {
  const existing = (await getRubricPoints(itemId, client)).filter((p) => p.status !== "retired");
  const byOrd = new Map(existing.map((p) => [p.ord, p]));
  const lines = parsed.rubric_points;

  for (let ord = 0; ord < lines.length; ord++) {
    const cur = byOrd.get(ord);
    if (!cur) {
      await insertRubricPoint({ id: nanoid(), item_id: itemId, ord, text: lines[ord] }, client);
    } else if (cur.text !== lines[ord]) {
      await client.query(`UPDATE rubric_points SET text = $2 WHERE id = $1`, [cur.id, lines[ord]]);
    }
  }
  // retire active points whose ord is beyond the note's current list
  for (const p of existing) {
    if (p.ord >= lines.length && p.status === "active") {
      await setRubricPointStatus(p.id, "retired", client);
    }
  }
}

export function register(server: McpServer, config: Config): void {
  server.tool(
    "scan_vault",
    "Walk the vault for `srs: true` notes. New notes (no/unknown srs_id) are registered and stamped with an srs_id (the only vault write outside create_item). Known notes are reconciled — prompt/rubric/trap/followup/answer text and moved paths. Deleted notes are reported, not auto-retired.",
    {},
    async () => {
      logToolCall("scan_vault", {});
      const registered: { id: string; note_path: string }[] = [];
      const updated: { id: string; note_path: string }[] = [];
      const seenPaths = new Set<string>();

      for (const note of walkSrsNotes(config.vault_path)) {
        const parsed = parseNote(note.content);
        const srsType = parsed.srs_type ?? "explanation";
        seenPaths.add(note.relPath);

        const existing = parsed.srs_id ? await getItem(parsed.srs_id) : null;

        if (!existing) {
          // register (mint id if the note has none, else adopt its srs_id)
          const id = parsed.srs_id ?? nanoid();
          const due =
            srsType === "project"
              ? new Date(Date.now() + config.project_first_interval_days * 86_400_000)
              : new Date();
          await withTransaction(async (client) => {
            await insertItem(
              {
                id,
                type: srsType,
                note_path: note.relPath,
                title: parsed.title || note.relPath,
                prompt: parsed.prompt,
                answer: srsType === "fact" ? parsed.answer ?? null : null,
                trap: srsType === "fact" ? null : parsed.trap ?? null,
                followup: srsType === "fact" ? null : parsed.followup ?? null,
                due,
              },
              client
            );
            if (srsType !== "fact") {
              for (let i = 0; i < parsed.rubric_points.length; i++) {
                await insertRubricPoint(
                  { id: nanoid(), item_id: id, ord: i, text: parsed.rubric_points[i] },
                  client
                );
              }
            }
          });
          if (!parsed.srs_id) stampSrsId(config.vault_path, note.relPath, id);
          registered.push({ id, note_path: note.relPath });
        } else {
          // reconcile content + path
          await withTransaction(async (client) => {
            await client.query(
              `UPDATE items SET note_path=$2, title=$3, prompt=$4, answer=$5, trap=$6, followup=$7 WHERE id=$1`,
              [
                existing.id,
                note.relPath,
                parsed.title || existing.title,
                parsed.prompt || existing.prompt,
                srsType === "fact" ? parsed.answer ?? null : null,
                srsType === "fact" ? null : parsed.trap ?? null,
                srsType === "fact" ? null : parsed.followup ?? null,
              ]
            );
            if (srsType !== "fact") await reconcileRubric(client, existing.id, parsed);
          });
          updated.push({ id: existing.id, note_path: note.relPath });
        }
      }

      // deleted notes: DB items with a note_path whose file no longer exists
      const { rows } = await getPool().query<{ id: string; note_path: string }>(
        `SELECT id, note_path FROM items WHERE note_path IS NOT NULL AND status = 'active'`
      );
      const missing = rows.filter(
        (r) => !seenPaths.has(r.note_path) && !noteExists(config.vault_path, r.note_path)
      );

      return json({ registered, updated, missing });
    }
  );
}
