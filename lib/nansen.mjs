/**
 * Nansen, bought per call with x402 (USDC on Solana).
 *
 *   smart-money/netflow     0.05 USDC   INTERNAL ONLY until Nansen approves
 *                                       redistribution (Restricted in its Data
 *                                       Redistribution Guidelines). Stored
 *                                       encrypted under private/.
 *   tgm/flow-intelligence   0.01 USDC   Redistributable with attribution
 *                                       ("Powered by Nansen API", link to
 *                                       nansen.ai). Stored in the clear.
 */
import { LIMITS, buy } from "./money.mjs";

export const ATTRIBUTION = { text: "Powered by Nansen API", url: "https://nansen.ai" };

const N = LIMITS.nansen;

/**
 * One call for every mint. Mints Nansen returns no row for are recorded as
 * "no flow" (has_flow: false), because "no smart money touched it" is itself
 * the observation.
 */
export async function buyNetflows(mintList, { ledger, http, dryRun, fetchImpl, now }) {
  const body = {
    chains: ["solana"],
    filters: { token_address: mintList.map((m) => m.mint) },
    pagination: { page: 1, per_page: 1000 },
  };
  const res = await buy({
    seller: "nansen",
    key: "smart-money/netflow",
    url: `${N.base_url}/smart-money/netflow`,
    method: "POST",
    body,
    payTo: N.payTo,
    maxUnits: N.max_units["smart-money/netflow"],
    ledger,
    oncePerDay: true,
    http,
    dryRun,
    fetchImpl,
    now,
  });
  if (!res.paid) return { res, rows: [] };
  return { res, rows: netflowRows(mintList, res.json, res.tx, (now ?? (() => new Date().toISOString()))()) };
}

/** Pure: shape the netflow response into one record per requested mint. */
export function netflowRows(mintList, json, tx, fetchedAt) {
  const byMint = new Map();
  for (const d of json?.data ?? []) byMint.set(d.token_address, d);
  return mintList.map(({ mint, ticker, symbol }) => {
    const d = byMint.get(mint);
    return {
      mint,
      ticker,
      symbol,
      fetched_at: fetchedAt,
      has_flow: Boolean(d),
      net_flow_1h_usd: d ? Number(d.net_flow_1h_usd) || 0 : 0,
      net_flow_24h_usd: d ? Number(d.net_flow_24h_usd) || 0 : 0,
      net_flow_7d_usd: d ? Number(d.net_flow_7d_usd) || 0 : 0,
      net_flow_30d_usd: d ? Number(d.net_flow_30d_usd) || 0 : 0,
      trader_count: d ? Number(d.trader_count) || 0 : 0,
      source: "nansen smart-money/netflow",
      payment: "x402",
      purchase_tx: tx,
    };
  });
}

/** One call per mint. Public record, attributed. */
export async function buyFlowIntelligence(m, { ledger, http, dryRun, fetchImpl, now, timeframe = "1d" }) {
  const res = await buy({
    seller: "nansen",
    key: `tgm/flow-intelligence:${m.mint}`,
    url: `${N.base_url}/tgm/flow-intelligence`,
    method: "POST",
    body: { chain: "solana", token_address: m.mint, timeframe },
    payTo: N.payTo,
    maxUnits: N.max_units["tgm/flow-intelligence"],
    ledger,
    oncePerDay: true,
    http,
    dryRun,
    fetchImpl,
    now,
  });
  if (!res.paid) return { res, row: null };
  return {
    res,
    row: {
      mint: m.mint,
      ticker: m.ticker,
      symbol: m.symbol,
      fetched_at: (now ?? (() => new Date().toISOString()))(),
      timeframe,
      // Kept as Nansen returned it; the response shape is not pinned by us.
      data: json(res.json),
      source: "nansen tgm/flow-intelligence",
      attribution: ATTRIBUTION,
      payment: "x402",
      purchase_tx: res.tx,
    },
  };
}

function json(j) {
  if (Array.isArray(j?.data)) return j.data;
  return j ?? null;
}
