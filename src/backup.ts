import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(__dirname, "..", "backups");
const KEEP = 14;
const DB = "engram";

/** Run a single pg_dump (custom format) and prune to the most recent KEEP files. */
export async function runBackup(date = new Date()): Promise<string> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = date.toISOString().slice(0, 10);
  const file = join(BACKUP_DIR, `engram-${stamp}.dump`);
  // peer auth: pg_dump connects as the claudedev OS user via local socket
  await execFileAsync("pg_dump", ["-Fc", DB, "-f", file]);
  prune();
  return file;
}

function prune(): void {
  const dumps = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("engram-") && f.endsWith(".dump"))
    .sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - KEEP))) {
    try {
      unlinkSync(join(BACKUP_DIR, old));
    } catch {
      /* best effort */
    }
  }
}

/** Schedule the daily backup (04:00 server time). */
export function startBackupCron(): void {
  cron.schedule("0 4 * * *", () => {
    runBackup()
      .then((f) => console.log(`[backup] wrote ${f}`))
      .catch((err) => console.error(`[backup] failed: ${(err as Error).message}`));
  });
}
