/**
 * The three predictors.
 *
 *   base-rate-v1          System A. OSD's own record only; no model, no flows.
 *   base-rate+nansen-v1   System N. System A shifted by the smart-money flow
 *                         state before the deadline.
 *   claude-fable-5-1 (chat)  System B. Imported from chat once a week
 *                         (scripts/import-chat-predictions.mjs), not computed here.
 *
 * Outcomes score hit = 1, partial = 0.5, miss = 0; na and excluded never count.
 */
import { outcomeOf } from "./osd.mjs";

export const PREDICTOR_A = "base-rate-v1";
export const PREDICTOR_N = "base-rate+nansen-v1";
export const PREDICTOR_B = "claude-fable-5-1 (chat)";

/** Prior strength for shrinking a small group toward its parent. */
export const SHRINK_K = 10;
/** How far an unchecked deadline pulls p toward 0.5 (1 = not at all). */
export const UNVERIFIED_DATE_FACTOR = 0.8;

const TYPE_RULES = [
  ["guidance", /ガイダンス|見通し|通期予想|上方修正|下方修正|guidance|outlook/i],
  ["orders", /受注|受注残|backlog|bookings|orders/i],
  ["margin", /利益率|マージン|損失率|MLR|margin/i],
  ["revenue", /売上|出荷|revenue|sales|shipments/i],
];

/** Condition type, from its wording; date-anchored events are their own type. */
export function conditionType(row) {
  if (row.catalyst_type === "event" || row.catalyst_type === "fixed_date") return "event";
  const text = String(row.success_condition ?? "");
  for (const [type, re] of TYPE_RULES) if (re.test(text)) return type;
  return "other";
}

function stats(rows) {
  let n = 0;
  let sum = 0;
  for (const r of rows) {
    const y = outcomeOf(r.status);
    if (y === null) continue;
    n += 1;
    sum += y;
  }
  return { n, sum };
}

const shrink = ({ n, sum }, parent, k = SHRINK_K) => (sum + k * parent) / (n + k);
const clip = (p) => Math.min(0.98, Math.max(0.02, p));
const round3 = (p) => Math.round(p * 1000) / 1000;

/**
 * System A for one pending condition. Pure.
 *
 * Levels, each shrunk toward the one above it:
 *   all judged conditions → same population → same population and type → same ticker
 * An unchecked deadline then pulls the result toward 0.5, because a condition
 * judged against the wrong date is closer to a coin flip.
 */
export function baseRate(row, judgedRows) {
  const type = conditionType(row);
  const all = stats(judgedRows);
  const pop = stats(judgedRows.filter((r) => r.kind === row.kind));
  const popType = stats(judgedRows.filter((r) => r.kind === row.kind && conditionType(r) === type));
  const tick = stats(judgedRows.filter((r) => r.kind === row.kind && r.ticker === row.ticker));

  const pAll = all.n > 0 ? all.sum / all.n : 0.5;
  const pPop = shrink(pop, pAll);
  const pType = shrink(popType, pPop);
  const pTick = shrink(tick, pType);
  const p = row.date_verified ? pTick : 0.5 + (pTick - 0.5) * UNVERIFIED_DATE_FACTOR;

  return {
    p_hit: round3(clip(p)),
    basis: {
      levels: [
        { level: "all", n: all.n, rate: round3(pAll) },
        { level: `population:${row.kind}`, n: pop.n, rate: round3(pPop) },
        { level: `type:${type}`, n: popType.n, rate: round3(pType) },
        { level: `ticker:${row.ticker}`, n: tick.n, rate: round3(pTick) },
      ],
      shrink_k: SHRINK_K,
      date_verified: row.date_verified,
      ...(row.date_verified ? {} : { unverified_date_factor: UNVERIFIED_DATE_FACTOR }),
      population_n: pop.n,
    },
  };
}

// ── System N ──────────────────────────────────────────────────────────────

export const DEFAULT_ADJUST = { inflow: 0.05, outflow: -0.05, none: 0 };
export const REESTIMATE_MIN_JUDGED = 20;
export const STATE_MIN_N = 5;

/**
 * Flow state of an underlying from its Smart Money Netflows rows (one per
 * mint). Rows are summed across xStocks and Ondo; trader_count is summed too,
 * so a wallet active in both tokens counts twice — an upper bound.
 */
export function flowState(rows) {
  const present = (rows ?? []).filter((r) => r && r.has_flow);
  if (present.length === 0) return { state: "none", net_flow_7d_usd: 0, trader_count: 0 };
  const sum = (k) => present.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const net7 = sum("net_flow_7d_usd");
  const traders = sum("trader_count");
  const state = traders >= 2 && net7 > 0 ? "inflow" : traders >= 2 && net7 < 0 ? "outflow" : "none";
  return {
    state,
    net_flow_1h_usd: sum("net_flow_1h_usd"),
    net_flow_24h_usd: sum("net_flow_24h_usd"),
    net_flow_7d_usd: net7,
    net_flow_30d_usd: sum("net_flow_30d_usd"),
    trader_count: traders,
    flow_fetched_at: present.map((r) => r.fetched_at).sort().at(-1),
  };
}

export function systemN(a, flow, adjust) {
  const shift = adjust[flow.state] ?? 0;
  return {
    p_hit: round3(clip(a.p_hit + shift)),
    basis: { base_rate: a.p_hit, flow_state: flow.state, adjustment: shift, ...flow, population_n: a.basis.population_n },
  };
}

/**
 * Re-estimate the shift per state from scored System N predictions, once there
 * are enough. `scored` rows: { state, p_a, y }. A state with too few rows keeps
 * its current value. Returns null when nothing should change.
 */
export function reestimate(scored, current) {
  if (scored.length < REESTIMATE_MIN_JUDGED) return null;
  const next = { ...current };
  const n = {};
  for (const state of Object.keys(DEFAULT_ADJUST)) {
    const rows = scored.filter((r) => r.state === state);
    n[state] = rows.length;
    if (rows.length >= STATE_MIN_N) {
      next[state] = round3(rows.reduce((s, r) => s + (r.y - r.p_a), 0) / rows.length);
    }
  }
  return { adjust: next, n };
}
