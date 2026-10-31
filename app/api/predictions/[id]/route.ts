import { NextRequest, NextResponse } from "next/server";
import { cors, preflight } from "@/lib/x402-server";
import { openConditions, predictions, seals } from "@/lib/public-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FREE. Every published prediction for one condition, oldest first, with its
 * basis and the memo transaction that sealed the day it was written in.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = decodeURIComponent(raw);
  const rows = predictions().filter((p) => p.id === id);
  const condition = openConditions().conditions.find((c) => c.id === id) ?? null;
  if (rows.length === 0 && !condition) {
    return cors(NextResponse.json({ error: "unknown id", id }, { status: 404 }));
  }
  const history = rows
    .sort((a, b) => (a.predicted_at < b.predicted_at ? -1 : 1))
    .map((p) => ({ ...p, seals: seals(p.day).map((s) => ({ sealed_at: s.sealed_at, memo_tx: s.memo_tx })) }));
  return cors(NextResponse.json({ id, condition, history }));
}

export const OPTIONS = preflight;
