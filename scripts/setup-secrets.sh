#!/usr/bin/env bash
# Run ONCE on your own machine, in a clone of osd-predict, with `gh` logged in.
# Generates the predict wallet and the private-data key locally and stores them
# as Actions secrets. The wallet key is never printed or written to disk; only
# its PUBLIC address is shown, so it can be funded. The private-data key is also
# saved to ~/.config/osd-predict/private-data-key (mode 600): the weekly chat
# export decrypts the internal Nansen flows with it, so it has to be available
# where the export runs (add it as PRIVATE_DATA_KEY to that environment).
set -euo pipefail
command -v gh >/dev/null || { echo "gh (GitHub CLI) is required"; exit 1; }
npm ci --silent
node --input-type=module -e '
  import { createKeyPairSignerFromBytes } from "@solana/kit";
  import crypto from "node:crypto";
  import { execFileSync } from "node:child_process";
  const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.webcrypto.subtle.exportKey("pkcs8", privateKey));
  const seed = pkcs8.slice(-32);
  const pub = new Uint8Array(await crypto.webcrypto.subtle.exportKey("raw", publicKey));
  const secret = JSON.stringify([...seed, ...pub]);
  const signer = await createKeyPairSignerFromBytes(new Uint8Array([...seed, ...pub]));
  execFileSync("gh", ["secret", "set", "SOLANA_SECRET_KEY"], { input: secret });
  const dataKey = crypto.randomBytes(32).toString("base64");
  execFileSync("gh", ["secret", "set", "PRIVATE_DATA_KEY"], { input: dataKey });
  const fs = await import("node:fs");
  const dir = `${process.env.HOME}/.config/osd-predict`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/private-data-key`, dataKey, { mode: 0o600 });
  console.log("Secrets set: SOLANA_SECRET_KEY, PRIVATE_DATA_KEY");
  console.log("Fund this address with USDC (and ~0.02 SOL for memo fees):", signer.address);
'
