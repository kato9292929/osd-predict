import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Run every test in a scratch copy so nothing touches the real data/.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "osd-predict-"));
fs.cpSync(path.join(REPO, "config"), path.join(WORK, "config"), { recursive: true });
process.chdir(WORK);

const KEY = crypto.randomBytes(32).toString("base64");
const { pickAccept, Ledger, buy, LIMITS } = await import("../lib/money.mjs");
const { baseRate, conditionType, flowState, systemN, reestimate, DEFAULT_ADJUST } = await import("../lib/predict.mjs");
const { scorecard, publicScorecard, lastBeforeDeadline } = await import("../lib/score.mjs");
const { encrypt, decrypt, appendPrivate, readPrivate } = await import("../lib/store.mjs");
const { memoText, dayManifest } = await import("../lib/seal.mjs");
const { planPredictions } = await import("../scripts/import-chat-predictions.mjs");
const { conditions, predictable, shouldBuyOsd, diffSnapshots, snapshot } = await import("../lib/osd.mjs");
const { netflowRows } = await import("../lib/nansen.mjs");
const { runDaily } = await import("../scripts/run-daily.mjs");

const NET = LIMITS.network;
const USDC = LIMITS.asset;
const NANSEN = LIMITS.nansen.payTo;
const leg = (o) => ({ scheme: "exact", network: NET, asset: USDC, amount: "50000", payTo: NANSEN, ...o });

// ── payment guards ────────────────────────────────────────────────────────

test("only a Solana USDC leg to the pinned payTo, at or under the ceiling, is paid", () => {
  const base = { network: NET, asset: USDC, payTo: NANSEN, maxUnits: 50000 };
  assert.equal(pickAccept({ accepts: [leg({ network: "eip155:8453" }), leg()] }, base).ok, true);
  assert.match(pickAccept({ accepts: [leg({ payTo: "Evil111" })] }, base).reason, /payTo mismatch/);
  assert.match(pickAccept({ accepts: [leg({ amount: "50001" })] }, base).reason, /exceeds ceiling 50000/);
  assert.match(pickAccept({ accepts: [leg({ network: "eip155:8453" })] }, base).reason, /no solana/);
  assert.match(pickAccept({ accepts: [leg({ asset: "OtherMint" })] }, base).reason, /no solana/);
});

function fakeHttp() {
  const signed = [];
  return {
    signed,
    getPaymentRequiredResponse: (_h, body) => body,
    createPaymentPayload: async (pr) => {
      signed.push(pr.accepts);
      return { ok: true };
    },
    encodePaymentSignatureHeader: () => ({ "PAYMENT-SIGNATURE": "sig" }),
    getPaymentSettleResponse: () => ({ success: true, transaction: `tx${signed.length}`, network: NET }),
  };
}

function fakeFetch(accepts, data = { data: [] }) {
  return async (_url, init) =>
    init.headers?.["PAYMENT-SIGNATURE"]
      ? new Response(JSON.stringify(data), { status: 200 })
      : new Response(JSON.stringify({ x402Version: 2, accepts }), { status: 402 });
}

test("buy signs exactly the checked leg, logs the tx, and respects the daily cap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const ledger = new Ledger(dir, "2026-11-01");
  const http = fakeHttp();
  const evm = { ...leg({ network: "eip155:8453", payTo: "0xabc" }) };
  const r = await buy({ seller: "nansen", key: "k1", url: "u", payTo: NANSEN, maxUnits: 50000, ledger, http, fetchImpl: fakeFetch([evm, leg()]) });
  assert.equal(r.paid, true);
  assert.equal(r.tx, "tx1");
  assert.deepEqual(http.signed[0], [leg()], "only the Solana leg we checked was handed to the signer");
  assert.equal(ledger.spentUnits(), 50000);

  const capped = await buy({ seller: "nansen", key: "k2", url: "u", payTo: NANSEN, maxUnits: 50000, ledger, http, dailyCapUnits: 60000, fetchImpl: fakeFetch([leg()]) });
  assert.equal(capped.paid, false);
  assert.match(capped.reason, /daily cap \(50000 \+ 50000 > 60000\)/);

  const twice = await buy({ seller: "nansen", key: "k1", url: "u", payTo: NANSEN, maxUnits: 50000, ledger, http, oncePerDay: true, fetchImpl: fakeFetch([leg()]) });
  assert.equal(twice.paid, false);
  assert.equal(twice.reason, "already bought today");
  assert.equal(http.signed.length, 1, "nothing else was signed");
  const rows = ledger.rows();
  assert.equal(rows.length, 3, "refusals are logged too");
});

test("a free response (no 402) is not paid for", async () => {
  const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "2026-11-01");
  const r = await buy({ seller: "osd", key: "AAL", url: "u", payTo: LIMITS.osd.payTo, maxUnits: 5000, ledger, http: fakeHttp(), fetchImpl: async () => new Response("{}", { status: 200 }) });
  assert.equal(r.paid, false);
  assert.equal(ledger.spentUnits(), 0);
});

// ── predictions ───────────────────────────────────────────────────────────

const J = (id, kind, ticker, status, cond = "売上が増加") => ({ id, kind, ticker, status, success_condition: cond });

test("System A shrinks small groups toward their parent and records the basis", () => {
  const judged = [
    ...Array.from({ length: 30 }, (_, i) => J(`us:w${i}:X${i}`, "us", `X${i}`, i < 18 ? "hit" : "miss")),
    J("us:a:NVDA", "us", "NVDA", "hit"),
  ];
  const a = baseRate({ id: "us:z:NVDA", kind: "us", ticker: "NVDA", success_condition: "売上が増加", date_verified: true }, judged);
  assert.ok(a.p_hit > 0.6 && a.p_hit < 0.7, `one hit should move NVDA only a little: ${a.p_hit}`);
  assert.equal(a.basis.population_n, 31);
  assert.equal(a.basis.levels.at(-1).n, 1);
  const unverified = baseRate({ id: "us:z:NVDA", kind: "us", ticker: "NVDA", success_condition: "売上が増加", date_verified: false }, judged);
  assert.ok(Math.abs(unverified.p_hit - 0.5) < Math.abs(a.p_hit - 0.5), "an unchecked date pulls toward 0.5");
  assert.equal(conditionType({ success_condition: "通期ガイダンスが上方修正" }), "guidance");
  assert.equal(conditionType({ success_condition: "受注残が増加" }), "orders");
  assert.equal(conditionType({ catalyst_type: "event", success_condition: "提携を発表" }), "event");
});

test("flow states need two traders; System N shifts A by the state's adjustment", () => {
  const row = (net7, tc) => ({ has_flow: true, net_flow_7d_usd: net7, trader_count: tc, fetched_at: "t" });
  assert.equal(flowState([row(1000, 2)]).state, "inflow");
  assert.equal(flowState([row(-1000, 3)]).state, "outflow");
  assert.equal(flowState([row(1000, 1)]).state, "none");
  assert.equal(flowState([{ has_flow: false }]).state, "none");
  assert.equal(flowState([row(600, 1), row(600, 1)]).state, "inflow", "xStocks + Ondo are summed");
  const a = { p_hit: 0.56, basis: { population_n: 28 } };
  assert.equal(systemN(a, flowState([row(48000, 4)]), DEFAULT_ADJUST).p_hit, 0.61);
  assert.equal(reestimate(Array(19).fill({ state: "inflow", p_a: 0.5, y: 1 }), DEFAULT_ADJUST), null);
  const re = reestimate(Array(20).fill({ state: "inflow", p_a: 0.5, y: 1 }), DEFAULT_ADJUST);
  assert.equal(re.adjust.inflow, 0.5);
  assert.equal(re.adjust.outflow, -0.05, "a state without enough rows keeps its value");
});

test("netflow rows: a mint Nansen did not return is recorded as no flow", () => {
  const rows = netflowRows(
    [{ mint: "A", ticker: "NVDA" }, { mint: "B", ticker: "NVDA" }],
    { data: [{ token_address: "A", net_flow_7d_usd: 48000, trader_count: 4 }, { token_address: "Z", net_flow_7d_usd: 1 }] },
    "tx",
    "t",
  );
  assert.deepEqual(rows.map((r) => [r.mint, r.has_flow, r.net_flow_7d_usd]), [["A", true, 48000], ["B", false, 0]]);
});

// ── scoring ───────────────────────────────────────────────────────────────

test("the last prediction on or before the deadline is the one scored", () => {
  const preds = [
    { id: "x", p_hit: 0.2, predicted_at: "2026-11-01T00:00:00Z" },
    { id: "x", p_hit: 0.9, predicted_at: "2026-11-05T00:00:00Z" },
    { id: "x", p_hit: 0.1, predicted_at: "2026-11-07T00:00:00Z" },
  ];
  assert.equal(lastBeforeDeadline(preds, "2026-11-05").p_hit, 0.9);
  const card = scorecard(
    [{ id: "x", kind: "us", status: "hit", deadline: "2026-11-05" }, { id: "y", kind: "us", status: "na", deadline: "2026-11-05" }],
    { A: preds, N: [{ id: "x", p_hit: 0.8, predicted_at: "2026-11-02T00:00:00Z", basis: { flow_state: "inflow", base_rate: 0.75 } }] },
  );
  assert.equal(card.predictors.A.brier, 0.01);
  assert.equal(card.predictors.A.n, 1, "na is not scored");
  assert.equal(card.constant_half.brier, 0.25);
  assert.deepEqual(card.predictors.N.by_flow_state, { inflow: { n: 1, hit_rate: 1 } });
  assert.equal(publicScorecard(card).predictors.N.pairs, undefined, "per-condition pairs never leave");
});

// ── private storage & seals ───────────────────────────────────────────────

test("private files are encrypted, append-only, and sealed on their plaintext", () => {
  assert.equal(decrypt(encrypt("hello", KEY), KEY), "hello");
  appendPrivate("flows", "2026-11-01", [{ a: 1 }], KEY);
  appendPrivate("flows", "2026-11-01", [{ a: 2 }], KEY);
  assert.deepEqual(readPrivate("flows", "2026-11-01", KEY), [{ a: 1 }, { a: 2 }]);
  const onDisk = fs.readFileSync("private/flows/2026-11-01.jsonl.enc", "utf8");
  assert.ok(!onDisk.includes('"a"'), "nothing readable on disk");
  const m = dayManifest("2026-11-01", KEY);
  const plain = crypto.createHash("sha256").update('{"a":1}\n{"a":2}\n').digest("hex");
  assert.equal(m["private/flows/2026-11-01.jsonl (plaintext)"], plain);
  const memo = memoText("2026-11-01", m);
  assert.equal(memo, `osd-predict|2026-11-01|flows=${plain}`);
  assert.ok(Buffer.byteLength(memoText("2026-11-01", { "predictions/x": plain, "flows-public/x": plain, "private/flows/x": plain, "private/predictions-n/x": plain })) < 500);
});

// ── chat import ───────────────────────────────────────────────────────────

test("chat predictions need a source URL and a deadline still ahead", () => {
  const conds = [{ id: "us:2026-11-02:NVDA", target_date: "2026-11-19", deadline: "2026-11-19" }];
  const it = (o) => ({ id: "us:2026-11-02:NVDA", p_hit: 0.6, reasoning: "r", sources: ["https://nvidianews.nvidia.com/x"], predicted_at: "2026-11-01T00:00:00Z", predictor: "claude-fable-5-1 (chat)", ...o });
  const plan = planPredictions(
    { type: "predictions", items: [it(), it({ id: "us:2026-11-02:NVDA", sources: [] }), it({ predicted_at: "2026-11-20T00:00:00Z" }), it({ id: "nope" }), it({ p_hit: 1.2 })] },
    conds,
  );
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rejected.length, 4);
  assert.match(plan.rejected.map((r) => r.reasons.join()).join("|"), /duplicate id|sources must be/);
  assert.match(plan.rejected.map((r) => r.reasons.join()).join("|"), /deadline 2026-11-19 has passed/);
});

// ── the daily run, end to end, offline ───────────────────────────────────

function osdFixture() {
  const ev = (week, ticker, target, status) => ({ week_of: week, ticker, catalyst_target_date: target, success_condition: "売上が増加", status, evaluated_at: status === "pending" ? null : "2026-10-20T00:00:00Z", evidence_url: null, reasoning: null });
  return {
    usHistory: { current: { week_of: "2026-10-19", holdings: [{ ticker: "NVDA", company_name: "NVIDIA", target_date: "2026-11-19" }, { ticker: "MSFT", company_name: "Microsoft", target_date: "2026-10-28", target_date_source: "verified", target_date_confirmed: "2026-10-29" }] }, history: [] },
    usEvals: { evaluations: [ev("2026-10-19", "NVDA", "2026-11-19", "pending"), ev("2026-10-19", "MSFT", "2026-10-28", "pending"), ...Array.from({ length: 6 }, (_, i) => ev("2026-09-21", `T${i}`, "2026-10-10", i < 4 ? "hit" : "miss"))] },
    jpHistory: { current: { week_of: "2026-10-19", holdings: [{ ticker: "8035", company_name: "東京エレクトロン", target_date: "2026-11-06" }] }, history: [] },
    jpEvals: { evaluations: [ev("2026-10-19", "8035", "2026-11-06", "pending")] },
    externals: [],
    irFair: { catalysts: [] },
    solanaStocks: { tokens: [{ ticker: "NVDA", symbol: "NVDAx", issuer: "xStocks", solana_mint: "MintNVDAx" }, { ticker: "NVDA", symbol: "NVDAon", issuer: "Ondo", solana_mint: "MintNVDAon" }] },
  };
}

test("the daily run buys within the limits, predicts, keeps netflow private, and seals", async () => {
  const http = fakeHttp();
  const memos = [];
  const fetchImpl = async (url, init) => {
    const paid = Boolean(init?.headers?.["PAYMENT-SIGNATURE"]);
    if (url.includes("smart-money/netflow")) {
      return paid
        ? new Response(JSON.stringify({ data: [{ token_address: "MintNVDAx", net_flow_7d_usd: 48000, trader_count: 4 }] }), { status: 200 })
        : new Response(JSON.stringify({ accepts: [leg()] }), { status: 402 });
    }
    if (url.includes("flow-intelligence")) {
      return paid
        ? new Response(JSON.stringify({ data: [{ smart_trader_net_flow_usd: 1 }] }), { status: 200 })
        : new Response(JSON.stringify({ accepts: [leg({ amount: "10000" })] }), { status: 402 });
    }
    if (url.includes("/api/solana-stocks/")) {
      return paid
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ accepts: [leg({ amount: "1000", payTo: LIMITS.osd.payTo })] }), { status: 402 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const r = await runDaily({
    now: () => "2026-11-01T22:00:00.000Z",
    osdFiles: osdFixture(),
    http,
    fetchImpl,
    key: KEY,
    canSeal: true,
    sealer: async (memo) => {
      memos.push(memo);
      return "memoTx1";
    },
  });
  assert.equal(r.netflow.paid, true);
  assert.equal(r.netflow.with_flow, 1);
  assert.equal(r.flow_intelligence.bought, 2, "one per mint");
  assert.equal(r.osd.bought, 1, "NVDA — never bought before");
  assert.equal(r.spent.units, 50000 + 2 * 10000 + 1000);
  // MSFT's deadline (confirmed 10-29) has passed; NVDA and 8035 remain.
  assert.equal(r.predictions.predictable, 2);
  assert.equal(r.predictions.written_a, 2);
  assert.equal(r.predictions.written_n, 1, "only NVDA has Solana tokens — 8035 gets no System N");
  assert.deepEqual(r.predictions.n_states, { inflow: 1 });

  // Public files carry no smart-money values.
  const pub = fs.readFileSync("data/predictions/2026-11-01.jsonl", "utf8");
  assert.ok(!pub.includes("net_flow"), "System N stays out of the public file");
  assert.ok(!pub.includes(PREDICTOR_N_NAME));
  assert.ok(fs.existsSync("private/flows/2026-11-01.jsonl.enc"));
  assert.equal(r.seals[0].memo_tx, "memoTx1");
  assert.match(memos[0], /^osd-predict\|2026-11-01\|pred=[0-9a-f]{64}\|fi=[0-9a-f]{64}\|flows=[0-9a-f]{64}\|predn=[0-9a-f]{64}$/);

  // Same day again: nothing re-bought, nothing re-sealed.
  const again = await runDaily({ now: () => "2026-11-01T23:00:00.000Z", osdFiles: osdFixture(), http, fetchImpl, key: KEY, canSeal: true, sealer: async () => "memoTx2" });
  assert.equal(again.spent.units, r.spent.units);
  assert.equal(again.predictions.written_a, 0, "unchanged predictions are not re-written");
  assert.equal(again.seals.length, 0);
});

const PREDICTOR_N_NAME = "base-rate+nansen-v1";

test("no wallet: System A still runs and nothing is bought or sealed", async () => {
  fs.rmSync("data", { recursive: true, force: true });
  fs.rmSync("private", { recursive: true, force: true });
  const r = await runDaily({ now: () => "2026-11-02T22:00:00.000Z", osdFiles: osdFixture(), http: null, key: KEY, canSeal: false, fetchImpl: async () => { throw new Error("no network expected"); } });
  assert.equal(r.netflow.reason, "no wallet");
  assert.equal(r.spent.units, 0);
  assert.equal(r.predictions.written_a, 2);
  assert.equal(r.seals[0].reason, "no wallet");
});

test("no buy/sell recommendation wording anywhere user-facing", () => {
  const files = ["README.md", "app/page.tsx", "app/layout.tsx", "app/api/flows/[ticker]/route.ts", "app/api/predictions/latest/route.ts", "app/api/predictions/[id]/route.ts", "scripts/export-for-chat.mjs"];
  for (const f of files) {
    const t = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.ok(!/\b(STRONG\s+)?(BUY|SELL)\b/.test(t), `${f} uses BUY/SELL`);
    assert.ok(!/買い推奨|売り推奨|買いシグナル|売りシグナル/.test(t), `${f} uses a recommendation word`);
  }
});

test("the shared vocabulary is OSD's, unchanged", () => {
  const ours = fs.readFileSync(path.join(REPO, "vendor", "osd-chat-ops.mjs"), "utf8");
  assert.match(ours, /export const GRACE_DAYS = 7;/);
  assert.match(ours, /us:<week_of>:<ticker>/);
});

test("the commit step does not fail before private/ exists", () => {
  // 2026-11-02: the first scheduled run computed everything, then died on
  // `git add data private` because no key meant no private/ directory.
  const wf = fs.readFileSync(path.join(REPO, ".github/workflows/daily.yml"), "utf8");
  assert.ok(!/git add data private/.test(wf));
  assert.match(wf, /if \[ -d private \]; then git add private; fi/);
});

test("an empty SOLANA_RPC_URL (unset Actions secret) falls back to the public RPC", () => {
  const src = fs.readFileSync(path.join(REPO, "lib", "seal.mjs"), "utf8");
  assert.match(src, /process\.env\.SOLANA_RPC_URL \|\| "https:\/\/api\.mainnet-beta\.solana\.com"/);
});
