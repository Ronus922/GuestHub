import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ============================================================
// Protected PAN storage (D41). AES-256-GCM (authenticated), key derived
// from env CARD_VAULT_KEY — never stored in the DB, never sent to a
// browser. Ciphertext format: "v1.<iv>.<tag>.<data>" (base64) — the "v1"
// prefix is the key/format version for future rotation. Every value gets
// a fresh random 96-bit IV (never deterministic). FAIL CLOSED: a missing
// key throws — there is no plaintext fallback anywhere.
// Same construction as src/lib/channel/crypto.ts (kept separate on
// purpose: separate secret, separate blast radius, version metadata).
// ============================================================

export const CARD_KEY_VERSION = 1;
const PREFIX = `v${CARD_KEY_VERSION}`;

export function cardVaultConfigured(): boolean {
  return Boolean(process.env.CARD_VAULT_KEY);
}

function key(): Buffer {
  const raw = process.env.CARD_VAULT_KEY;
  if (!raw) throw new Error("CARD_VAULT_KEY is not configured");
  return createHash("sha256").update(raw).digest();
}

export function encryptPan(pan: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptPan(ciphertext: string): string {
  const [version, iv, tag, data] = ciphertext.split(".");
  if (version !== PREFIX) throw new Error(`Unsupported card ciphertext version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
