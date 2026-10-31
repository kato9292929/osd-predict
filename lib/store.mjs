/**
 * Where records live.
 *
 *   data/      public. Committed in the clear.
 *   private/   Nansen Smart Money Netflows data and System N predictions (whose
 *              basis carries those flows). Committed ENCRYPTED (AES-256-GCM,
 *              key in PRIVATE_DATA_KEY). Until Nansen approves redistribution,
 *              smart-money/netflow is for internal analysis only; publishing it
 *              in the clear — even in a git log — would be redistribution.
 *
 * Everything is append-only: a day's file only ever grows. Seals hash the
 * plaintext, so a private file can be shown to match its seal if it is ever
 * released.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./money.mjs";

export const DATA = path.join(ROOT, "data");
export const PRIVATE = path.join(ROOT, "private");

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function appendJsonl(file, rows) {
  if (rows.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ── encryption ────────────────────────────────────────────────────────────

function keyBytes(key = process.env.PRIVATE_DATA_KEY) {
  if (!key) throw new Error("PRIVATE_DATA_KEY is not set");
  const b = Buffer.from(key, "base64");
  if (b.length !== 32) throw new Error("PRIVATE_DATA_KEY must be 32 bytes, base64");
  return b;
}

/** "v1:" + base64(iv(12) | tag(16) | ciphertext) */
export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}\n`;
}

export function decrypt(blob, key) {
  const raw = Buffer.from(String(blob).trim().replace(/^v1:/, ""), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBytes(key), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** Plaintext of a private day file (`private/<kind>/<day>.jsonl.enc`), or "". */
export function readPrivateText(kind, day, key) {
  const file = path.join(PRIVATE, kind, `${day}.jsonl.enc`);
  if (!fs.existsSync(file)) return "";
  return decrypt(fs.readFileSync(file, "utf8"), key);
}

export function readPrivate(kind, day, key) {
  return readPrivateText(kind, day, key)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Append to a private day file: decrypt, append, re-encrypt. */
export function appendPrivate(kind, day, rows, key) {
  if (rows.length === 0) return;
  const before = readPrivateText(kind, day, key);
  const after = before + rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  const file = path.join(PRIVATE, kind, `${day}.jsonl.enc`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encrypt(after, key));
}

export function privateDays(kind) {
  try {
    return fs
      .readdirSync(path.join(PRIVATE, kind))
      .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl\.enc$/)?.[1])
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export function publicDays(dir) {
  try {
    return fs
      .readdirSync(path.join(DATA, dir))
      .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}
