#!/usr/bin/env node
/**
 * The daily run (GitHub Actions, 22:00 UTC = 07:00 JST).
 *
 *   1 diff      OSD conditions vs yesterday (free: OSD's public repository)
 *   2 Nansen    Smart Money Netflows, one call for every mint (private, encrypted)
 *               Flow Intelligence, one call per mint (public, attributed)
 *   3 OSD       /api/solana-stocks/{ticker}?view=full, only on the rules in shouldBuyOsd
 *   4 predict   System A for every predictable condition; System N where the
 *               underlying has a Solana token and flows were bought
 *   5 record    append-only jsonl (public data/, encrypted private/)
 *   6 seal      SHA-256 of each unsealed day's files into a Solana memo
 *   7 score     judged conditions against the last prediction before the deadline
 *
 * Env:
 *   SOLANA_SECRET_KEY   buyer + memo wallet. Unset → nothing is bought or sealed,
 *                       System A still runs.
 *   PRIVATE_DATA_KEY    32-byte base64 key for private/. Unset → no Nansen
 *                       netflow purchase and no System N (nowhere to keep it).
 *   SOLANA_RPC_URL      for memo transactions (default: public mainnet RPC)
 *   DRY_RUN=1           read every 402 and check it against the limits, pay nothing
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, Ledger, buy, makeHttpClient } from "../lib/money.mjs";
import {
  conditions,
  diffSnapshots,
  judged,
  loadOsdFiles,
  predictable,
  shouldBuyOsd,
  snapshot,
} from "../lib/osd.mjs";
import { buyFlowIntelligence, buyNetflows } from "../lib/nansen.mjs";
import {
  DEFAULT_ADJUST,
  PREDICTOR_A,
  PREDICTOR_B,
  PREDICTOR_N,
  baseRate,
  flowState,
  reestimate,
  systemN,
} from "../lib/predict.mjs";
import { publicScorecard, scorecard } from "../lib/score.mjs";
import { dayManifest, memoText, needsSeal, recordSeal, sendMemo } from "../lib/seal.mjs";
import {
  DATA,
  appendJsonl,
  appendPrivate,
  privateDays,
  publicDays,
  readJson,
  readJsonl,
  readPrivate,
  writeJson,
} from "../lib/store.mjs";

const changed = (prev, p, stateKey) =>
  !prev || Math.abs(prev.p_hit - p.p_hit) >= 0.005 || (stateKey && prev.basis?.flow_state !== p.basis?.flow_state);

function lastById(rows) {
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r.id);
    if (!cur || cur.predicted_at <= r.predicted_at) m.set(r.id, r);
  }
  return m;
}

function allPublicPredictions() {
  return publicDays("predictions").flatMap((d) => readJsonl(path.join(DATA, "predictions", `${d}.jsonl`)));
}

function allPrivate(kind, key) {
  if (!key) return [];
  return privateDays(kind).flatMap((d) => readPrivate(kind, d, key));
}

function lastOsdPurchase(ticker) {
  let last = null;
  for (const d of publicDays("purchases")) {
    for (const r of readJsonl(path.join(DATA, "purchases", `${d}.jsonl`))) {
      if (r.paid && r.seller === "osd" && r.key === ticker) last = d;
    }
  }
  return last;
}

export async function runDaily({
  now = () => new Date().toISOString(),
  osdFiles,
  http,
  fetchImpl = fetch,
  key = process.env.PRIVATE_DATA_KEY,
  canSeal = Boolean(process.env.SOLANA_SECRET_KEY),
  sealer = sendMemo,
  dryRun = /^(1|true)$/i.test(process.env.DRY_RUN ?? ""),
} = {}) {
  const today = now().slice(0, 10);
  const report = { day: today, dry_run: dryRun, wallet: http ? http.address ?? "set" : null };
  const ledger = new Ledger(path.join(DATA, "purchases"), today);
  // What earlier runs on the same UTC day already paid. The report shows this
  // run's spend separately: on 2026-11-04 a second run paid nothing (every
  // purchase refused as "already bought today") yet reported the day's 0.15
  // as its own, which read as a double purchase.
  const spentBefore = ledger.spentUnits();
  const H = http?.http ?? http ?? null;
  // No wallet and not a dry run: there is nothing to probe or pay with, so the
  // purchase steps are skipped outright rather than logged as refusals.
  const canBuy = Boolean(H) || dryRun;

  // ── 1 diff ──
  const files = osdFiles ?? (await loadOsdFiles({ fetchImpl }));
  const all = conditions(files);
  const snap = snapshot(all, today);
  const prevSnap = readJson(path.join(DATA, "state", "osd-snapshot.json"), null);
  const diff = diffSnapshots(prevSnap, snap);
  writeJson(path.join(DATA, "state", "osd-snapshot.json"), snap);
  const open = predictable(all, today);
  // Public cache of the predictable conditions, for the API and the chat import.
  writeJson(path.join(DATA, "state", "conditions.json"), {
    as_of: today,
    source: "OSD public repository (kato9292929/onchain-stock-data)",
    conditions: open.map(({ judged_at, status, ...c }) => c),
  });
  report.diff = { new_pending: diff.new_pending.length, newly_judged: diff.newly_judged.length, pending: diff.pending_count, judged: diff.judged_count };

  // ── 2 Nansen ──
  const mintList = [];
  const seenMint = new Set();
  for (const r of [...open].sort((a, b) => (a.deadline < b.deadline ? -1 : 1))) {
    for (const m of r.mints) {
      if (seenMint.has(m.mint)) continue;
      seenMint.add(m.mint);
      mintList.push({ ...m, ticker: r.ticker, deadline: r.deadline });
    }
  }
  report.mints = mintList.length;
  let netflowRows = [];
  if (mintList.length && key && canBuy) {
    const { res, rows } = await buyNetflows(mintList, { ledger, http: H, dryRun, fetchImpl, now });
    netflowRows = rows;
    appendPrivate("flows", today, rows, key);
    report.netflow = { paid: res.paid, reason: res.reason ?? null, rows: rows.length, with_flow: rows.filter((r) => r.has_flow).length };
  } else {
    report.netflow = { paid: false, reason: !key ? "PRIVATE_DATA_KEY not set" : !canBuy ? "no wallet" : "no mints" };
  }

  const fiRows = [];
  for (const m of canBuy ? mintList.slice(0, LIMITS.nansen.flow_intelligence_max_calls_per_day) : []) {
    const { res, row } = await buyFlowIntelligence(m, { ledger, http: H, dryRun, fetchImpl, now });
    if (row) fiRows.push(row);
    if (res.capped) break;
  }
  appendJsonl(path.join(DATA, "flows-public", `${today}.jsonl`), fiRows);
  report.flow_intelligence = { bought: fiRows.length, of: Math.min(mintList.length, LIMITS.nansen.flow_intelligence_max_calls_per_day) };

  // ── 3 OSD ──
  const osdBought = [];
  const tickers = [...new Set(open.filter((r) => r.mints.length).map((r) => r.ticker))];
  for (const t of canBuy ? tickers : []) {
    const kinds = new Set(open.filter((r) => r.ticker === t).map((r) => r.kind));
    const reasons = shouldBuyOsd(t, { diff, kindsOfTicker: kinds, lastBoughtOn: lastOsdPurchase(t), today });
    if (reasons.length === 0) continue;
    const res = await buy({
      seller: "osd",
      key: t,
      url: `${LIMITS.osd.base_url}/api/solana-stocks/${encodeURIComponent(t)}?view=full`,
      payTo: LIMITS.osd.payTo,
      maxUnits: Math.min(LIMITS.osd.max_units, 50000),
      ledger,
      oncePerDay: true,
      http: H,
      dryRun,
      fetchImpl,
      now,
    });
    osdBought.push({ ticker: t, paid: res.paid, reasons, why_not: res.reason ?? null });
  }
  report.osd = { considered: tickers.length, bought: osdBought.filter((b) => b.paid).length, attempts: osdBought };

  // ── 4/5 predict + record ──
  const judgedRows = judged(all);
  const adjustFile = readJson(path.join(DATA, "adjustments.json"), { current: DEFAULT_ADJUST, history: [] });
  const pubPreds = allPublicPredictions();
  const lastA = lastById(pubPreds.filter((p) => p.predictor === PREDICTOR_A));
  const privN = allPrivate("predictions-n", key);
  const lastN = lastById(privN);
  const at = now();
  const newA = [];
  const newN = [];
  for (const r of open) {
    const a = baseRate(r, judgedRows);
    const recA = { id: r.id, predictor: PREDICTOR_A, p_hit: a.p_hit, basis: a.basis, predicted_at: at, target_date: r.target_date, deadline: r.deadline };
    if (changed(lastA.get(r.id), recA)) newA.push(recA);

    if (!r.mints.length || !netflowRows.length || !key) continue;
    const rows = netflowRows.filter((f) => r.mints.some((m) => m.mint === f.mint));
    const n = systemN(a, flowState(rows), adjustFile.current);
    const recN = { id: r.id, predictor: PREDICTOR_N, p_hit: n.p_hit, basis: n.basis, predicted_at: at, target_date: r.target_date, deadline: r.deadline };
    if (changed(lastN.get(r.id), recN, true)) newN.push(recN);
  }
  appendJsonl(path.join(DATA, "predictions", `${today}.jsonl`), newA);
  if (key) appendPrivate("predictions-n", today, newN, key);
  report.predictions = {
    predictable: open.length,
    written_a: newA.length,
    written_n: newN.length,
    n_states: newN.reduce((m, p) => ((m[p.basis.flow_state] = (m[p.basis.flow_state] ?? 0) + 1), m), {}),
  };

  // ── 6 seal ──
  const days = [...new Set([...publicDays("predictions"), ...publicDays("flows-public"), ...privateDays("flows"), ...privateDays("predictions-n")])]
    .filter((d) => d <= today)
    .slice(-7);
  report.seals = [];
  for (const d of days) {
    const manifest = dayManifest(d, key);
    if (!needsSeal(d, manifest)) continue;
    const memo = memoText(d, manifest);
    if (!canSeal || dryRun) {
      report.seals.push({ day: d, sealed: false, reason: dryRun ? "dry run" : "no wallet" });
      continue;
    }
    try {
      const tx = await sealer(memo);
      recordSeal(d, manifest, memo, tx);
      report.seals.push({ day: d, sealed: true, memo_tx: tx });
    } catch (e) {
      report.seals.push({ day: d, sealed: false, reason: e.message });
    }
  }

  // ── 7 score ──
  const preds = {
    [PREDICTOR_A]: pubPreds.filter((p) => p.predictor === PREDICTOR_A).concat(newA),
    [PREDICTOR_B]: pubPreds.filter((p) => p.predictor === PREDICTOR_B),
    ...(key ? { [PREDICTOR_N]: privN.concat(newN) } : {}),
  };
  const card = scorecard(judgedRows, preds);
  writeJson(path.join(DATA, "scores", "latest.json"), {
    as_of: today,
    note: "Brier: lower is better; constant_half is the score of always answering 0.5. by_flow_state is aggregated over System N's scored conditions (no flow values). Smart-money states: Powered by Nansen API (https://nansen.ai).",
    ...publicScorecard(card),
  });
  const nPairs = card.predictors[PREDICTOR_N]?.pairs ?? [];
  const re = reestimate(nPairs.map((x) => ({ state: x.state, p_a: x.p_a, y: x.y })), adjustFile.current);
  if (re && JSON.stringify(re.adjust) !== JSON.stringify(adjustFile.current)) {
    adjustFile.history.push({ on: today, from: adjustFile.current, to: re.adjust, n: re.n });
    adjustFile.current = re.adjust;
  }
  writeJson(path.join(DATA, "adjustments.json"), adjustFile);

  const spentToday = ledger.spentUnits();
  const spentRun = spentToday - spentBefore;
  report.spent = {
    this_run_units: spentRun,
    this_run_usdc: spentRun / 1e6,
    today_units: spentToday,
    today_usdc: spentToday / 1e6,
    cap_usdc: LIMITS.daily_cap_units / 1e6,
  };
  report.scored = Object.fromEntries(Object.entries(card.predictors).map(([k, v]) => [k, { n: v.n, brier: v.brier }]));
  // One line per run, appended: a second run on the same day must not erase
  // the first run's report (2026-11-04's manual run overwrote the scheduled one).
  appendJsonl(path.join(DATA, "runs", `${today}.jsonl`), [{ ...report, finished_at: now() }]);
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const client = await makeHttpClient().catch((e) => {
    console.error(`[daily] wallet unusable: ${e.message}`);
    return null;
  });
  runDaily({ http: client })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(`[daily] failed: ${e.stack ?? e}`);
      process.exit(1);
    });
}
