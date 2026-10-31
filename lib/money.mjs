/**
 * Paying for data with x402, under hard limits.
 *
 * Every purchase goes through `buy()`. Before anything is signed it checks:
 *   1. the 402 offers a Solana leg on the pinned network and asset,
 *   2. that leg's payTo is the address pinned for this seller,
 *   3. its amount is at or below the per-call ceiling,
 *   4. today's purchases plus this one stay under the daily cap,
 *   5. the same (seller, key) was not already bought today, where asked.
 * A failed check is recorded as an unpaid purchase and nothing is signed.
 *
 * Every attempt — paid, refused or failed — is appended to
 * data/purchases/YYYY-MM-DD.jsonl. That file holds no purchased data, only
 * what was asked, what it cost and the settlement tx, so it is public.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const LIMITS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config", "limits.json"), "utf8"),
);

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Pick the one accept leg we are willing to pay. Pure.
 * Returns { ok: true, accept } or { ok: false, reason }.
 */
export function pickAccept(paymentRequired, { network, asset, payTo, maxUnits }) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const sol = accepts.filter((a) => a?.network === network && a?.asset === asset);
  if (sol.length === 0) {
    return { ok: false, reason: `no ${network} leg in ${asset}` };
  }
  const mine = sol.filter((a) => a.payTo === payTo);
  if (mine.length === 0) {
    return {
      ok: false,
      reason: `payTo mismatch: offered ${sol.map((a) => a.payTo).join(",")}, pinned ${payTo}`,
    };
  }
  const a = mine[0];
  const units = Number(a.amount ?? a.maxAmountRequired);
  if (!Number.isFinite(units) || units <= 0) return { ok: false, reason: `bad amount ${a.amount}` };
  if (units > maxUnits) {
    return { ok: false, reason: `amount ${units} exceeds ceiling ${maxUnits}` };
  }
  return { ok: true, accept: a, units };
}

/** Append-only purchase ledger, one file per UTC day. */
export class Ledger {
  constructor(dir = path.join(ROOT, "data", "purchases"), day = todayUtc()) {
    this.dir = dir;
    this.day = day;
    this.file = path.join(dir, `${day}.jsonl`);
  }

  rows() {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  spentUnits() {
    return this.rows()
      .filter((r) => r.paid)
      .reduce((n, r) => n + (r.units ?? 0), 0);
  }

  boughtToday(seller, key) {
    return this.rows().some((r) => r.paid && r.seller === seller && r.key === key);
  }

  append(row) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }
}

/**
 * Buy one call. `http` is an x402HTTPClient (or a test double with the same
 * four methods); `fetchImpl` defaults to global fetch.
 *
 * Returns { paid, status, json, tx, units, reason }.
 */
export async function buy({
  seller,
  key,
  url,
  method = "GET",
  body,
  payTo,
  maxUnits,
  ledger,
  dailyCapUnits = LIMITS.daily_cap_units,
  oncePerDay = false,
  http,
  fetchImpl = fetch,
  dryRun = false,
  now = () => new Date().toISOString(),
}) {
  const base = { at: now(), seller, key, url, method };
  const init = {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  if (oncePerDay && ledger.boughtToday(seller, key)) {
    const row = { ...base, paid: false, units: 0, reason: "already bought today" };
    ledger.append(row);
    return { paid: false, reason: row.reason };
  }

  const r1 = await fetchImpl(url, init);
  if (r1.status !== 402) {
    // Not for sale (free view, 404, outage) — nothing was paid.
    let json = null;
    try {
      json = await r1.json();
    } catch {
      /* not JSON */
    }
    const row = { ...base, paid: false, units: 0, status: r1.status, reason: `no 402 (status ${r1.status})` };
    ledger.append(row);
    return { paid: false, status: r1.status, json, reason: row.reason };
  }

  let pr;
  try {
    let bodyJson;
    try {
      bodyJson = await r1.clone().json();
    } catch {
      bodyJson = undefined;
    }
    pr = http ? http.getPaymentRequiredResponse((n) => r1.headers.get(n), bodyJson) : parse402(r1, bodyJson);
  } catch (e) {
    const row = { ...base, paid: false, units: 0, status: 402, reason: `unreadable 402: ${e.message}` };
    ledger.append(row);
    return { paid: false, reason: row.reason };
  }

  const pick = pickAccept(pr, {
    network: LIMITS.network,
    asset: LIMITS.asset,
    payTo,
    maxUnits,
  });
  if (!pick.ok) {
    const row = { ...base, paid: false, units: 0, status: 402, reason: `refused: ${pick.reason}` };
    ledger.append(row);
    return { paid: false, reason: row.reason };
  }
  const spent = ledger.spentUnits();
  if (spent + pick.units > dailyCapUnits) {
    const row = {
      ...base,
      paid: false,
      units: 0,
      status: 402,
      offered_units: pick.units,
      reason: `refused: daily cap (${spent} + ${pick.units} > ${dailyCapUnits})`,
    };
    ledger.append(row);
    return { paid: false, reason: row.reason, capped: true };
  }
  if (dryRun || !http) {
    const row = { ...base, paid: false, units: 0, status: 402, offered_units: pick.units, payTo, reason: "dry run" };
    ledger.append(row);
    return { paid: false, reason: "dry run", offered_units: pick.units };
  }

  // Sign for exactly the leg we checked, nothing else.
  const payload = await http.createPaymentPayload({ ...pr, accepts: [pick.accept] });
  const headers = http.encodePaymentSignatureHeader(payload);
  const r2 = await fetchImpl(url, { ...init, headers: { ...init.headers, ...headers } });
  let settle = null;
  try {
    settle = http.getPaymentSettleResponse((n) => r2.headers.get(n));
  } catch {
    /* no settle header */
  }
  let json = null;
  try {
    json = await r2.json();
  } catch {
    /* not JSON */
  }
  const tx = settle?.transaction ?? settle?.txHash ?? null;
  const paid = r2.status === 200 && Boolean(settle?.success);
  const row = {
    ...base,
    paid,
    units: paid ? pick.units : 0,
    status: r2.status,
    payTo,
    tx,
    ...(paid ? {} : { reason: `settle failed: ${JSON.stringify(settle)}` }),
  };
  ledger.append(row);
  return { paid, status: r2.status, json: paid ? json : null, tx, units: row.units, reason: row.reason };
}

/**
 * Read a 402 without an x402 client (dry runs with no wallet): x402 v2 puts the
 * requirements in the PAYMENT-REQUIRED header (base64 JSON); some sellers also
 * put them in the body.
 */
export function parse402(res, bodyJson) {
  const h = res.headers.get("payment-required");
  if (h) return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  return bodyJson;
}

/** Build the x402 HTTP client from SOLANA_SECRET_KEY (JSON array or base58). */
export async function makeHttpClient(secret = process.env.SOLANA_SECRET_KEY) {
  if (!secret || !secret.trim()) return null;
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
  const kit = await import("@solana/kit");
  const s = secret.trim();
  const bytes = s.startsWith("[")
    ? Uint8Array.from(JSON.parse(s))
    : new Uint8Array(kit.getBase58Encoder().encode(s));
  const signer =
    bytes.length === 64
      ? await kit.createKeyPairSignerFromBytes(bytes)
      : await kit.createKeyPairSignerFromPrivateKeyBytes(bytes);
  const client = new x402Client();
  registerExactSvmScheme(client, { signer });
  return { http: new x402HTTPClient(client), address: signer.address };
}
