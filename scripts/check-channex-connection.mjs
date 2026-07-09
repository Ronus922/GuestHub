// Runnable checks for the Channex Staging connection logic (D59), same pattern
// as check-calendar.mjs: compile the pure modules with tsc, import them, assert.
// Covers the connection-test mapping/fetch handling, no-key-leak, secret masking
// + encryption roundtrip, and the super_admin-only guard.
// Usage: node scripts/check-channex-connection.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

process.env.CHANNEL_SECRETS_KEY ??= "check-only-test-key-do-not-use-in-prod";

const out = mkdtempSync(join(tmpdir(), "channex-"));
// crypto.ts does `import "server-only"` — resolves to an empty module server-side.
// Under plain node require() from /tmp it isn't found, so stub it locally.
mkdirSync(join(out, "node_modules/server-only"), { recursive: true });
writeFileSync(join(out, "node_modules/server-only/index.js"), "module.exports = {};");
writeFileSync(join(out, "node_modules/server-only/package.json"), '{"name":"server-only","main":"index.js"}');
execSync(
  `pnpm exec tsc src/lib/channel/connection-test.ts src/lib/channel/crypto.ts src/lib/auth/guards.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const ct = require(join(out, "channel/connection-test.js"));
const crypto = require(join(out, "channel/crypto.js"));
const guards = require(join(out, "auth/guards.js"));

const STAGING = "https://staging.channex.io/api/v1";
const PROD = "https://app.channex.io/api/v1";

// ---- pure response mapping ----
assert.deepEqual(ct.interpretChannexResponse(200, { data: [] }), { ok: true, propertyCount: 0 }, "200 empty = connected, 0 properties");
assert.deepEqual(ct.interpretChannexResponse(200, { data: [{ id: "a" }, { id: "b" }] }), { ok: true, propertyCount: 2 }, "200 with properties");
assert.equal(ct.interpretChannexResponse(200, { nope: true }).category, "bad_response", "200 without data array = bad_response");
assert.equal(ct.interpretChannexResponse(200, null).category, "bad_response", "200 null body = bad_response");
assert.equal(ct.interpretChannexResponse(401, {}).category, "unauthorized");
assert.equal(ct.interpretChannexResponse(403, {}).category, "forbidden");
assert.equal(ct.interpretChannexResponse(404, {}).category, "not_found");
assert.equal(ct.interpretChannexResponse(429, {}).category, "rate_limited");
assert.equal(ct.interpretChannexResponse(500, {}).category, "server_error");
assert.equal(ct.interpretChannexResponse(503, {}).category, "server_error");
assert.equal(ct.interpretChannexResponse(418, {}).category, "bad_response", "unexpected status = bad_response");

// ---- fetch wrapper with an injected fetchImpl (no live socket) ----
const mkRes = (status, body) => ({ status, json: async () => body });
const captured = {};
const fetchOk = async (url, init) => {
  captured.url = url;
  captured.headers = init.headers;
  return mkRes(200, { data: [{ id: "p1" }] });
};

let r = await ct.runChannexConnectionTest({ apiKey: "SECRET-KEY-123", baseUrl: STAGING, fetchImpl: fetchOk });
assert.deepEqual(r, { ok: true, propertyCount: 1 }, "200 with 1 property");
assert.equal(captured.url, `${STAGING}/properties/options`, "hits the correct staging endpoint");
assert.equal(captured.headers["user-api-key"], "SECRET-KEY-123", "sends the user-api-key header");
assert.equal(captured.headers["Accept"], "application/json");

// environment isolation: the same helper against production builds a different URL
await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: PROD, fetchImpl: fetchOk });
assert.equal(captured.url, `${PROD}/properties/options`, "production baseUrl → production URL (no staging/prod mixing)");
assert.notEqual(STAGING, PROD, "staging and production base URLs are distinct");

r = await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => mkRes(200, { data: [] }) });
assert.deepEqual(r, { ok: true, propertyCount: 0 }, "empty property list is still a successful connection");

r = await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => mkRes(401, { errors: {} }) });
assert.equal(r.ok, false);
assert.equal(r.category, "unauthorized", "invalid key → 401 → unauthorized");

// network error (fetch throws a generic error)
r = await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
assert.equal(r.category, "network_error", "network failure mapped");

// timeout (AbortError)
r = await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
assert.equal(r.category, "timeout", "abort mapped to timeout");

// malformed upstream body on 200 (json() throws)
r = await ct.runChannexConnectionTest({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => ({ status: 200, json: async () => { throw new Error("not json"); } }) });
assert.equal(r.category, "bad_response", "malformed 200 body → bad_response, no crash");

// ---- the api-key NEVER appears in any returned result ----
const LEAK = "kx_live_SUPERSECRET_9f8a7b6c";
for (const impl of [
  async () => mkRes(401, { message: "invalid key", key: LEAK }),
  async () => { const e = new Error(LEAK); throw e; },
  async () => mkRes(500, { debug: LEAK }),
]) {
  const res = await ct.runChannexConnectionTest({ apiKey: LEAK, baseUrl: STAGING, fetchImpl: impl });
  assert.ok(!JSON.stringify(res).includes(LEAK), "api-key / upstream body never leaks into the returned result");
}

// ---- secret masking + encryption roundtrip ----
assert.equal(crypto.secretHint("abcd1234WXYZ"), "••••WXYZ", "hint shows only the last 4");
assert.ok(!crypto.secretHint("abcd1234WXYZ").includes("abcd"), "hint hides the head of the key");
const cipher = crypto.encryptSecret("my-channex-key");
assert.ok(!cipher.includes("my-channex-key"), "ciphertext is not plaintext");
assert.equal(crypto.decryptSecret(cipher), "my-channex-key", "decrypt roundtrips");
assert.notEqual(crypto.encryptSecret("my-channex-key"), cipher, "random IV → distinct ciphertext each time");
assert.equal(crypto.channelSecretsConfigured(), true, "key configured in this run");

// ---- permission: super_admin ONLY ----
assert.equal(guards.canManageChannels({ userId: "u", roleKey: "super_admin" }).ok, true, "super_admin allowed");
assert.equal(guards.canManageChannels({ userId: "u", roleKey: "admin" }).ok, false, "admin denied (integration secrets outrank full access)");
assert.equal(guards.canManageChannels({ userId: "u", roleKey: "staff" }).ok, false, "staff denied");

console.log("check-channex-connection: all assertions passed ✓");
