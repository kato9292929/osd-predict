/**
 * Sealing (step 6): write the SHA-256 of each day's record files into a Solana
 * memo, so anyone can later check that a prediction file existed, unchanged,
 * at that time — and so a prediction cannot be quietly rewritten after the
 * outcome is known.
 *
 * Hashes are over PLAINTEXT, including the encrypted private files: the memo
 * reveals nothing, and a private file can be shown to match if it is released.
 *
 * Seals are kept per day in data/seals/YYYY-MM-DD.json as a list: a day that
 * grows after it was sealed (a chat import later the same day) gets another
 * seal, never an edited one.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, readJson, writeJson, sha256, readPrivateText } from "./store.mjs";

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** The day's files and their hashes. Missing files are left out. */
export function dayManifest(day, key) {
  const files = {};
  const pub = (rel) => {
    const f = path.join(DATA, rel);
    if (fs.existsSync(f)) files[rel] = sha256(fs.readFileSync(f, "utf8"));
  };
  pub(`predictions/${day}.jsonl`);
  pub(`flows-public/${day}.jsonl`);
  for (const kind of ["flows", "predictions-n"]) {
    let text = "";
    try {
      text = readPrivateText(kind, day, key);
    } catch {
      text = "";
    }
    if (text) files[`private/${kind}/${day}.jsonl (plaintext)`] = sha256(text);
  }
  return files;
}

/** Short names keep the memo well under Solana's memo size limit. */
const SHORT = {
  predictions: "pred",
  "flows-public": "fi",
  "private/flows": "flows",
  "private/predictions-n": "predn",
};

export function memoText(day, files) {
  const parts = Object.entries(files).map(([rel, h]) => {
    const key = Object.keys(SHORT).find((k) => rel.startsWith(`${k}/`));
    return `${SHORT[key] ?? rel}=${h}`;
  });
  return `osd-predict|${day}|${parts.join("|")}`;
}

/** Has this exact manifest already been sealed? */
export function needsSeal(day, files) {
  if (Object.keys(files).length === 0) return false;
  const seals = readJson(path.join(DATA, "seals", `${day}.json`), []);
  const last = seals.at(-1);
  return !last || JSON.stringify(last.files) !== JSON.stringify(files);
}

export function recordSeal(day, files, memo, tx) {
  const file = path.join(DATA, "seals", `${day}.json`);
  const seals = readJson(file, []);
  seals.push({ sealed_at: new Date().toISOString(), files, memo, memo_tx: tx });
  writeJson(file, seals);
}

/** Send a memo transaction. Needs SOL for the fee. Returns the signature. */
export async function sendMemo(memo, { secret = process.env.SOLANA_SECRET_KEY, rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com" } = {}) {
  // `||`, not `??`: an unset Actions secret arrives as "", not undefined —
  // the first funded run (2026-11-03) failed both seals on exactly that.
  const web3 = await import("@solana/web3.js");
  const kit = await import("@solana/kit");
  const s = secret.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : new Uint8Array(kit.getBase58Encoder().encode(s));
  const payer = bytes.length === 64 ? web3.Keypair.fromSecretKey(bytes) : web3.Keypair.fromSeed(bytes);
  const conn = new web3.Connection(rpc, "confirmed");
  const ix = new web3.TransactionInstruction({
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    programId: new web3.PublicKey(MEMO_PROGRAM_ID),
    data: Buffer.from(memo, "utf8"),
  });
  return web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(ix), [payer]);
}
