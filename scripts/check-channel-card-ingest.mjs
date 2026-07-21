// Channel-card ingestion INTEGRATION test (D43/D52). Compiles the real server
// modules (card-vault, card-rules, channel/payloads, channel/revisions,
// channel/card-ingest), then exercises them against the ISOLATED test DB inside
// a transaction that is ALWAYS ROLLED BACK. Proves the operational seam:
//   raw payload → extract → encrypt PAN → stage on revision (payload redacted)
//                → attach to reservation_cards on import
// and that no plaintext PAN is ever stored or logged, and that the CVV is NEVER
// stored anywhere (D52 §2) — no cvv column exists, and a CVV in the raw payload
// is scrubbed by the redaction guard.
//
// D68: this script used to inherit DATABASE_URL from .env.local and therefore ran
// against PRODUCTION (:5432). Rolled back or not, a check must never open a
// transaction on the live database — and once a real Channex connection existed
// there, its fixture INSERT collided with it and the check failed outright. It
// now targets guesthub-testdb (:5433) and fails closed on a production marker,
// exactly like its sibling checks.
//
// Usage: node scripts/check-channel-card-ingest.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import postgres from "postgres";

const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

const out = mkdtempSync(join(tmpdir(), "chan-card-"));
execSync(
  `pnpm exec tsc src/lib/card-vault.ts src/lib/card-rules.ts src/lib/channel/payloads.ts ` +
    `src/lib/channel/revisions.ts src/lib/channel/card-ingest.ts ` +
    `--outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
// stub the "server-only" marker package for node
mkdirSync(join(out, "node_modules", "server-only"), { recursive: true });
writeFileSync(join(out, "node_modules", "server-only", "package.json"), '{"name":"server-only","main":"index.js"}');
writeFileSync(join(out, "node_modules", "server-only", "index.js"), "");

const require = createRequire(import.meta.url);
const vault = require(join(out, "card-vault.js"));
const payloads = require(join(out, "channel", "payloads.js"));
const revisions = require(join(out, "channel", "revisions.js"));
const ingest = require(join(out, "channel", "card-ingest.js"));

process.env.CARD_VAULT_KEY = "check-channel-card-ingest-test-key";

const TEST_PAN = "4111111111111111"; // industry test Visa
const TEST_CVV = "737";
const rawPayload = {
  booking_id: "OTA-TEST-1",
  guest: { name: "Channel Guest" },
  credit_card: {
    cardholder_name: "CHANNEL GUEST",
    card_number: "4111 1111 1111 1111",
    expiration_date: "08/2029",
    cvv: TEST_CVV,
    is_virtual: true,
    card_type: "Visa",
    available_until: "2026-09-01",
  },
};

const ROLLBACK = Symbol("rollback");
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

try {
  await sql.begin(async (tx) => {
    const [{ id: tenantId }] = await tx`SELECT id FROM guesthub.tenants LIMIT 1`;
    const [{ id: connectionId }] = await tx`
      INSERT INTO guesthub.channel_connections (tenant_id) VALUES (${tenantId}) RETURNING id`;
    const mkReservation = async (num) => {
      const [r] = await tx`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out)
        VALUES (${tenantId}, ${num}, '2026-08-10', '2026-08-12') RETURNING id`;
      return r.id;
    };
    const resA = await mkReservation("ZZ-CARD-INGEST-A");
    const resB = await mkReservation("ZZ-CARD-INGEST-B");

    // ---- 1. persist a revision: card is encrypted-staged, payload redacted ----
    const rev = await revisions.persistBookingRevision(tx, {
      tenantId,
      connectionId,
      providerBookingId: "OTA-TEST-1",
      providerRevisionId: "REV-1",
      otaName: "Booking.com",
      otaReservationCode: "OTA-CODE-9",
      revisionKind: "new",
      payload: rawPayload,
    });
    assert.equal(rev.duplicate, false, "revision persisted");

    // D87 restored a CVV column on the MANUAL card only. The CHANNEL path stays
    // CVV-free: the revision table has no CVV column, and the only cvv column in
    // the schema is reservation_cards.cvv_encrypted (the manual-entry card).
    const cvvCols = await tx`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='guesthub' AND column_name ILIKE '%cvv%'
      ORDER BY table_name, column_name`;
    assert.deepEqual(
      cvvCols.map((c) => `${c.table_name}.${c.column_name}`),
      ["reservation_cards.cvv_encrypted"],
      "the ONLY cvv column is the manual card's; the channel/revision path has none",
    );

    const [stored] = await tx`
      SELECT card_pan_encrypted, card_meta, payload::text AS payload_text
      FROM guesthub.channel_booking_revisions WHERE id = ${rev.id}`;
    assert.ok(stored.card_pan_encrypted?.startsWith("v1."), "PAN staged as ciphertext");
    assert.equal(vault.decryptPan(stored.card_pan_encrypted), TEST_PAN, "staged PAN round-trips");
    assert.ok(!stored.payload_text.includes(TEST_PAN), "redacted payload contains no PAN");
    assert.ok(!stored.payload_text.includes(TEST_CVV), "redacted payload contains no CVV (scrubbed)");
    assert.ok(/\[redacted\]/.test(stored.payload_text), "card fields redacted in the stored payload");

    // ---- import: staged PAN (no CVV) is attached to the local reservation ----
    await revisions.markRevisionImported(tx, tenantId, rev.id, resA);
    const [card] = await tx`
      SELECT pan_encrypted, cvv_encrypted, last4, brand, source, source_channel, is_virtual,
             provider_reservation_ref, available_until::text AS available_until
      FROM guesthub.reservation_cards WHERE reservation_id = ${resA}`;
    assert.ok(card, "channel card attached to the reservation");
    assert.equal(card.source, "channel", "source is channel");
    assert.equal(card.source_channel, "Booking.com", "source channel retained");
    assert.equal(card.provider_reservation_ref, "OTA-CODE-9", "OTA reservation code retained");
    assert.equal(card.is_virtual, true, "virtual card flagged");
    assert.equal(card.last4, "1111", "last four stored");
    assert.equal(vault.decryptPan(card.pan_encrypted), TEST_PAN, "attached PAN round-trips");
    // the channel ingest NEVER populates the CVV column (D87 restored it for the
    // manual card only) — an OTA-attached card is always cvv_encrypted IS NULL
    assert.equal(card.cvv_encrypted, null, "the channel-attached card carries no CVV");

    // ---- direct ingest path (raw card + reservation in one shot) ----
    const extracted = payloads.extractChannelCard(rawPayload);
    assert.equal(extracted.cvv, undefined, "extraction never carries a CVV");
    const r1 = await ingest.ingestChannelCard(tx, {
      tenantId, reservationId: resB, otaName: "Expedia", card: extracted,
    });
    assert.equal(r1.stored, true, "direct ingest stored the card");
    const [c2] = await tx`SELECT pan_encrypted, last4 FROM guesthub.reservation_cards WHERE reservation_id = ${resB}`;
    assert.equal(vault.decryptPan(c2.pan_encrypted), TEST_PAN, "direct-ingest PAN round-trips");

    // ---- the ingest audit rows carry no plaintext PAN, no CVV, no cvv flag ----
    const auditRows = await tx`
      SELECT after_data::text AS d FROM guesthub.audit_logs
      WHERE tenant_id = ${tenantId} AND action = 'card_import_channel'`;
    for (const a of auditRows) {
      assert.ok(!a.d.includes(TEST_PAN), "audit never contains the PAN");
      assert.ok(!a.d.includes(TEST_CVV), "audit never contains the CVV");
      assert.ok(!/cvv/i.test(a.d), "audit payload has no cvv field at all");
    }

    throw ROLLBACK; // never persist the fixtures
  });
} catch (e) {
  if (e !== ROLLBACK) {
    await sql.end();
    throw e;
  }
}

// confirm the transaction rolled back — no temp rows leaked
const leaked = await sql`
  SELECT count(*)::int AS n FROM guesthub.reservations WHERE reservation_number LIKE 'ZZ-CARD-INGEST-%'`;
assert.equal(leaked[0].n, 0, "temp records were rolled back (no cleanup needed)");

await sql.end();
console.log("check-channel-card-ingest: encrypted channel ingestion verified, no plaintext, rolled back ✔");
