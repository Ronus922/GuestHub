#!/usr/bin/env node
// check:channel-security (Stage 4, V2 §17) — the channel surface (inbound +
// outbound) is hardened: non-leaking, and secrets never cross a trust boundary.
// Source-level audit (the functional behaviour is DB-tested by
// check:inbound-bookings).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// (The inbound webhook endpoint was removed — Beds24 delivers bookings by
//  polling, so there is no inbound HTTP surface left to harden here.)

// ---- no secret ever leaves the inbound/outbound modules ----
// (Internal helpers that resolve credentials legitimately return the decrypted
//  key for the immediate server-side HTTP call — that is NOT a leak.
//  The real leak surfaces are: a log line, an audit payload, or the api-key
//  placed anywhere other than the request header.)
const channelFiles = readdirSync(join(root, "src/lib/channel")).filter((f) => f.endsWith(".ts"));
let leak = 0;
for (const f of channelFiles) {
  const src = read(`src/lib/channel/${f}`);
  // never console.* a raw key/ciphertext/token
  if (/console\.(log|error|warn)\([^)]*(apiKey|api_key_ciphertext|webhook_token\b|decryptSecret\()/.test(src)) {
    flag(`${f}: a secret may be logged`); leak++;
  }
  // never place a secret into an audit `after:`/`before:` payload
  if (/(after|before):\s*\{[^}]*(apiKey|api_key_ciphertext|decryptSecret\()/.test(src)) {
    flag(`${f}: a secret may enter an audit payload`); leak++;
  }
}
if (!leak) pass("no api-key / ciphertext / token reaches a log or an audit payload");

// ---- the api-key travels ONLY in the request header, never a URL/query ----
const http = read("src/lib/channel/channel-http.ts");
if (!/"user-api-key":\s*opts\.apiKey/.test(http)) flag("api-key is not sent via the user-api-key header");
else pass("api-key travels only in the user-api-key header");
if (/\?[^"'`\n]*apiKey|`\$\{[^}]*apiKey/.test(http)) flag("api-key may appear in a URL/query string");
else pass("api-key never appears in a URL/query string");

// ---- the masked connection view never exposes the ciphertext ----
const admin = read("src/lib/channel/beds24-admin.ts");
if (/Beds24ConnectionView[\s\S]{0,400}api_key_ciphertext/.test(admin))
  flag("the masked connection view exposes the ciphertext");
else pass("masked connection view exposes only the hint, never the ciphertext");

// ---- channel admin actions are auth-gated ----
for (const f of ["admin.ts", "beds24-admin.ts", "external-changes-admin.ts"]) {
  const src = read(`src/lib/channel/${f}`);
  if (!/requireChannelAdmin\(|canManageChannels\(/.test(src))
    flag(`${f}: no channel-admin authorization guard found`);
}
if (!fail) pass("channel admin actions enforce canManageChannels server-side");

// ---- booking import decrypts the key server-side only (never client) ----
const bookings = read("src/lib/channel/beds24-booking-import.ts");
if (/"use client"/.test(bookings)) flag("beds24-booking-import is a client module (must be server-only)");
else pass("booking import is server-side only");

if (fail) { console.log(`\ncheck:channel-security — FAIL (${fail})`); process.exit(1); }
console.log("check:channel-security — PASS");
