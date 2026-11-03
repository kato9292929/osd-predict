/**
 * Selling side: one Solana-only, USDC, exact paywall, settled by the PayAI
 * facilitator. A trimmed port of OSD's lib/x402.ts + lib/x402-route.ts — same
 * package versions, same facilitator, no EVM leg.
 */
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@payai/facilitator";

export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network;
export const ASSET_SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Receiving address. Defaults to OSD's, which belongs to the same owner. */
export const PAY_TO_SOLANA =
  process.env.SOLANA_RECEIVE_ADDRESS || "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf";
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://osd-predict.vercel.app").replace(/\/$/, "");

/** 0.01 USDC in base units (6 decimals). */
export const FLOWS_PRICE_UNITS = "10000";

if (!process.env.PAYAI_API_KEY_ID || !process.env.PAYAI_API_KEY_SECRET) {
  console.warn(
    "[x402] PAYAI_API_KEY_ID / PAYAI_API_KEY_SECRET are not set — settlement runs on PayAI's shared free tier.",
  );
}

const server = new x402ResourceServer([
  new HTTPFacilitatorClient(
    createFacilitatorConfig(process.env.PAYAI_API_KEY_ID, process.env.PAYAI_API_KEY_SECRET),
  ),
]);
registerExactSvmScheme(server);

export function routeConfig(units: string, description: string, resourcePath: string): RouteConfig {
  const resource = `${PUBLIC_BASE_URL}${resourcePath}`;
  const rc: RouteConfig = {
    accepts: [
      {
        scheme: "exact",
        network: SOLANA_NETWORK,
        payTo: PAY_TO_SOLANA,
        price: { amount: units, asset: ASSET_SOLANA_USDC },
        extra: { resource },
      },
    ],
    description,
    resource,
  };
  // Fail closed if the network, asset or amount ever drift.
  const a = (rc.accepts as Array<{ network: string; price: { amount: string; asset: string } }>)[0];
  if (a.network !== SOLANA_NETWORK || a.price.amount !== units || a.price.asset !== ASSET_SOLANA_USDC) {
    throw new Error("[x402 safety] route config drifted");
  }
  return rc;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

export function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

export const preflight = () => cors(new NextResponse(null, { status: 204 }));

type Handler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Paid handler. A settlement failure that @x402/next reports as a bare 402
 * (no PAYMENT-REQUIRED header) becomes 503 + Retry-After, as on OSD: the buyer
 * can retry instead of reading an empty challenge.
 */
export function paywall(handler: Handler, rc: RouteConfig): Handler {
  const wrapped = withX402(
    async (req: NextRequest) => {
      const res = await handler(req);
      // Paid bodies are never cached by a CDN.
      res.headers.set("Cache-Control", "no-store, private");
      return res;
    },
    rc,
    server,
    undefined,
    undefined,
    true,
  );
  return async (req) => {
    try {
      const res = await wrapped(req);
      if (res.status === 402 && !res.headers.get("PAYMENT-REQUIRED")) {
        return cors(
          NextResponse.json(
            { error: "payment_unavailable", message: "Settlement failed; retry shortly." },
            { status: 503, headers: { "Retry-After": "60" } },
          ),
        );
      }
      return cors(res);
    } catch {
      return cors(
        NextResponse.json(
          { error: "payment_unavailable", message: "No payment facilitator is reachable; retry shortly." },
          { status: 503, headers: { "Retry-After": "60" } },
        ),
      );
    }
  };
}
