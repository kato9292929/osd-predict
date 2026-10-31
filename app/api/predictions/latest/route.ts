import { NextResponse } from "next/server";
import { cors, preflight } from "@/lib/x402-server";
import { ATTRIBUTION, json, predictions } from "@/lib/public-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FREE. The latest prediction per condition and predictor (System A and B),
 * and the scorecard. System N's individual predictions are not published until
 * Nansen approves redistribution of its smart-money data; only its aggregate
 * score and its outcome rate per flow state are.
 */
export async function GET() {
  const latest = new Map<string, ReturnType<typeof predictions>[number]>();
  for (const p of predictions()) {
    const k = `${p.id}|${p.predictor}`;
    const cur = latest.get(k);
    if (!cur || cur.predicted_at <= p.predicted_at) latest.set(k, p);
  }
  const rows = [...latest.values()]
    .map(({ day, basis, ...p }) => ({ ...p, population_n: (basis as { population_n?: number } | undefined)?.population_n ?? null }))
    .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.id < b.id ? -1 : 1));
  return cors(
    NextResponse.json({
      predictions: rows,
      scores: json("scores/latest.json", null),
      attribution: ATTRIBUTION,
      note: "p_hit is the probability that the OSD condition is met (hit = 1, partial = 0.5, miss = 0). Informational only — not investment advice.",
    }),
  );
}

export const OPTIONS = preflight;
