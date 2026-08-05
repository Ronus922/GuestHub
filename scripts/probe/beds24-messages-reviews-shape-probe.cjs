#!/usr/bin/env node
// ============================================================
// THROWAWAY shape probe (Phase 4 prep) — read-only, GET only.
//
// Makes exactly TWO live calls against the production connection
// (property 342449), through the existing production transport —
// beds24BaseUrl() + getBeds24AccessToken() + beds24Request() — and dumps
// both raw response bodies VERBATIM (the exact bytes received, captured by
// a tee-ing fetch wrapper before any parsing) to:
//
//   ref/audit/BEDS24-MESSAGES-SHAPE-2026-08-05.json
//   ref/audit/BEDS24-REVIEWS-SHAPE-2026-08-05.json
//
//   1. GET /bookings/messages?propertyId=342449&maxAge=30   (last 30 days)
//   2. GET /channels/booking/reviews?propertyId=342449&from=2020-01-01
//
// No POST, no PUT, no schema writes. No token appears in any output.
// Run:  node --env-file=<env> scripts/probe/beds24-messages-reviews-shape-probe.cjs
//
// CommonJS by necessity, like scripts/channel-worker.cjs: it installs a
// require-time module resolver before loading the compiled worker tree, which
// an ESM entry cannot do.
/* eslint-disable @typescript-eslint/no-require-imports */
// ============================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "dist", "worker");
const STUB = path.join(ROOT, "scripts", "server-only-stub.cjs");

// same @/ + server-only mapping as scripts/channel-worker.cjs
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, path.join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const { sql } = require(path.join(OUT, "lib/db.js"));
const { beds24BaseUrl } = require(path.join(OUT, "lib/channel/config.js"));
const { getBeds24AccessToken } = require(path.join(OUT, "lib/channel/beds24-token.js"));
const { beds24Request } = require(path.join(OUT, "lib/channel/beds24-http.js"));

const PROPERTY_ID = "342449";
const AUDIT_DIR = path.join(ROOT, "ref", "audit");

// Tee fetch: capture the exact response text before beds24Request parses it,
// then hand the body onward untouched. This is what makes the dump VERBATIM
// (beds24Request's own `raw` evidence is deliberately truncated at 2KB).
function teeFetch(captured) {
  return async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    const headers = {};
    for (const name of ["x-five-min-limit-remaining", "x-five-min-limit-resets-in", "x-request-cost", "retry-after", "content-type"]) {
      const v = res.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    captured.push({ url: String(url).replace(/^https?:\/\/[^/]+/, ""), status: res.status, headers, text });
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

async function main() {
  const [conn] = await sql`
    SELECT id, api_key_ciphertext, access_token_ciphertext, access_token_expires_at
    FROM guesthub.channel_connections
    WHERE provider = 'beds24' AND is_active_provider = true
    ORDER BY created_at LIMIT 1`;
  if (!conn) throw new Error("no active beds24 connection found");
  console.log(`connection: ${conn.id}`);

  const access = await getBeds24AccessToken(sql, conn);
  if (!access.ok) throw new Error(`token: ${access.category} — ${access.error}`);

  const captured = [];
  const base = { token: access.token, baseUrl: beds24BaseUrl(), fetchImpl: teeFetch(captured) };

  const calls = [
    {
      label: "messages",
      path: `/bookings/messages?propertyId=${PROPERTY_ID}&maxAge=30`,
      out: "BEDS24-MESSAGES-SHAPE-2026-08-05.json",
    },
    {
      label: "reviews",
      path: `/channels/booking/reviews?propertyId=${PROPERTY_ID}&from=2020-01-01`,
      out: "BEDS24-REVIEWS-SHAPE-2026-08-05.json",
    },
  ];

  let failed = false;
  for (const call of calls) {
    const res = await beds24Request({ ...base, method: "GET", path: call.path });
    const cap = captured[captured.length - 1];
    const dump = {
      probe: {
        date_utc: new Date().toISOString(),
        request: `GET ${call.path}`,
        http_status: cap?.status ?? null,
        credit_headers: cap?.headers ?? null,
      },
      // the response body, byte-for-byte as received (JSON re-embedded when
      // it parses, so the file stays readable; raw_text always carries the
      // verbatim string)
      raw_text: cap?.text ?? null,
      body: (() => { try { return JSON.parse(cap?.text ?? ""); } catch { return null; } })(),
    };
    fs.writeFileSync(path.join(AUDIT_DIR, call.out), JSON.stringify(dump, null, 2) + "\n");
    const ok = !("ok" in res) && res.status === 200;
    console.log(`${call.label}: HTTP ${cap?.status} → ${call.out}` +
      ` (cost=${cap?.headers?.["x-request-cost"] ?? "?"}, remaining=${cap?.headers?.["x-five-min-limit-remaining"] ?? "?"})`);
    if (!ok) {
      console.error(`${call.label}: FAILED — ${"ok" in res ? `${res.category}: ${res.message}` : `HTTP ${res.status}`}`);
      failed = true;
    }
  }
  await sql.end({ timeout: 5 });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`probe failed: ${e && e.message}`);
  process.exit(1);
});
