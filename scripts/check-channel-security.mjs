#!/usr/bin/env node
// check:channel-security (Stage 4, V2 §17) — the channel surface (webhook +
// inbound + outbound) is hardened: authenticated, non-leaking, no existence
// oracle, bounded, and secrets never cross a trust boundary. Source-level audit
// (the functional behaviour is DB-tested by check:inbound-bookings).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// ---- webhook endpoint hardening ----
const wh = read("src/app/api/channel/webhook/[token]/route.ts");
const webhookChecks = {
  "token authenticated by hash (never plaintext compare)": /webhook_token_hash = \$\{sha256Hex\(token\)\}/,
  "minimum token length gate": /token\.length < 20/,
  "unknown token → 404 (no tenant/existence oracle)": /if \(!conn\)[\s\S]{0,80}status:\s*404/,
  "requires an ACTIVE, inbound-enabled connection": /state = 'active' AND inbound_sync_enabled = true/,
  "body size is bounded": /MAX_BODY_BYTES/,
  "per-token rate limit": /rateLimited\(/,
  "payload redacted before persistence": /redactPayload\(/,
  "sanitized 5xx (no upstream body leaked)": /temporary failure[\s\S]{0,40}status:\s*503/,
  "processing is async (enqueue, never mutate bookings in the request)": /enqueueChannelJob\(/,
};
for (const [name, re] of Object.entries(webhookChecks))
  if (!re.test(wh)) flag(`webhook: ${name} — missing`);
if (!fail) pass("webhook endpoint hardened (auth, no oracle, bounded, redacted, async)");
// the webhook must never mutate a booking/reservation inline
if (/INSERT INTO guesthub\.reservations|UPDATE guesthub\.reservations/.test(wh))
  flag("webhook mutates reservations inline (must only enqueue)");
else pass("webhook never mutates bookings inline");

// ---- token is stored hashed only ----
const migrations = readdirSync(join(root, "db/migrations")).map((f) => read(`db/migrations/${f}`)).join("\n");
if (/webhook_token\s+text/.test(migrations) && !/webhook_token_hash/.test(migrations))
  flag("webhook token appears stored in plaintext");
else pass("webhook token stored hashed (webhook_token_hash)");

// ---- no secret ever leaves the inbound/outbound modules ----
// (Internal helpers like withChannexKey/credentialsFor legitimately return the
//  decrypted key for the immediate server-side HTTP call — that is NOT a leak.
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
const admin = read("src/lib/channel/admin.ts");
if (/ChannexConnectionView[\s\S]{0,400}api_key_ciphertext/.test(admin))
  flag("the masked connection view exposes the ciphertext");
else pass("masked connection view exposes only the hint, never the ciphertext");

// ---- inbound + channel admin actions are auth-gated ----
for (const f of ["inbound-admin.ts", "admin.ts", "certification.ts", "rate-plan-admin.ts", "room-type-admin.ts"]) {
  const src = read(`src/lib/channel/${f}`);
  if (!/requireChannelAdmin\(|canManageChannels\(/.test(src))
    flag(`${f}: no channel-admin authorization guard found`);
}
if (!fail) pass("channel admin + inbound actions enforce canManageChannels server-side");

// ---- ACK/pull decrypt the key server-side only (never client) ----
const bookings = read("src/lib/channel/channex-bookings.ts");
if (/"use client"/.test(bookings)) flag("channex-bookings is a client module (must be server-only)");
else pass("booking client is server-side only");

if (fail) { console.log(`\ncheck:channel-security — FAIL (${fail})`); process.exit(1); }
console.log("check:channel-security — PASS");
