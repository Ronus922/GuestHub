import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ============================================================
// TTLock secrets vault (D122). AES-256-GCM (authenticated), key derived from
// env TTLOCK_SECRETS_KEY — never stored in the DB, never sent to a browser.
// Ciphertext format: "v1.<iv>.<tag>.<data>" (base64). Every value gets a fresh
// random 96-bit IV. FAIL CLOSED: a missing key throws; there is no plaintext
// fallback. Same construction as src/lib/messaging/secrets.ts.
//
// DEDICATED KEY, ON PURPOSE. Not CHANNEL_SECRETS_KEY, not
// MESSAGING_SECRETS_ENCRYPTION_KEY. A TTLock credential opens physical doors;
// a channel credential sells rooms. Separate secret, separate blast radius —
// the same doctrine that keeps the card vault apart from both.
//
// NO `import "server-only"` HERE — DELIBERATE (D122). token.ts must be able to
// encrypt a freshly minted token from inside the PM2 channel-worker graph,
// which tsconfig.worker.json compiles to plain CommonJS with no React
// condition. The Beds24 sibling (src/lib/channel/crypto.ts) DOES carry the
// directive and is imported by worker-graph code anyway; that only works
// because the `server-only` package resolves to an EMPTY module outside
// React's react-server condition. That is an accident of packaging, not a
// design, and it is not extended to a second integration.
//
// WHAT REPLACES IT AS ENFORCEMENT. Three things, none of them this directive:
//  1. scripts/check-ttlock-secrets.mjs rule 5 fails the build if any file
//     carrying "use client" reaches src/lib/ttlock/ directly or transitively —
//     which is the actual risk (this graph landing in a browser bundle), and
//     is more than `server-only` ever checked.
//  2. This module holds no secret of its own. It reads TTLOCK_SECRETS_KEY at
//     CALL time, and Next inlines only NEXT_PUBLIC_* into a client bundle, so
//     a hypothetical client import fails closed with "not configured" rather
//     than shipping key material to the browser.
//  3. The decrypting surface (store.ts) keeps `server-only` — the boundary is
//     enforced where the secret is actually read out of the database.
// ============================================================

const KEY_VERSION = 1;
const PREFIX = `v${KEY_VERSION}`;

// True when the server has an encryption key configured — checked before any
// save/test so a missing key fails with a clear message, never a stack trace.
export function ttlockSecretsConfigured(): boolean {
  return Boolean(process.env.TTLOCK_SECRETS_KEY);
}

function key(): Buffer {
  const raw = process.env.TTLOCK_SECRETS_KEY;
  if (!raw) throw new Error("TTLOCK_SECRETS_KEY is not configured");
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
  if (version !== PREFIX) throw new Error(`Unsupported ttlock ciphertext version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// Convenience for the JSON secret bag { clientSecret, password }.
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
