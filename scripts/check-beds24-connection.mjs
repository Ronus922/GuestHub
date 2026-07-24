// Beds24 integration guard #1 — connection state (read-only).
// Beds24 is the SOLE live provider (D91). This asserts the live wiring that the
// inbound pull + outbound ARI drain both depend on: exactly one active
// production Beds24 connection, both directions enabled, a refresh token
// present, the circuit breaker closed — and no other provider active.
// Usage: node --env-file=.env.local scripts/check-beds24-connection.mjs
import postgres from "postgres";
import assert from "node:assert/strict";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

try {
  const conns = await sql`
    SELECT provider, environment, state, inbound_sync_enabled, outbound_sync_enabled,
           (api_key_ciphertext IS NOT NULL) AS has_refresh_token,
           (access_token_ciphertext IS NOT NULL) AS has_cached_access,
           access_token_expires_at, circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections WHERE state = 'active'`;

  assert.equal(conns.length, 1, `exactly one ACTIVE connection expected, got ${conns.length}`);
  const c = conns[0];
  assert.equal(c.provider, "beds24", `active provider must be beds24, got ${c.provider}`);
  ok("exactly one active connection, provider=beds24 (D91)");

  assert.equal(c.environment, "production", "active connection must be environment=production");
  ok("environment=production");

  assert.equal(c.inbound_sync_enabled, true, "inbound sync (booking pull) is disabled");
  assert.equal(c.outbound_sync_enabled, true, "outbound sync (ARI push) is disabled");
  ok("inbound + outbound sync enabled");

  assert.equal(c.has_refresh_token, true, "no refresh token configured (api_key_ciphertext IS NULL)");
  ok("refresh token present");

  const openUntil = c.circuit_open_until ? new Date(c.circuit_open_until).getTime() : null;
  assert.ok(openUntil === null || openUntil <= Date.now(),
    `circuit breaker is OPEN until ${c.circuit_open_until} (consecutive_failures=${c.consecutive_failures})`);
  ok(`circuit breaker closed (consecutive_failures=${c.consecutive_failures})`);

  // informational only — the resolver mints on demand, an expired cache is not a failure
  const exp = c.access_token_expires_at ? new Date(c.access_token_expires_at) : null;
  console.log(`  · access-token cache: ${c.has_cached_access ? `present, expires ${exp?.toISOString()}` : "none (will mint on next call)"}`);

  console.log(`\nBEDS24 CONNECTION CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`BEDS24 CONNECTION CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
