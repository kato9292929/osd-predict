/**
 * Read-only access to the PUBLIC records for the API. Nothing under private/
 * is ever read here: the API runs without PRIVATE_DATA_KEY on purpose.
 */
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "data");

function days(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(DATA, dir))
      .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
      .filter((d): d is string => Boolean(d))
      .sort();
  } catch {
    return [];
  }
}

function jsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export function json<T>(rel: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface Prediction {
  id: string;
  predictor: string;
  p_hit: number;
  predicted_at: string;
  target_date: string;
  deadline: string;
  basis?: Record<string, unknown>;
  reasoning?: string;
  sources?: string[];
}

export function predictions(): Array<Prediction & { day: string }> {
  return days("predictions").flatMap((d) =>
    jsonl<Prediction>(path.join(DATA, "predictions", `${d}.jsonl`)).map((p) => ({ ...p, day: d })),
  );
}

export interface Seal {
  sealed_at: string;
  files: Record<string, string>;
  memo: string;
  memo_tx: string;
}

export function seals(day: string): Seal[] {
  return json<Seal[]>(`seals/${day}.json`, []);
}

export interface FlowIntelRow {
  mint: string;
  ticker: string;
  symbol: string;
  fetched_at: string;
  timeframe: string;
  data: unknown;
  purchase_tx: string | null;
}

export function flowIntel(): FlowIntelRow[] {
  return days("flows-public").flatMap((d) => jsonl<FlowIntelRow>(path.join(DATA, "flows-public", `${d}.jsonl`)));
}

export interface Condition {
  id: string;
  kind: string;
  population: string;
  ticker: string;
  company_name: string | null;
  success_condition: string;
  target_date: string;
  target_date_source: string;
  target_date_confirmed: string | null;
  deadline: string;
  date_verified: boolean;
  mints: Array<{ mint: string; symbol: string; issuer: string }>;
}

export function openConditions(): { as_of: string | null; conditions: Condition[] } {
  return json("state/conditions.json", { as_of: null, conditions: [] as Condition[] });
}

export const ATTRIBUTION = { text: "Powered by Nansen API", url: "https://nansen.ai" };
