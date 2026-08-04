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

// ---- the credential travels ONLY in request headers, never a URL/query ----
// The file that actually issues requests is beds24-http.ts (D91: Channex and its
// user-api-key scheme are gone; channel-http.ts holds only the taxonomy/evidence
// primitives and sends nothing). Beds24's scheme: regular calls carry the access
// token in a `token` header; the two /authentication endpoints carry their
// credential in a dedicated header (`code` / `refreshToken`).
const http = read("src/lib/channel/beds24-http.ts");
if (!/headers:\s*\{\s*token:\s*opts\.token\s*\}/.test(http)) flag("the access token is not sent via the `token` header");
else pass("access token travels only in the `token` header");
if (!/headers:\s*\{\s*\[opts\.authHeader\.name\]:\s*opts\.authHeader\.value\s*\}/.test(http))
  flag("auth-endpoint credential is not sent via its dedicated header (code/refreshToken)");
else pass("auth credential travels only in its dedicated header (code / refreshToken)");
// the ONE URL ever fetched is bare baseUrl+path — a credential in the URL/query
// would land in access logs and proxies, so the shape itself is the invariant
if (!/fetchImpl\(`\$\{opts\.baseUrl\}\$\{opts\.path\}`/.test(http))
  flag("request URL is not the bare baseUrl+path (a credential could ride the URL)");
else pass("request URL is exactly baseUrl+path — headers are the only credential carrier");
if (/[?&](token|code|refreshToken|apiKey)=/i.test(http) || /`[^`\n]*\?[^`\n]*\$\{[^}]*(token|code|key)/i.test(http))
  flag("a credential may appear in a URL/query string");
else pass("no credential ever appears in a URL/query string");

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
