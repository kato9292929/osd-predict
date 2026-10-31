#!/usr/bin/env node
/**
 * Write the weekly System B input for chat: the predictable conditions, System
 * A's current p for each, and the last 7 days of flows.
 *
 * The file contains Nansen Smart Money Netflows (internal-use data), so it is
 * written to .local/ (git-ignored) and must not be committed or published.
 * Flow Intelligence rows are redistributable and are included as well.
 *
 *   node scripts/export-for-chat.mjs [--date YYYY-MM-DD]
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/money.mjs";
import { DATA, privateDays, publicDays, readJson, readJsonl, readPrivate } from "../lib/store.mjs";
import { PREDICTOR_A, PREDICTOR_B, flowState } from "../lib/predict.mjs";

const args = process.argv.slice(2);
const di = args.indexOf("--date");
const today = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);
const key = process.env.PRIVATE_DATA_KEY;

const conds = readJson(path.join(DATA, "state", "conditions.json"), { conditions: [] }).conditions.filter(
  (c) => c.deadline >= today,
);
const preds = publicDays("predictions").flatMap((d) => readJsonl(path.join(DATA, "predictions", `${d}.jsonl`)));
const lastA = new Map();
for (const p of preds) if (p.predictor === PREDICTOR_A) lastA.set(p.id, p);

const weekAgo = new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10);
const flows = key
  ? privateDays("flows").filter((d) => d >= weekAgo && d <= today).flatMap((d) => readPrivate("flows", d, key))
  : [];
const fi = publicDays("flows-public")
  .filter((d) => d >= weekAgo && d <= today)
  .flatMap((d) => readJsonl(path.join(DATA, "flows-public", `${d}.jsonl`)));

const cell = (v) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "／").replace(/\n+/g, " "));
const L = [];
L.push(`# osd-predict 系統B 入力 ${today}`);
L.push("");
L.push("> 内部用。Nansen Smart Money Netflows（再配布不可のデータ）を含むので、公開・コミットしない。");
L.push("");
L.push(`返答は {"type":"predictions","items":[{"id","p_hit","reasoning","sources":[URL],"predicted_at","predictor":"${PREDICTOR_B}"}]}。`);
L.push("sources に URL のない予測と、締切（deadline）を過ぎた条件への予測は取り込まれない。p_hit は hit=1・partial=0.5・miss=0 の期待値として 0〜1 で。");
L.push("");
L.push(`## 予測する条件（${conds.length}件）`);
L.push("");
for (const c of conds.sort((a, b) => (a.deadline < b.deadline ? -1 : 1))) {
  const a = lastA.get(c.id);
  L.push(`### ${c.id}`);
  L.push("");
  L.push(`- 母集団: ${c.population} / ${c.ticker} ${cell(c.company_name)}`);
  L.push(`- success_condition: ${c.success_condition}`);
  L.push(`- fail_direction: ${cell(c.fail_direction)}`);
  L.push(`- deadline: ${c.deadline}（target_date ${c.target_date}${c.date_verified ? "・会社の公表日と照合済み" : "・未照合"}）`);
  L.push(`- 系統A: ${a ? a.p_hit : "—"}${a ? `（母集団 n=${a.basis.population_n}）` : ""}`);
  if (c.mints?.length) {
    const rows = flows.filter((f) => c.mints.some((m) => m.mint === f.mint));
    const byDay = new Map();
    for (const r of rows) byDay.set(r.fetched_at.slice(0, 10), [...(byDay.get(r.fetched_at.slice(0, 10)) ?? []), r]);
    for (const [d, rs] of [...byDay].sort()) {
      const s = flowState(rs);
      L.push(`  - smart money ${d}: ${s.state}（7d ${Math.round(s.net_flow_7d_usd)} USD・trader ${s.trader_count}）`);
    }
    const f = fi.filter((r) => c.mints.some((m) => m.mint === r.mint)).at(-1);
    if (f) L.push(`  - flow intelligence ${f.fetched_at.slice(0, 10)}: ${cell(JSON.stringify(f.data)).slice(0, 400)}`);
  }
  L.push("");
}

const out = path.join(ROOT, ".local", "chat-input", `${today}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${L.join("\n")}\n`);
console.log(`[export] ${path.relative(ROOT, out)}: ${conds.length} conditions, ${flows.length} netflow rows, ${fi.length} flow-intelligence rows`);
