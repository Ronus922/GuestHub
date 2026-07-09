import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ============================================================
// Server-only secret handling for future channel credentials (§P).
// AES-256-GCM with a key from CHANNEL_SECRETS_KEY (env, never in DB).
// Phase 3 stores NO secret anywhere — these exist so activation never
// invents an ad-hoc plaintext path. Ciphertext format: iv.tag.data (base64).
// Decryption is server-only; nothing here is ever returned to a browser.
// ============================================================

function key(): Buffer {
  const raw = process.env.CHANNEL_SECRETS_KEY;
  if (!raw) throw new Error("CHANNEL_SECRETS_KEY is not configured");
  return createHash("sha256").update(raw).digest();
}

// True when the server has an encryption key configured — checked before any
// save/test so a missing key fails with a clear message, never a stack trace.
export function channelSecretsConfigured(): boolean {
  return !!process.env.CHANNEL_SECRETS_KEY;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(ciphertext: string): string {
  const [iv, tag, data] = ciphertext.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Masked hint for display (never the secret itself): "••••1a2b".
export function secretHint(plaintext: string): string {
  return `••••${plaintext.slice(-4)}`;
}

// Webhook tokens are stored hashed only (§Y).
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url"); // 256-bit, unguessable
}
