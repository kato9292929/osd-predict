/**
 * OSD (Onchain Stock Data) as an input.
 *
 * The free route is the public OSD repository: every condition and verdict is
 * committed there as JSON, so the list of pending conditions, the judged
 * history the base rates are built from, and the Solana token list all come
 * from raw.githubusercontent.com at no cost.
 *
 * The paid route (/api/solana-stocks/{ticker}?view=full, x402) returns the same
 * record per ticker. osd-predict buys it on the rules in `shouldBuyOsd` to keep
 * the x402 purchase path running end to end — not because the content is
 * otherwise unavailable. It is our own agent buying our own data, so it is not
 * evidence of outside demand.
 */
import { collectRows, judgeableFrom, GRACE_DAYS } from "../vendor/osd-chat-ops.mjs";
import { LIMITS } from "./money.mjs";

const FILES = {
  usEvals: "data/portfolio-evaluations.json",
  usHistory: "data/portfolio-history.json",
  jpEvals: "data/jp-portfolio-evaluations.json",
  jpHistory: "data/jp-portfolio-history.json",
  externals: "data/external-catalysts.json",
  irFair: "data/ir-fair-2026-catalysts.json",
  solanaStocks: "data/solana-stocks.json",
};

export async function loadOsdFiles({ base = LIMITS.osd.raw_base_url, fetchImpl = fetch } = {}) {
  const out = {};
  for (const [k, rel] of Object.entries(FILES)) {
    const r = await fetchImpl(`${base}/${rel}`);
    if (!r.ok) throw new Error(`OSD ${rel}: HTTP ${r.status}`);
    out[k] = await r.json();
  }
  return out;
}

/** The deadline after which no prediction may be made: the later of the two dates. */
export function deadlineOf(row) {
  const t = row.target_date;
  const c = row.target_date_confirmed;
  return c && c > t ? c : t;
}

/** ticker → Solana mints (xStocks, Ondo). */
export function mintsByTicker(solanaStocks) {
  const m = new Map();
  for (const t of solanaStocks?.tokens ?? []) {
    const list = m.get(t.ticker) ?? [];
    list.push({ mint: t.solana_mint, symbol: t.symbol, issuer: t.issuer });
    m.set(t.ticker, list);
  }
  return m;
}

const SCORED = new Set(["hit", "partial", "miss"]);

/**
 * Every OSD condition, normalised, plus what this agent needs:
 *   deadline        max(target_date, target_date_confirmed)
 *   date_verified   the deadline was checked against the company
 *   mints           Solana tokens of the underlying (US names only)
 * `ref` (the raw OSD row) is dropped — nothing here writes back to OSD.
 */
export function conditions(files) {
  const mints = mintsByTicker(files.solanaStocks);
  return collectRows(files).map(({ ref, ...r }) => ({
    ...r,
    deadline: r.target_date ? deadlineOf(r) : null,
    date_verified: r.target_date_source === "verified",
    catalyst_type: r.catalyst_type ?? null,
    // JP codes never have a Solana token; only US tickers and US external
    // catalysts can.
    mints: r.kind === "jp" || r.kind === "irf" ? [] : mints.get(r.ticker) ?? [],
    judged_at: ref?.evaluated_at ?? ref?.judgement_date ?? null,
  }));
}

/** Pending conditions whose deadline has not passed — the ones we may predict. */
export function predictable(all, today) {
  return all.filter((r) => r.status === "pending" && r.deadline && r.deadline >= today);
}

/** Conditions with an outcome that scores (hit / partial / miss). */
export function judged(all) {
  return all.filter((r) => SCORED.has(r.status));
}

export function outcomeOf(status) {
  return status === "hit" ? 1 : status === "partial" ? 0.5 : status === "miss" ? 0 : null;
}

/** Summary used for the day-over-day diff (step 1). */
export function snapshot(all, today) {
  const pending = all.filter((r) => r.status === "pending").map((r) => r.id).sort();
  const judgedRows = all
    .filter((r) => r.status !== "pending" && r.status !== "excluded")
    .map((r) => ({ id: r.id, status: r.status, kind: r.kind, ticker: r.ticker }));
  return { as_of: today, pending, judged: judgedRows };
}

export function diffSnapshots(prev, next) {
  const before = new Set(prev?.pending ?? []);
  const judgedBefore = new Map((prev?.judged ?? []).map((j) => [j.id, j.status]));
  return {
    new_pending: next.pending.filter((id) => !before.has(id)),
    newly_judged: next.judged.filter((j) => judgedBefore.get(j.id) !== j.status),
    pending_count: next.pending.length,
    judged_count: next.judged.length,
  };
}

/**
 * Should we buy the paid view for this ticker today? (step 3)
 *   - a new condition was added for it, or
 *   - it, or another name in the same population, got a verdict, or
 *   - the last purchase is 7+ days old (or there was none).
 */
export function shouldBuyOsd(ticker, { diff, kindsOfTicker, lastBoughtOn, today }) {
  const days = LIMITS.osd.repurchase_after_days;
  const reasons = [];
  if (diff.new_pending.some((id) => id.endsWith(`:${ticker}`))) reasons.push("new condition");
  if (diff.newly_judged.some((j) => j.ticker === ticker || kindsOfTicker.has(j.kind))) {
    reasons.push("verdict in ticker or population");
  }
  if (!lastBoughtOn || (Date.parse(today) - Date.parse(lastBoughtOn)) / 864e5 >= days) {
    reasons.push(lastBoughtOn ? `${days}+ days since last purchase` : "never bought");
  }
  return reasons;
}

export { judgeableFrom, GRACE_DAYS };
