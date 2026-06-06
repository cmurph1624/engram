import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// config.json lives at the repo root, one level above src/ (and above dist/).
const CONFIG_PATH = join(__dirname, "..", "config.json");

export interface Config {
  vault_path: string;
  port: number;
  auth_token: string;
  database_url: string;
  test_database_url: string;
  default_time_budget_minutes: number;
  cost_estimates_minutes: { fact: number; explanation: number; project: number };
  project_first_interval_days: number;
  child_retirement_streak: number;
  fsrs: { request_retention: number };
}

let cached: Config | null = null;

export function loadConfig(path: string = CONFIG_PATH): Config {
  if (cached && path === CONFIG_PATH) return cached;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read config at ${path}: ${(err as Error).message}`);
  }
  const c = JSON.parse(raw) as Partial<Config>;

  const required: (keyof Config)[] = [
    "vault_path",
    "port",
    "auth_token",
    "database_url",
  ];
  for (const key of required) {
    if (c[key] === undefined || c[key] === null || c[key] === "") {
      throw new Error(`config.json missing required key: ${key}`);
    }
  }
  if (c.auth_token!.startsWith("<")) {
    throw new Error("config.json auth_token is still the placeholder — set a real secret");
  }

  const config: Config = {
    vault_path: c.vault_path!,
    port: c.port!,
    auth_token: c.auth_token!,
    database_url: c.database_url!,
    test_database_url: c.test_database_url ?? "",
    default_time_budget_minutes: c.default_time_budget_minutes ?? 15,
    cost_estimates_minutes: c.cost_estimates_minutes ?? {
      fact: 0.5,
      explanation: 4,
      project: 8,
    },
    project_first_interval_days: c.project_first_interval_days ?? 21,
    child_retirement_streak: c.child_retirement_streak ?? 2,
    fsrs: c.fsrs ?? { request_retention: 0.9 },
  };
  if (path === CONFIG_PATH) cached = config;
  return config;
}
