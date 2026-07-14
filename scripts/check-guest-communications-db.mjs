import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL
  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (url.includes(marker)) throw new Error(`refusing production-like database marker: ${marker}`);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
let checks = 0;
const ok = (name) => { process.stdout.write(`  ✓ ${name}\n`); checks += 1; };
const expectDbError = async (tx, statement, predicate) => {
  let thrown;
  try { await tx.savepoint(statement); } catch (error) { thrown = error; }
  assert.equal(predicate(thrown), true, `expected DB error, received ${thrown?.code ?? thrown?.message ?? "none"}`);
};
const counts = async () => (await sql`
  SELECT
    (SELECT count(*)::int FROM guesthub.communication_events) AS events,
    (SELECT count(*)::int FROM guesthub.outbound_messages) AS deliveries,
    (SELECT count(*)::int FROM guesthub.message_template_versions) AS versions,
    (SELECT count(*)::int FROM guesthub.communication_automations) AS automations`)[0];

// Reapply twice so the assertion does not depend on whether the local test DB
// was already current when this test started. Neither pass may emit work.
execSync(
  'docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < db/migrations/036_guest_communications.sql',
  { stdio: "inherit", shell: "/bin/bash" },
);
const afterFirst = await counts();
execSync(
  'docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < db/migrations/036_guest_communications.sql',
  { stdio: "inherit", shell: "/bin/bash" },
);
const afterSecond = await counts();
assert.deepEqual(afterSecond, afterFirst);
ok("migration reapplies idempotently without events, deliveries, versions, or automations backfill duplication");

const permissionKeys = (await sql`
  SELECT key FROM guesthub.permissions WHERE key LIKE 'communications.%' ORDER BY key`).map((row) => row.key);
for (const key of [
  "communications.templates.view",
  "communications.deliveries.view",
  "communications.templates.edit",
  "communications.templates.publish",
  "communications.automations.manage",
  "communications.automations.activate",
  "communications.channels.manage",
  "communications.credentials.replace",
  "communications.test.send",
  "communications.messages.resend",
]) assert.equal(permissionKeys.includes(key), true, `missing permission ${key}`);
ok("migration installs every granular view, edit, publish, activation, channel, test, and resend permission");

const invalidActivation = await sql`
  SELECT count(*)::int AS count
  FROM guesthub.communication_automations a
  JOIN guesthub.message_templates t ON t.id = a.template_id AND t.tenant_id = a.tenant_id
  WHERE a.name = 'אישור הזמנה לאורח' AND a.status = 'active'
    AND (
      t.current_published_version_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM guesthub.messaging_provider_connections c
        WHERE c.tenant_id = a.tenant_id AND c.provider IN ('gmail','gmail_smtp')
          AND c.status = 'connected' AND c.last_tested_at IS NOT NULL
          AND c.secret_ciphertext IS NOT NULL
      )
    )`;
assert.equal(invalidActivation[0].count, 0);
ok("default confirmation automation is active only with a published version and tested provider");

// The stronger invariant: applying the migration must never, on ANY tenant, put
// a guest-emailing automation into a sending state. Enabling it is a human act.
// (A connected Gmail channel used to make the seed 'active' — that would have
// emailed the next confirmed booking the moment this shipped.)
const bornSending = await sql`
  SELECT count(*)::int AS count FROM guesthub.communication_automations
  WHERE status = 'active'`;
assert.equal(bornSending[0].count, 0, "the migration must not activate any automation");
const seeded = await sql`
  SELECT DISTINCT status FROM guesthub.communication_automations
  WHERE name = 'אישור הזמנה לאורח'`;
assert.deepEqual(seeded.map((row) => row.status), ["draft"], "the seeded automation is born a draft");
ok("migration never starts sending: every seeded automation is born a draft, activation stays a human act");

class Rollback extends Error {}
const slug = `communications-test-${Date.now()}`;
try {
  await sql.begin(async (tx) => {
    const [tenantA] = await tx`
      INSERT INTO guesthub.tenants (name, slug) VALUES ('Communications A', ${`${slug}-a`}) RETURNING id`;
    const [tenantB] = await tx`
      INSERT INTO guesthub.tenants (name, slug) VALUES ('Communications B', ${`${slug}-b`}) RETURNING id`;
    const [guest] = await tx`
      INSERT INTO guesthub.guests (tenant_id, first_name, full_name, email)
      VALUES (${tenantA.id}, 'נועה', 'נועה בדיקה', 'noa@example.test') RETURNING id`;
    const [reservation] = await tx`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out,
         booking_origin, is_test, guest_communication_opt_out)
      VALUES (${tenantA.id}, 'GC-1', ${guest.id}, 'confirmed', '2026-08-01', '2026-08-03',
              'back_office', false, false)
      RETURNING id`;
    const [directReservation] = await tx`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, booking_origin)
      VALUES (${tenantA.id}, 'GC-DIRECT', ${guest.id}, 'confirmed', '2026-08-04', '2026-08-05', 'direct_website')
      RETURNING id, booking_origin`;
    assert.equal(directReservation.booking_origin, "direct_website");
    await expectDbError(tx, (sp) =>
      sp`INSERT INTO guesthub.reservations
         (tenant_id, reservation_number, status, check_in, check_out, booking_origin)
         VALUES (${tenantA.id}, 'GC-BAD', 'confirmed', '2026-08-04', '2026-08-05', 'booking_com')`,
      (error) => error?.code === "23514",
    );
    ok("reservation provenance accepts the future direct website seam and rejects ad-hoc OTA labels");

    const content = {
      schemaVersion: 1,
      blocks: [{ id: "greeting", type: "text", enabled: true, condition: "always", data: { text: "שלום {{guest.first_name}}" } }],
    };
    const [template] = await tx`
      INSERT INTO guesthub.message_templates
        (tenant_id, channel, slug, name, subject, body, lifecycle_state, draft_content)
      VALUES (${tenantA.id}, 'email', 'test-confirmation', 'אישור בדיקה', 'אישור {{reservation.number}}',
              'legacy body', 'published', ${tx.json(content)}::jsonb)
      RETURNING id`;
    const [version] = await tx`
      INSERT INTO guesthub.message_template_versions
        (tenant_id, template_id, version_number, subject, preheader, content)
      VALUES (${tenantA.id}, ${template.id}, 1, 'אישור {{reservation.number}}', 'ההזמנה אושרה', ${tx.json(content)}::jsonb)
      RETURNING id`;
    await tx`UPDATE guesthub.message_templates SET current_published_version_id = ${version.id} WHERE id = ${template.id}`;
    await expectDbError(tx, (sp) =>
      sp`UPDATE guesthub.message_template_versions SET subject = 'mutated' WHERE id = ${version.id}`,
      (error) => error?.message?.includes("immutable"),
    );
    await expectDbError(tx, (sp) =>
      sp`DELETE FROM guesthub.message_template_versions WHERE id = ${version.id}`,
      (error) => error?.message?.includes("immutable"),
    );
    ok("published template versions reject update and delete mutations");

    await expectDbError(tx, (sp) =>
      sp`INSERT INTO guesthub.message_template_versions
        (tenant_id, template_id, version_number, subject, content)
        VALUES (${tenantB.id}, ${template.id}, 2, 'cross tenant', ${sp.json(content)}::jsonb)`,
      (error) => error?.code === "23503",
    );
    ok("composite tenant foreign keys reject cross-tenant template versions");

    const [automation] = await tx`
      INSERT INTO guesthub.communication_automations
        (tenant_id, name, status, trigger_type, timing_config, source_filters, conditions,
         exclusion_rules, recipient_config, channel, template_id)
      VALUES (${tenantA.id}, 'Test confirmation', 'active', 'reservation.confirmed',
              '{"mode":"immediate","quietHours":"bypass"}'::jsonb,
              '{"include":["back_office","direct_website"]}'::jsonb,
              '{"logic":"all","items":[]}'::jsonb,
              '{"guestCommunicationOptOut":true,"ota":true}'::jsonb,
              '{"type":"primary_guest"}'::jsonb, 'email', ${template.id})
      RETURNING id, timing_config, source_filters`;
    assert.deepEqual(automation.timing_config, { mode: "immediate", quietHours: "bypass" });
    assert.deepEqual(automation.source_filters.include, ["back_office", "direct_website"]);
    ok("confirmation automation persists immediate quiet-hours bypass and only allowed first-party sources");

    const occurrence = `reservation:${reservation.id}:confirmed:v1`;
    const firstEvent = await tx`
      INSERT INTO guesthub.communication_events
        (tenant_id, event_type, reservation_id, source, occurrence_key)
      VALUES (${tenantA.id}, 'reservation.confirmed', ${reservation.id}, 'back_office', ${occurrence})
      ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING RETURNING id`;
    const duplicateEvent = await tx`
      INSERT INTO guesthub.communication_events
        (tenant_id, event_type, reservation_id, source, occurrence_key)
      VALUES (${tenantA.id}, 'reservation.confirmed', ${reservation.id}, 'back_office', ${occurrence})
      ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING RETURNING id`;
    assert.equal(firstEvent.length, 1);
    assert.equal(duplicateEvent.length, 0);
    await expectDbError(tx, (sp) =>
      sp`INSERT INTO guesthub.communication_events
        (tenant_id, event_type, reservation_id, source, occurrence_key)
        VALUES (${tenantB.id}, 'reservation.confirmed', ${reservation.id}, 'back_office', 'cross-tenant')`,
      (error) => error?.code === "23503",
    );
    ok("event outbox deduplicates occurrence keys and rejects cross-tenant reservations");

    const htmlSnapshot = "<!doctype html><p>snapshot v1</p>";
    const textSnapshot = "snapshot v1";
    const [delivery] = await tx`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, reservation_id, guest_id, channel, provider, template_id, automation_id,
         template_version_id, event_id, idempotency_key, to_address, subject, body, status,
         rendered_html, rendered_plain_text, delivery_type, max_attempts)
      VALUES (${tenantA.id}, ${reservation.id}, ${guest.id}, 'email', 'gmail', ${template.id}, ${automation.id},
              ${version.id}, ${firstEvent[0].id}, 'automation:test:event:1', 'noa@example.test', 'אישור GC-1',
              ${textSnapshot}, 'queued', ${htmlSnapshot}, ${textSnapshot}, 'normal', 3)
      RETURNING id`;
    const duplicateDelivery = await tx`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, reservation_id, guest_id, channel, provider, template_id, automation_id,
         template_version_id, event_id, idempotency_key, to_address, subject, body, status,
         rendered_html, rendered_plain_text, delivery_type)
      VALUES (${tenantA.id}, ${reservation.id}, ${guest.id}, 'email', 'gmail', ${template.id}, ${automation.id},
              ${version.id}, ${firstEvent[0].id}, 'automation:test:event:1', 'noa@example.test', 'duplicate',
              'duplicate', 'queued', 'duplicate', 'duplicate', 'normal')
      ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`;
    assert.equal(duplicateDelivery.length, 0);
    ok("canonical delivery row is created once per event and automation idempotency key");

    await tx`UPDATE guesthub.message_templates
      SET subject = 'new draft subject', draft_content = ${tx.json({ ...content, blocks: [] })}::jsonb,
          lifecycle_state = 'archived', archived_at = now()
      WHERE id = ${template.id}`;
    const [snapshotAfterArchive] = await tx`
      SELECT rendered_html, rendered_plain_text, subject, template_version_id
      FROM guesthub.outbound_messages WHERE id = ${delivery.id}`;
    assert.deepEqual(snapshotAfterArchive, {
      rendered_html: htmlSnapshot,
      rendered_plain_text: textSnapshot,
      subject: "אישור GC-1",
      template_version_id: version.id,
    });
    ok("archive and later draft edits cannot alter a past delivery snapshot");

    await tx`UPDATE guesthub.outbound_messages
      SET status = 'submitting', attempt_count = 1, lease_owner = 'worker-a', lease_expires_at = now() + interval '5 minutes'
      WHERE id = ${delivery.id}`;
    await tx`INSERT INTO guesthub.communication_delivery_attempts
      (tenant_id, delivery_id, attempt_number, result)
      VALUES (${tenantA.id}, ${delivery.id}, 1, 'retry_scheduled')`;
    await tx`UPDATE guesthub.outbound_messages
      SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ${delivery.id}`;
    await tx`UPDATE guesthub.outbound_messages
      SET status = 'submitting', attempt_count = 2, lease_owner = 'worker-a', lease_expires_at = now() + interval '5 minutes'
      WHERE id = ${delivery.id}`;
    await tx`INSERT INTO guesthub.communication_delivery_attempts
      (tenant_id, delivery_id, attempt_number, result, error_category)
      VALUES (${tenantA.id}, ${delivery.id}, 2, 'failed_permanent', 'provider_authentication')`;
    await tx`UPDATE guesthub.outbound_messages
      SET status = 'failed', final_error_category = 'provider_authentication',
          lease_owner = NULL, lease_expires_at = NULL WHERE id = ${delivery.id}`;
    const [retried] = await tx`
      SELECT id, status, attempt_count, final_error_category,
             (SELECT count(*)::int FROM guesthub.communication_delivery_attempts a WHERE a.delivery_id = d.id) AS attempts
      FROM guesthub.outbound_messages d WHERE id = ${delivery.id}`;
    assert.deepEqual(retried, {
      id: delivery.id,
      status: "failed",
      attempt_count: 2,
      final_error_category: "provider_authentication",
      attempts: 2,
    });
    ok("transient retry and permanent failure preserve one delivery row with an append-only attempt timeline");

    const [testDelivery] = await tx`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, channel, provider, to_address, subject, body, status,
         rendered_html, rendered_plain_text, delivery_type, idempotency_key)
      VALUES (${tenantA.id}, 'email', 'gmail', 'operator@example.test', 'בדיקה', 'בדיקה', 'queued',
              '<p>בדיקה</p>', 'בדיקה', 'test', 'test-delivery:1')
      RETURNING id, delivery_type, reservation_id, automation_id`;
    assert.deepEqual(testDelivery, { id: testDelivery.id, delivery_type: "test", reservation_id: null, automation_id: null });
    await expectDbError(tx, (sp) =>
      sp`INSERT INTO guesthub.outbound_messages
        (tenant_id, channel, provider, to_address, body, status, delivery_type, resend_reason)
        VALUES (${tenantA.id}, 'email', 'gmail', 'operator@example.test', 'bad resend', 'queued', 'manual_resend', 'reason')`,
      (error) => error?.code === "23514",
    );
    ok("test deliveries are explicitly classified and manual resend requires a linked original");

    throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) {
    await sql.end();
    throw error;
  }
}

const residue = await sql`
  SELECT count(*)::int AS count FROM guesthub.tenants WHERE slug LIKE ${`${slug}%`}`;
assert.equal(residue[0].count, 0);
ok("all executable DB fixtures roll back without residue");

await sql.end();
process.stdout.write(`\n✓ Guest Communications DB checks passed (${checks} groups)\n`);
