import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ============================================================
// Messaging provider secrets vault (D53). AES-256-GCM (authenticated), key
// derived from env MESSAGING_SECRETS_ENCRYPTION_KEY — never stored in the DB,
// never sent to a browser. Ciphertext format: "v1.<iv>.<tag>.<data>" (base64).
// Every value gets a fresh random 96-bit IV. FAIL CLOSED: a missing key throws;
// there is no plaintext fallback. Separate secret / blast radius from the card
// vault on purpose (src/lib/card-vault.ts) — same construction.
//
// The plaintext is a JSON "secret bag": provider tokens/passwords/refresh
// tokens. Only the server ever decrypts it; client-facing code receives masked
// hints (maskSecret) — never the raw value.
// ============================================================

const KEY_VERSION = 1;
const PREFIX = `v${KEY_VERSION}`;

export function messagingSecretsConfigured(): boolean {
  return Boolean(process.env.MESSAGING_SECRETS_ENCRYPTION_KEY);
}

function key(): Buffer {
  const raw = process.env.MESSAGING_SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error("MESSAGING_SECRETS_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptSecret(ciphertext: string): string {
  const [version, iv, tag, data] = ciphertext.split(".");
  if (version !== PREFIX) throw new Error(`Unsupported messaging ciphertext version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// Convenience for the JSON secret bag (typed by the caller).
export function encryptSecretBag(bag: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(bag));
}
export function decryptSecretBag(ciphertext: string): Record<string, unknown> {
  return JSON.parse(decryptSecret(ciphertext)) as Record<string, unknown>;
}

// Masked hint for the UI: "••••••••A92F" (last 4 shown). NEVER returns the
// secret. An empty/short secret still masks to dots so length isn't leaked.
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const tail = value.length >= 4 ? value.slice(-4).toUpperCase() : "";
  return "••••••••" + tail;
}
