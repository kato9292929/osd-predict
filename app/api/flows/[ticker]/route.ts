import { NextRequest, NextResponse } from "next/server";
import { FLOWS_PRICE_UNITS, cors, paywall, preflight, routeConfig } from "@/lib/x402-server";
import { ATTRIBUTION, flowIntel, openConditions } from "@/lib/public-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PAID, 0.01 USDC (x402 exact, USDC on Solana).
 *
 * Nansen Flow Intelligence for the underlying's Solana tokens (xStocks, Ondo),
 * next to OSD's next dated earnings condition and its deadline. Flow
 * Intelligence is redistributable with attribution; Smart Money Netflows is not
 * served here (internal-only until Nansen approves).
 *
 * A ticker with conditions but no flow data yet is answered free; an unknown
 * ticker is 404 before any challenge is issued.
 */
const DESCRIPTION =
  "Nansen smart money flows × OSD earnings conditions — Nansen Flow Intelligence (smart trader, whale, exchange and fresh-wallet flows) for the stock's Solana tokens (xStocks / Ondo), with OSD's next dated earnings condition and deadline. Powered by Nansen API (https://nansen.ai). Informational only.";

function tickerOf(req: NextRequest): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(seg.at(-1) ?? "").toUpperCase();
}

function view(ticker: string) {
  const conds = openConditions().conditions.filter((c) => c.ticker === ticker && c.mints.length > 0);
  const mints = new Set(conds.flatMap((c) => c.mints.map((m) => m.mint)));
  const flows = flowIntel().filter((f) => mints.has(f.mint));
  const latestByMint = new Map<string, (typeof flows)[number]>();
  for (const f of flows) {
    const cur = latestByMint.get(f.mint);
    if (!cur || cur.fetched_at <= f.fetched_at) latestByMint.set(f.mint, f);
  }
  const next = conds.sort((a, b) => (a.deadline < b.deadline ? -1 : 1))[0] ?? null;
  return { conds, latest: [...latestByMint.values()], next };
}

const paid = paywall(async (req) => {
  const t = tickerOf(req);
  const { latest, next } = view(t);
  return NextResponse.json({
    ticker: t,
    flows: latest.map((f) => ({ mint: f.mint, symbol: f.symbol, fetched_at: f.fetched_at, timeframe: f.timeframe, data: f.data })),
    next_condition: next && {
      id: next.id,
      success_condition: next.success_condition,
      target_date: next.target_date,
      deadline: next.deadline,
      date_verified: next.date_verified,
    },
    attribution: ATTRIBUTION,
    note: "Informational only — not investment advice.",
  });
}, routeConfig(FLOWS_PRICE_UNITS, DESCRIPTION, "/api/flows/:ticker"));

export async function GET(req: NextRequest) {
  const t = tickerOf(req);
  const { conds, latest } = view(t);
  if (conds.length === 0) {
    return cors(NextResponse.json({ error: "ticker not covered", ticker: t }, { status: 404 }));
  }
  if (latest.length === 0) {
    return cors(
      NextResponse.json({
        ticker: t,
        flows: [],
        note: "No flow data has been collected for this ticker yet, so nothing is charged.",
        attribution: ATTRIBUTION,
      }),
    );
  }
  return paid(req);
}

export const OPTIONS = preflight;
