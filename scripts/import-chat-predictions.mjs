#!/usr/bin/env node
/**
 * Import System B (chat) predictions. Same rules as OSD's import-from-chat:
 * one file, one type, validated item by item; rejected items are listed with
 * the reason and the rest are appended. Nothing is overwritten.
 *
 *   node scripts/import-chat-predictions.mjs <answer.json> [--dry-run]
 *
 * Rejected: unknown id, no source URL, p_hit outside 0–1, wrong predictor,
 * predicted_at after the condition's deadline.
 *
 * The day's file is sealed by the next daily run (it seals every day whose
 * files changed since their last seal).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { DATA, appendJsonl, readJson } from "../lib/store.mjs";
import { PREDICTOR_B } from "../lib/predict.mjs";

const isUrl = (u) => typeof u === "string" && /^https?:\/\/\S+\.\S+/.test(u);
const isIso = (t) => typeof t === "string" && /^\d{4}-\d{2}-\d{2}T/.test(t) && !Number.isNaN(Date.parse(t));

/** Pure. `conditions` is data/state/conditions.json's list. */
export function planPredictions(payload, conditions) {
  if (payload?.type !== "predictions") return { errors: ['type must be "predictions"'] };
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) return { errors: ["items is empty"] };
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const rows = [];
  const rejected = [];
  const seen = new Set();
  for (const [i, it] of items.entries()) {
    const why = [];
    const c = byId.get(it?.id);
    if (!c) why.push("unknown id (not a predictable condition)");
    if (seen.has(it?.id)) why.push("duplicate id in this file");
    if (!(typeof it?.p_hit === "number" && it.p_hit >= 0 && it.p_hit <= 1)) why.push("p_hit must be a number in 0–1");
    if (typeof it?.reasoning !== "string" || !it.reasoning.trim()) why.push("reasoning is required");
    if (!Array.isArray(it?.sources) || it.sources.length === 0 || !it.sources.every(isUrl)) {
      why.push("sources must be a non-empty list of URLs");
    }
    if (!isIso(it?.predicted_at)) why.push("predicted_at must be an ISO timestamp");
    if (it?.predictor !== PREDICTOR_B) why.push(`predictor must be "${PREDICTOR_B}"`);
    if (c && isIso(it?.predicted_at) && it.predicted_at.slice(0, 10) > c.deadline) {
      why.push(`deadline ${c.deadline} has passed`);
    }
    seen.add(it?.id);
    if (why.length) {
      rejected.push({ index: i, id: it?.id ?? null, reasons: why });
      continue;
    }
    rows.push({
      id: it.id,
      predictor: PREDICTOR_B,
      p_hit: Math.round(it.p_hit * 1000) / 1000,
      reasoning: it.reasoning.trim(),
      sources: it.sources,
      predicted_at: it.predicted_at,
      target_date: c.target_date,
      deadline: c.deadline,
    });
  }
  return { rows, rejected };
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("usage: import-chat-predictions.mjs <answer.json> [--dry-run]");
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  const conds = readJson(path.join(DATA, "state", "conditions.json"), { conditions: [] }).conditions;
  const plan = planPredictions(payload, conds);
  if (plan.errors) {
    for (const e of plan.errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  for (const r of plan.rejected) console.error(`::warning::item ${r.index} (${r.id}): ${r.reasons.join("; ")}`);
  console.log(`[import] predictions: ${plan.rows.length} ${args.includes("--dry-run") ? "would apply" : "applied"}, ${plan.rejected.length} rejected`);
  if (args.includes("--dry-run") || plan.rows.length === 0) {
    if (plan.rows.length === 0) process.exitCode = 1;
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  appendJsonl(path.join(DATA, "predictions", `${day}.jsonl`), plan.rows);
  console.log(`[import] appended to data/predictions/${day}.jsonl`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
