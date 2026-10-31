/**
 * Scoring (step 7). Pure.
 *
 * For each condition OSD has judged, take each predictor's LAST prediction made
 * on or before the deadline (earlier ones stay on record but do not score).
 * hit = 1, partial = 0.5, miss = 0; na / excluded are not scored.
 *
 *   Brier        mean (p - y)^2, lower is better; 0.25 is "always 0.5"
 *   calibration  per 0.1 band of p: count, mean p, mean outcome
 *   by state     System N only: outcome rate per flow state — the question
 *                "did smart money buying before earnings line up with hits?"
 */
import { outcomeOf } from "./osd.mjs";

export function lastBeforeDeadline(preds, deadline) {
  const ok = preds
    .filter((p) => String(p.predicted_at).slice(0, 10) <= deadline)
    .sort((a, b) => (a.predicted_at < b.predicted_at ? -1 : 1));
  return ok.at(-1) ?? null;
}

const r4 = (x) => Math.round(x * 10000) / 10000;

function brier(pairs) {
  if (pairs.length === 0) return null;
  return r4(pairs.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / pairs.length);
}

function calibration(pairs) {
  const bins = [];
  for (let i = 0; i < 10; i += 1) {
    const inBin = pairs.filter(({ p }) => (i === 9 ? p >= 0.9 : p >= i / 10 && p < (i + 1) / 10));
    if (inBin.length === 0) continue;
    bins.push({
      band: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
      n: inBin.length,
      mean_p: r4(inBin.reduce((s, x) => s + x.p, 0) / inBin.length),
      hit_rate: r4(inBin.reduce((s, x) => s + x.y, 0) / inBin.length),
    });
  }
  return bins;
}

/**
 * `judgedRows`: OSD conditions with status hit/partial/miss (+ deadline, kind).
 * `predsByPredictor`: { [predictor]: prediction[] }.
 * Returns the public scorecard plus `pairs` (kept private by the caller for N).
 */
export function scorecard(judgedRows, predsByPredictor) {
  const out = { predictors: {}, constant_half: null };
  const allPairsForHalf = [];
  for (const [predictor, preds] of Object.entries(predsByPredictor)) {
    const byId = new Map();
    for (const p of preds) {
      const list = byId.get(p.id) ?? [];
      list.push(p);
      byId.set(p.id, list);
    }
    const pairs = [];
    for (const row of judgedRows) {
      const y = outcomeOf(row.status);
      if (y === null || !byId.has(row.id)) continue;
      const last = lastBeforeDeadline(byId.get(row.id), row.deadline);
      if (!last) continue;
      pairs.push({ id: row.id, kind: row.kind, p: last.p_hit, y, state: last.basis?.flow_state ?? null, p_a: last.basis?.base_rate ?? null });
      allPairsForHalf.push(row.id);
    }
    const byPop = {};
    for (const kind of [...new Set(pairs.map((x) => x.kind))]) {
      const sub = pairs.filter((x) => x.kind === kind);
      byPop[kind] = { n: sub.length, brier: brier(sub) };
    }
    const byState = {};
    for (const state of ["inflow", "outflow", "none"]) {
      const sub = pairs.filter((x) => x.state === state);
      if (sub.length) byState[state] = { n: sub.length, hit_rate: r4(sub.reduce((s, x) => s + x.y, 0) / sub.length) };
    }
    out.predictors[predictor] = {
      n: pairs.length,
      brier: brier(pairs),
      by_population: byPop,
      calibration: calibration(pairs),
      ...(Object.keys(byState).length ? { by_flow_state: byState } : {}),
      pairs,
    };
  }
  // The "always 0.5" baseline, over every condition any predictor was scored on.
  const ids = new Set(allPairsForHalf);
  const halfPairs = judgedRows
    .filter((r) => ids.has(r.id))
    .map((r) => ({ p: 0.5, y: outcomeOf(r.status) }));
  out.constant_half = { n: halfPairs.length, brier: brier(halfPairs) };
  return out;
}

/** Strip per-condition pairs — what may be published. */
export function publicScorecard(card) {
  const predictors = {};
  for (const [k, v] of Object.entries(card.predictors)) {
    const { pairs, ...rest } = v;
    predictors[k] = rest;
  }
  return { ...card, predictors };
}
